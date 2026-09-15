/**
 * LambderApiRefusal: typed refusals mapped onto the API envelope.
 *
 * - Thrown anywhere in an API call's stack (handler, hooks, nested helpers
 *   with no resolver access), it becomes res.api(null, { errorMessage,
 *   notAuthorized, sessionExpired }) and never reaches the global error handler.
 * - Thrown outside an API call it stays a normal error.
 * - Detection is brand-based (isLambderApiRefusal) so refusals survive duplicate
 *   lambder installs.
 * - The last-resort 500 for API calls is a JSON envelope, not plain text.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import Lambder from '../src/core/Lambder.js';
import { LambderApiRefusal, isLambderApiRefusal, refuse, LAMBDER_REFUSAL_CODES } from '../src/shared/wire/LambderApiRefusal.js';
import type { LambderAppRefusalMessage, LambderRefusalMessage } from '../src/shared/wire/LambderApiRefusal.js';
import { decodeBody, createApiEvent as createEnvelopeEvent, createMockContext, testPublicFiles } from './helpers.js';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const createApiEvent = (apiName: string, payload?: any): APIGatewayProxyEvent =>
    createEnvelopeEvent({ apiName, payload });

const createRouteEvent = (path: string): APIGatewayProxyEvent => ({
    ...createApiEvent('unused'),
    body: null,
    httpMethod: 'GET',
    path,
});

const testSchema = {
    input: z.object({ value: z.string() }),
    output: z.object({ result: z.string() }),
};

describe('LambderApiRefusal - envelope mapping on API calls', () => {
    it('maps a thrown refusal to the structured envelope and skips the global error handler', async () => {
        let globalHandlerCalled = false;
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .setGlobalErrorHandler((err, ctx, res) => {
                globalHandlerCalled = true;
                return res.raw({ statusCode: 500, body: 'crash' });
            })
            .addApi('refuse', testSchema, async () => {
                throw new LambderApiRefusal('You are not a member of an organization.');
            });

        const result = await lambder.render(createApiEvent('refuse', { value: 'x' }), createMockContext());

        expect(globalHandlerCalled).toBe(false);
        expect(result.statusCode).toBe(200);
        const body = JSON.parse(decodeBody(result));
        expect(body.payload).toBe(null);
        expect(body.errorMessage).toBe('You are not a member of an organization.');
    });

    it('works from nested helpers that have no resolver access', async () => {
        const requireAdmin = (role: string) => {
            if(role !== 'admin') throw new LambderApiRefusal('Permission denied.', { notAuthorized: true });
        };
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addApi('guarded', testSchema, async (ctx, res) => {
                requireAdmin('member');
                return res.api({ result: 'never' });
            });

        const result = await lambder.render(createApiEvent('guarded', { value: 'x' }), createMockContext());

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(decodeBody(result));
        expect(body.notAuthorized).toBe(true);
        expect(body.errorMessage).toBe('Permission denied.');
    });

    it('carries structured errorMessage objects verbatim', async () => {
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addApi('refuse', testSchema, async () => {
                throw new LambderApiRefusal('Quota exceeded', {
                    errorMessage: { type: 'warning', content: 'Daily quota exceeded.' },
                });
            });

        const result = await lambder.render(createApiEvent('refuse', { value: 'x' }), createMockContext());
        const body = JSON.parse(decodeBody(result));
        expect(body.errorMessage).toEqual({ type: 'warning', content: 'Daily quota exceeded.' });
    });

    it('sets the sessionExpired flag when requested', async () => {
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addApi('refuse', testSchema, async () => {
                throw new LambderApiRefusal('Session gone', { sessionExpired: true });
            });

        const result = await lambder.render(createApiEvent('refuse', { value: 'x' }), createMockContext());
        const body = JSON.parse(decodeBody(result));
        expect(body.sessionExpired).toBe(true);
    });

    it('honors a statusCode override', async () => {
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addApi('refuse', testSchema, async () => {
                throw new LambderApiRefusal('Forbidden', { statusCode: 403 });
            });

        const result = await lambder.render(createApiEvent('refuse', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(403);
        const body = JSON.parse(decodeBody(result));
        expect(body.errorMessage).toBe('Forbidden');
    });

    it('maps refusals thrown from beforeRender hooks on API calls', async () => {
        let handlerRan = false;
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        lambder.addHook('beforeRender', (ctx) => {
            if(ctx.apiName === 'guarded') throw new LambderApiRefusal('Blocked by hook');
            return ctx;
        });
        lambder.addApi('guarded', testSchema, async (ctx, res) => {
            handlerRan = true;
            return res.api({ result: 'never' });
        });

        const result = await lambder.render(createApiEvent('guarded', { value: 'x' }), createMockContext());

        expect(handlerRan).toBe(false);
        expect(result.statusCode).toBe(200);
        expect(JSON.parse(decodeBody(result)).errorMessage).toBe('Blocked by hook');
    });

    it('maps refusals thrown from afterRender hooks on API calls', async () => {
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addApi('ok', testSchema, async (ctx, res) => res.api({ result: 'fine' }));
        lambder.addHook('afterRender', () => {
            throw new LambderApiRefusal('Rejected after render');
        });

        const result = await lambder.render(createApiEvent('ok', { value: 'x' }), createMockContext());
        expect(JSON.parse(decodeBody(result)).errorMessage).toBe('Rejected after render');
    });

    it('recognizes the brand across duplicate installs (no instanceof)', async () => {
        // Simulate an error constructed by a second copy of the package.
        const foreign = Object.assign(new Error('Foreign refusal'), {
            isLambderApiRefusal: true,
            errorMessage: 'Foreign refusal',
            notAuthorized: true,
        });
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addApi('refuse', testSchema, async () => { throw foreign; });

        const result = await lambder.render(createApiEvent('refuse', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(200);
        const body = JSON.parse(decodeBody(result));
        expect(body.notAuthorized).toBe(true);
        expect(isLambderApiRefusal(foreign)).toBe(true);
    });
});

describe('refuse() - the standard refusal shape', () => {
    it('is the shape of the framework\'s own refusals too (unknown API)', async () => {
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        const result = await lambder.render(createApiEvent('missing', {}), createMockContext());
        expect(JSON.parse(decodeBody(result)).errorMessage).toEqual({ type: 'warning', code: LAMBDER_REFUSAL_CODES.apiNotFound, content: 'API not found.' });
    });

    it('carries a machine-readable code for clients to branch and translate on', async () => {
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addApi('dup', testSchema, async () => refuse('Already reported.', { code: 'ALREADY_REPORTED' }));

        const result = await lambder.render(createApiEvent('dup', { value: 'x' }), createMockContext());
        expect(JSON.parse(decodeBody(result)).errorMessage).toEqual({ type: 'warning', code: 'ALREADY_REPORTED', content: 'Already reported.' });
    });

    it('carries extra headers onto the refusal response', async () => {
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addApi('later', testSchema, async () => refuse('Come back later.', { statusCode: 429, headers: { 'Retry-After': '30' } }));

        const result = await lambder.render(createApiEvent('later', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(429);
        expect(result.multiValueHeaders?.['Retry-After']).toEqual(['30']);
    });

    it('replaces the envelope\'s own header when a refusal names it under another casing', async () => {
        // Two Content-Type headers on one response is not a thing; the
        // refusal's is the one the app asked for.
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addApi('plain', testSchema, async () => refuse('No.', { headers: { 'content-type': 'text/plain' } }));

        const result = await lambder.render(createApiEvent('plain', { value: 'x' }), createMockContext());

        const contentTypes = Object.entries(result.multiValueHeaders ?? {})
            .filter(([key]) => key.toLowerCase() === 'content-type')
            .flatMap(([, values]) => values);
        expect(contentTypes).toEqual(['text/plain']);
    });

    it('maps to a warning envelope by default', async () => {
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addApi('nope', testSchema, async () => refuse('Record not found.'));

        const result = await lambder.render(createApiEvent('nope', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(200);
        const body = JSON.parse(decodeBody(result));
        expect(body.payload).toBe(null);
        expect(body.errorMessage).toEqual({ type: 'warning', content: 'Record not found.' });
    });

    it('carries type, title, flags and statusCode through its options', async () => {
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addApi('denied', testSchema, async () => refuse('Admins only.', {
                type: 'error', title: 'Not Allowed', notAuthorized: true, statusCode: 403,
            }));

        const result = await lambder.render(createApiEvent('denied', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(403);
        const body = JSON.parse(decodeBody(result));
        expect(body.notAuthorized).toBe(true);
        expect(body.errorMessage).toEqual({ type: 'error', title: 'Not Allowed', content: 'Admins only.' });
    });

    it('works from nested helpers and skips the global error handler', async () => {
        let globalHandlerCalled = false;
        const assertPositive = (n: number) => { if (n <= 0) refuse('Value must be positive.'); };
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .setGlobalErrorHandler((err, ctx, res) => {
                globalHandlerCalled = true;
                return res.raw({ statusCode: 500, body: 'crash' });
            })
            .addApi('guarded', testSchema, async (ctx, res) => {
                assertPositive(-1);
                return res.api({ result: 'never' });
            });

        const result = await lambder.render(createApiEvent('guarded', { value: 'x' }), createMockContext());
        expect(globalHandlerCalled).toBe(false);
        expect(JSON.parse(decodeBody(result)).errorMessage.content).toBe('Value must be positive.');
    });
});

describe('LambderApiRefusal - outside API calls', () => {
    it('falls through to the global error handler on routes', async () => {
        let seenByGlobalHandler: Error | null = null;
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .setGlobalErrorHandler((err, ctx, res) => {
                seenByGlobalHandler = err;
                return res.raw({ statusCode: 500, body: 'crash' });
            })
            .addRoute('/page', () => {
                throw new LambderApiRefusal('Not an API call');
            });

        const result = await lambder.render(createRouteEvent('/page'), createMockContext());
        expect(result.statusCode).toBe(500);
        expect(seenByGlobalHandler).toBeInstanceOf(LambderApiRefusal);
    });
});

describe('Last-resort 500 shape', () => {
    it('answers API calls with a JSON envelope when no global error handler exists', async () => {
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api', apiVersion: '1.2.3' })
            .addApi('crash', testSchema, async () => {
                throw new Error('boom');
            });

        const result = await lambder.render(createApiEvent('crash', { value: 'x' }), createMockContext());

        expect(result.statusCode).toBe(500);
        expect(result.multiValueHeaders?.['Content-Type']).toEqual(['application/json; charset=utf-8']);
        const body = JSON.parse(result.body || '{}');
        expect(body.payload).toBe(null);
        expect(body.errorMessage).toBe('Internal server error.');
        expect(body.apiVersion).toBe('1.2.3');
    });

    it('keeps the plain-text 500 for routes', async () => {
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addRoute('/crash', () => { throw new Error('boom'); });

        const result = await lambder.render(createRouteEvent('/crash'), createMockContext());
        expect(result.statusCode).toBe(500);
        expect(result.body).toBe('Internal Server Error.');
    });
});

describe('LambderRefusalMessage - branching on the code', () => {
    it('narrows in a switch and asserts exhaustiveness, which is what the codes exist for', () => {
        // `LambderRefusalCode | (string & {})` does not narrow: inside a
        // switch the case was not assignable to the scrutinee and the
        // `default: never` assertion failed, so the exhaustiveness the
        // framework's own vocabulary is designed for was unavailable to every
        // consumer that tried to use it.
        const describeRefusal = (message: LambderRefusalMessage): string => {
            switch(message.code){
                case LAMBDER_REFUSAL_CODES.rateLimited: return 'slow down';
                case LAMBDER_REFUSAL_CODES.duplicateInFlight: return 'already running';
                case LAMBDER_REFUSAL_CODES.invalidIdempotencyKey: return 'bad key';
                case LAMBDER_REFUSAL_CODES.apiNotFound: return 'no such api';
                case LAMBDER_REFUSAL_CODES.invalidRequestPayload: return 'bad payload';
                case LAMBDER_REFUSAL_CODES.notMocked: return 'not mocked';
                case undefined: return message.content;
                default: {
                    const unreachable: never = message.code;
                    return unreachable;
                }
            }
        };

        expect(describeRefusal({ type: 'warning', code: LAMBDER_REFUSAL_CODES.rateLimited, content: 'x' })).toBe('slow down');
        expect(describeRefusal({ type: 'error', content: 'plain' })).toBe('plain');
    });

    it('takes an app\'s own vocabulary as a type argument, and keeps the switch exhaustive over it', () => {
        type AppCode = 'app/not-verified' | 'app/quota-exhausted';
        const describeAppRefusal = (message: LambderRefusalMessage<AppCode>): string => {
            switch(message.code){
                case 'app/not-verified': return 'verify your address';
                case 'app/quota-exhausted': return 'buy more';
                default: return message.content;
            }
        };

        expect(describeAppRefusal({ type: 'warning', code: 'app/not-verified', content: 'x' })).toBe('verify your address');
        // A code outside the declared vocabulary is a compile error, which is
        // the point: the client's own list is the one being checked.
        // @ts-expect-error "app/typo" is not one of this app's codes
        expect(describeAppRefusal({ type: 'warning', code: 'app/typo', content: 'fallback' })).toBe('fallback');
    });

    it('lets an app WRITE any code through LambderAppRefusalMessage', () => {
        // Refusals an app authors are the other direction: a rate-limit
        // policy's message carries whatever code the app uses.
        const message: LambderAppRefusalMessage = { type: 'warning', code: 'app/anything', content: 'x' };
        expect(message.code).toBe('app/anything');
    });
});
