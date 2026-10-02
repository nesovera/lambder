/**
 * LambderApiRefusal: typed refusals mapped onto the API envelope.
 *
 * - Thrown anywhere in an API call's stack (handler, hooks, nested helpers
 *   that hold nothing of the request), it becomes the refusal envelope
 *   ({ refusal, notAuthorized, sessionExpired }) and never reaches the
 *   global error handler.
 * - Thrown outside an API call it stays a normal error.
 * - Detection is brand-based (isLambderApiRefusal) so refusals survive duplicate
 *   lambder installs.
 * - The last-resort 500 for API calls is a JSON envelope, not plain text.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import Lambder, { initLambder } from '../../src/core/Lambder.js';
import { LambderApiRefusal, isLambderApiRefusal, refuse, refusalMessageOf, LAMBDER_REFUSAL_CODES } from '../../src/shared/wire/LambderApiRefusal.js';
import type { LambderUncheckedRefusalMessage, LambderRefusalMessage } from '../../src/shared/wire/LambderApiRefusal.js';
import { decodeBody, createApiEvent as createEnvelopeEvent, createMockContext, testPublicFiles } from '../helpers.js';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const createApiEvent = (apiName: string, payload?: any): APIGatewayProxyEvent =>
    createEnvelopeEvent({ apiName, payload });

const createRouteEvent = (path: string): APIGatewayProxyEvent => ({
    ...createApiEvent('test.unused'),
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
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .setGlobalErrorHandler((err, ctx, res) => {
                globalHandlerCalled = true;
                return res.raw({ statusCode: 500, body: 'crash' });
            });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            refuse: app.defineApi(testSchema, async () => {
                throw new LambderApiRefusal('You are not on the staff of this store.');
            }),
        }));

        const result = await lambder.render(createApiEvent('test.refuse', { value: 'x' }), createMockContext());

        expect(globalHandlerCalled).toBe(false);
        expect(result.statusCode).toBe(200);
        const body = JSON.parse(decodeBody(result));
        expect(body.payload).toBe(null);
        expect(body.refusal).toEqual({ type: 'error', content: 'You are not on the staff of this store.' });
    });

    it('works from nested helpers that hold nothing of the request', async () => {
        const requireAdmin = (role: string) => {
            if(role !== 'admin') throw new LambderApiRefusal('Permission denied.', { notAuthorized: true });
        };
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            guarded: app.defineApi(testSchema, async (ctx) => {
                requireAdmin('member');
                return { result: 'never' };
            }),
        }));

        const result = await lambder.render(createApiEvent('test.guarded', { value: 'x' }), createMockContext());

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(decodeBody(result));
        expect(body.notAuthorized).toBe(true);
        expect(body.refusal).toEqual({ type: 'error', content: 'Permission denied.' });
    });

    it('carries structured refusal objects verbatim', async () => {
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            refuse: app.defineApi(testSchema, async () => {
                throw new LambderApiRefusal('Quota exceeded', {
                    refusal: { type: 'warning', content: 'Daily quota exceeded.' },
                });
            }),
        }));

        const result = await lambder.render(createApiEvent('test.refuse', { value: 'x' }), createMockContext());
        const body = JSON.parse(decodeBody(result));
        expect(body.refusal).toEqual({ type: 'warning', content: 'Daily quota exceeded.' });
    });

    it('sets the sessionExpired flag when requested', async () => {
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            refuse: app.defineApi(testSchema, async () => {
                throw new LambderApiRefusal('Session gone', { sessionExpired: true });
            }),
        }));

        const result = await lambder.render(createApiEvent('test.refuse', { value: 'x' }), createMockContext());
        const body = JSON.parse(decodeBody(result));
        expect(body.sessionExpired).toBe(true);
    });

    it('honors a statusCode override', async () => {
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            refuse: app.defineApi(testSchema, async () => {
                throw new LambderApiRefusal('Forbidden', { statusCode: 403 });
            }),
        }));

        const result = await lambder.render(createApiEvent('test.refuse', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(403);
        const body = JSON.parse(decodeBody(result));
        expect(body.refusal).toEqual({ type: 'error', content: 'Forbidden' });
    });

    it('maps refusals thrown from beforeRender hooks on API calls', async () => {
        let handlerRan = false;
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        app.addHook('beforeRender', (ctx) => {
            if(ctx.apiName === 'test.guarded') throw new LambderApiRefusal('Blocked by hook');
            return ctx;
        });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            guarded: app.defineApi(testSchema, async (ctx) => {
                handlerRan = true;
                return { result: 'never' };
            }),
        }));

        const result = await lambder.render(createApiEvent('test.guarded', { value: 'x' }), createMockContext());

        expect(handlerRan).toBe(false);
        expect(result.statusCode).toBe(200);
        expect(JSON.parse(decodeBody(result)).refusal).toEqual({ type: 'error', content: 'Blocked by hook' });
    });

    it('maps refusals thrown from afterRender hooks on API calls', async () => {
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            ok: app.defineApi(testSchema, async (ctx) => ({ result: 'fine' })),
        }));
        lambder.addHook('afterRender', () => {
            throw new LambderApiRefusal('Rejected after render');
        });

        const result = await lambder.render(createApiEvent('test.ok', { value: 'x' }), createMockContext());
        expect(JSON.parse(decodeBody(result)).refusal).toEqual({ type: 'error', content: 'Rejected after render' });
    });

    it('recognizes the brand across duplicate installs (no instanceof)', async () => {
        // Simulate an error constructed by a second copy of the package.
        const foreign = Object.assign(new Error('Foreign refusal'), {
            isLambderApiRefusal: true,
            refusal: 'Foreign refusal',
            notAuthorized: true,
        });
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            refuse: app.defineApi(testSchema, async () => { throw foreign; }),
        }));

        const result = await lambder.render(createApiEvent('test.refuse', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(200);
        const body = JSON.parse(decodeBody(result));
        expect(body.notAuthorized).toBe(true);
        expect(isLambderApiRefusal(foreign)).toBe(true);
    });
});

describe('refuse() - the standard refusal shape', () => {
    it('is the shape of the framework\'s own refusals too (unknown API)', async () => {
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        const result = await lambder.render(createApiEvent('test.missing', {}), createMockContext());
        expect(JSON.parse(decodeBody(result)).refusal).toEqual({ type: 'warning', code: LAMBDER_REFUSAL_CODES.apiNotFound, content: 'API not found.' });
    });

    it('carries a machine-readable code for clients to branch and translate on', async () => {
        const app = initLambder().declareRefusals({ ALREADY_REPORTED: {} }).create({ files: testPublicFiles(), apiPath: '/api' });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            dup: app.defineApi({ ...testSchema, refusals: 'ALREADY_REPORTED' }, async () => refuse('Already reported.', { code: 'ALREADY_REPORTED' })),
        }));

        const result = await lambder.render(createApiEvent('test.dup', { value: 'x' }), createMockContext());
        expect(JSON.parse(decodeBody(result)).refusal).toEqual({ type: 'warning', code: 'ALREADY_REPORTED', content: 'Already reported.' });
    });

    it('carries extra headers onto the refusal response', async () => {
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            later: app.defineApi(testSchema, async () => refuse('Come back later.', { statusCode: 429, headers: { 'Retry-After': '30' } })),
        }));

        const result = await lambder.render(createApiEvent('test.later', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(429);
        expect(result.multiValueHeaders?.['Retry-After']).toEqual(['30']);
    });

    it('replaces the envelope\'s own header when a refusal names it under another casing', async () => {
        // Two Content-Type headers on one response is not a thing; the
        // refusal's is the one the app asked for.
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            plain: app.defineApi(testSchema, async () => refuse('No.', { headers: { 'content-type': 'text/plain' } })),
        }));

        const result = await lambder.render(createApiEvent('test.plain', { value: 'x' }), createMockContext());

        const contentTypes = Object.entries(result.multiValueHeaders ?? {})
            .filter(([key]) => key.toLowerCase() === 'content-type')
            .flatMap(([, values]) => values);
        expect(contentTypes).toEqual(['text/plain']);
    });

    it('maps to a warning envelope by default', async () => {
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            nope: app.defineApi(testSchema, async () => refuse('Record not found.')),
        }));

        const result = await lambder.render(createApiEvent('test.nope', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(200);
        const body = JSON.parse(decodeBody(result));
        expect(body.payload).toBe(null);
        expect(body.refusal).toEqual({ type: 'warning', content: 'Record not found.' });
    });

    it('carries type, title, flags and statusCode through its options', async () => {
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api' });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            denied: app.defineApi(testSchema, async () => refuse('Admins only.', {
                type: 'error', title: 'Not Allowed', notAuthorized: true, statusCode: 403,
            })),
        }));

        const result = await lambder.render(createApiEvent('test.denied', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(403);
        const body = JSON.parse(decodeBody(result));
        expect(body.notAuthorized).toBe(true);
        expect(body.refusal).toEqual({ type: 'error', title: 'Not Allowed', content: 'Admins only.' });
    });

    it('works from nested helpers and skips the global error handler', async () => {
        let globalHandlerCalled = false;
        const assertPositive = (n: number) => { if (n <= 0) refuse('Value must be positive.'); };
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .setGlobalErrorHandler((err, ctx, res) => {
                globalHandlerCalled = true;
                return res.raw({ statusCode: 500, body: 'crash' });
            });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            guarded: app.defineApi(testSchema, async (ctx) => {
                assertPositive(-1);
                return { result: 'never' };
            }),
        }));

        const result = await lambder.render(createApiEvent('test.guarded', { value: 'x' }), createMockContext());
        expect(globalHandlerCalled).toBe(false);
        expect(JSON.parse(decodeBody(result)).refusal.content).toBe('Value must be positive.');
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
        const app = new Lambder({ files: testPublicFiles(), apiPath: '/api', apiVersion: '1.2.3' });
        const lambder = app.registerApiGroups(app.defineApiGroup('test', {
            crash: app.defineApi(testSchema, async () => {
                throw new Error('boom');
            }),
        }));

        const result = await lambder.render(createApiEvent('test.crash', { value: 'x' }), createMockContext());

        expect(result.statusCode).toBe(500);
        expect(result.multiValueHeaders?.['Content-Type']).toEqual(['application/json; charset=utf-8']);
        const body = JSON.parse(result.body || '{}');
        expect(body.payload).toBe(null);
        expect(body.refusal).toEqual({ type: 'error', content: 'Internal server error.' });
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
        // A code typed `LambderRefusalCode | (string & {})` would not narrow:
        // a case is not assignable to the scrutinee and the `default: never`
        // assertion fails, so no consumer could get the exhaustiveness the
        // framework's own vocabulary is designed for.
        const describeRefusal = (message: LambderRefusalMessage): string => {
            switch(message.code){
                // The one framework code with data: the policy and the wait.
                case LAMBDER_REFUSAL_CODES.rateLimited: return `slow down on ${message.data.policy} for ${message.data.retryAfterSeconds}s`;
                case LAMBDER_REFUSAL_CODES.duplicateInFlight: return 'already running';
                case LAMBDER_REFUSAL_CODES.idempotencyKeyReused: return 'another request';
                case LAMBDER_REFUSAL_CODES.invalidIdempotencyKey: return 'bad key';
                case LAMBDER_REFUSAL_CODES.apiNotFound: return 'no such api';
                case LAMBDER_REFUSAL_CODES.invalidRequestPayload: return 'bad payload';
                case LAMBDER_REFUSAL_CODES.notMocked: return 'not mocked';
                case LAMBDER_REFUSAL_CODES.uploadEmpty: return 'empty file';
                case LAMBDER_REFUSAL_CODES.uploadTypeRejected: return 'wrong kind of file';
                case LAMBDER_REFUSAL_CODES.uploadTooLarge: return 'file too large';
                case undefined: return message.content;
                default: {
                    const unreachable: never = message;
                    return unreachable;
                }
            }
        };

        expect(describeRefusal({ type: 'warning', code: LAMBDER_REFUSAL_CODES.rateLimited, content: 'x', data: { policy: 'checkoutPerIp', retryAfterSeconds: 30 } })).toBe('slow down on checkoutPerIp for 30s');
        expect(describeRefusal({ type: 'error', content: 'plain' })).toBe('plain');
        // A rate limit always carries its data, and no other framework code carries any.
        const typesOnly = () => {
            // @ts-expect-error lambder/rate-limited without its policy and wait
            describeRefusal({ type: 'warning', code: LAMBDER_REFUSAL_CODES.rateLimited, content: 'x' });
            // @ts-expect-error a framework code that carries no data
            describeRefusal({ type: 'warning', code: LAMBDER_REFUSAL_CODES.apiNotFound, content: 'x', data: { policy: 'p', retryAfterSeconds: 1 } });
        };
        expect(typesOnly).toBeTypeOf('function');
    });

    it('takes an endpoint\'s declared codes as a type argument, narrows data on the code, and keeps the switch exhaustive over them', () => {
        type Declared = { 'app/not-verified': {}; 'app/quota-exhausted': { data: { remaining: number } } };
        const describeAppRefusal = (message: LambderRefusalMessage<Declared>): string => {
            switch(message.code){
                case 'app/not-verified': return 'verify your address';
                case 'app/quota-exhausted': return `buy more (${message.data.remaining} left)`;
                default: return message.content;
            }
        };

        expect(describeAppRefusal({ type: 'warning', code: 'app/not-verified', content: 'x' })).toBe('verify your address');
        expect(describeAppRefusal({ type: 'warning', code: 'app/quota-exhausted', content: 'x', data: { remaining: 0 } })).toBe('buy more (0 left)');
        // A code outside the declared codes is a compile error, which is the
        // point: the endpoint's own list is the one being checked.
        // @ts-expect-error "app/typo" is not one of the declared codes
        expect(describeAppRefusal({ type: 'warning', code: 'app/typo', content: 'fallback' })).toBe('fallback');
        // @ts-expect-error a code that declares data carries it
        const _withoutData: LambderRefusalMessage<Declared> = { type: 'warning', code: 'app/quota-exhausted', content: 'x' };
    });

    it('lets an app WRITE any code through LambderUncheckedRefusalMessage', () => {
        // Refusals an app authors are the other direction: a rate-limit
        // policy's message carries whatever code the app uses.
        const message: LambderUncheckedRefusalMessage = { type: 'warning', code: 'app/anything', content: 'x' };
        expect(message.code).toBe('app/anything');
    });
});

describe('refusalMessageOf', () => {
    it('reads a plain string as an error message with that content', () => {
        expect(refusalMessageOf('No.')).toEqual({ type: 'error', content: 'No.' });
        expect(refusalMessageOf('')).toEqual({ type: 'error', content: '' });
    });

    it('hands a message object back as it is', () => {
        const message: LambderUncheckedRefusalMessage = { type: 'warning', code: 'app/no', title: 'Heads up', content: 'No.' };
        expect(refusalMessageOf(message)).toBe(message);
    });

    it('gives a message with no readable type the error type, and describes what is not a message at all', () => {
        expect(refusalMessageOf({ type: 'shout', content: 'No.' })).toEqual({ type: 'error', content: 'No.' });
        expect(refusalMessageOf({ reason: 'teapot' })).toEqual({ type: 'error', content: '{"reason":"teapot"}' });
        expect(refusalMessageOf(418)).toEqual({ type: 'error', content: '418' });
        expect(refusalMessageOf(null)).toEqual({ type: 'error', content: 'null' });
    });
});
