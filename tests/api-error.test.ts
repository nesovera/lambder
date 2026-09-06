/**
 * LambderApiError: typed refusals mapped onto the API envelope.
 *
 * - Thrown anywhere in an API call's stack (handler, hooks, nested helpers
 *   with no resolver access), it becomes res.api(null, { errorMessage,
 *   notAuthorized, sessionExpired }) and never reaches the global error handler.
 * - Thrown outside an API call it stays a normal error.
 * - Detection is brand-based (isLambderApiError) so refusals survive duplicate
 *   lambder installs.
 * - The last-resort 500 for API calls is a JSON envelope, not plain text.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import Lambder from '../src/Lambder.js';
import { LambderApiError, isLambderApiError } from '../src/LambderApiError.js';
import { decodeBody, createMockContext } from './helpers.js';
import type { APIGatewayProxyEvent } from 'aws-lambda';

const createApiEvent = (apiName: string, payload?: any): APIGatewayProxyEvent => ({
    body: JSON.stringify({ apiName, payload }),
    headers: { Host: 'localhost' },
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/api',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
});

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

describe('LambderApiError - envelope mapping on API calls', () => {
    it('maps a thrown refusal to the structured envelope and skips the global error handler', async () => {
        let globalHandlerCalled = false;
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .setGlobalErrorHandler((err, ctx, res) => {
                globalHandlerCalled = true;
                return res.raw({ statusCode: 500, body: 'crash' });
            })
            .addApi('refuse', testSchema, async () => {
                throw new LambderApiError('You are not a member of an organization.');
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
            if(role !== 'admin') throw new LambderApiError('Permission denied.', { notAuthorized: true });
        };
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
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
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .addApi('refuse', testSchema, async () => {
                throw new LambderApiError('Quota exceeded', {
                    errorMessage: { type: 'warning', content: 'Daily quota exceeded.' },
                });
            });

        const result = await lambder.render(createApiEvent('refuse', { value: 'x' }), createMockContext());
        const body = JSON.parse(decodeBody(result));
        expect(body.errorMessage).toEqual({ type: 'warning', content: 'Daily quota exceeded.' });
    });

    it('sets the sessionExpired flag when requested', async () => {
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .addApi('refuse', testSchema, async () => {
                throw new LambderApiError('Session gone', { sessionExpired: true });
            });

        const result = await lambder.render(createApiEvent('refuse', { value: 'x' }), createMockContext());
        const body = JSON.parse(decodeBody(result));
        expect(body.sessionExpired).toBe(true);
    });

    it('honors a statusCode override', async () => {
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .addApi('refuse', testSchema, async () => {
                throw new LambderApiError('Forbidden', { statusCode: 403 });
            });

        const result = await lambder.render(createApiEvent('refuse', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(403);
        const body = JSON.parse(decodeBody(result));
        expect(body.errorMessage).toBe('Forbidden');
    });

    it('maps refusals thrown from beforeRender hooks on API calls', async () => {
        let handlerRan = false;
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' });
        lambder.addHook('beforeRender', (ctx) => {
            if(ctx.apiName === 'guarded') throw new LambderApiError('Blocked by hook');
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
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .addApi('ok', testSchema, async (ctx, res) => res.api({ result: 'fine' }));
        lambder.addHook('afterRender', () => {
            throw new LambderApiError('Rejected after render');
        });

        const result = await lambder.render(createApiEvent('ok', { value: 'x' }), createMockContext());
        expect(JSON.parse(decodeBody(result)).errorMessage).toBe('Rejected after render');
    });

    it('recognizes the brand across duplicate installs (no instanceof)', async () => {
        // Simulate an error constructed by a second copy of the package.
        const foreign = Object.assign(new Error('Foreign refusal'), {
            isLambderApiError: true,
            errorMessage: 'Foreign refusal',
            notAuthorized: true,
        });
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .addApi('refuse', testSchema, async () => { throw foreign; });

        const result = await lambder.render(createApiEvent('refuse', { value: 'x' }), createMockContext());
        expect(result.statusCode).toBe(200);
        const body = JSON.parse(decodeBody(result));
        expect(body.notAuthorized).toBe(true);
        expect(isLambderApiError(foreign)).toBe(true);
    });
});

describe('LambderApiError - outside API calls', () => {
    it('falls through to the global error handler on routes', async () => {
        let seenByGlobalHandler: Error | null = null;
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .setGlobalErrorHandler((err, ctx, res) => {
                seenByGlobalHandler = err;
                return res.raw({ statusCode: 500, body: 'crash' });
            })
            .addRoute('/page', () => {
                throw new LambderApiError('Not an API call');
            });

        const result = await lambder.render(createRouteEvent('/page'), createMockContext());
        expect(result.statusCode).toBe(500);
        expect(seenByGlobalHandler).toBeInstanceOf(LambderApiError);
    });
});

describe('Last-resort 500 shape', () => {
    it('answers API calls with a JSON envelope when no global error handler exists', async () => {
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api', apiVersion: '1.2.3' })
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
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .addRoute('/crash', () => { throw new Error('boom'); });

        const result = await lambder.render(createRouteEvent('/crash'), createMockContext());
        expect(result.statusCode).toBe(500);
        expect(result.body).toBe('Internal Server Error.');
    });
});
