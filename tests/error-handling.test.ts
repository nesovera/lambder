/**
 * What a thrown error becomes: setGlobalErrorHandler's response, with or
 * without a context, for routes, APIs and hooks alike, and the last-resort
 * answer when there is no handler.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { decodeBody, createMockEvent, createApiEvent, createMockContext, testPublicFiles } from './helpers.js';
import { z } from 'zod';
import Lambder, { initLambder } from '../src/core/Lambder.js';
import type { LambderFallbackHandler } from '../src/core/LambderCreateOptions.js';
import { LambderMemorySessionStore, lambderTestApp, assertApiFailure } from '../src/testing.js';

describe('Error Handling - Global Error Handler', () => {
    it('should catch errors in route handlers', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.raw({
                    statusCode: 500,
                    body: `Error: ${err.message}`
                });
            })
            .addRoute('/error', (ctx, res) => {
                throw new Error('Route handler error');
            });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/error'), createMockContext());

        expect(result.statusCode).toBe(500);
        expect(result.body).toBe('Error: Route handler error');
    });

    it('keeps the headers the call wrote, and the CORS headers, when the global handler answers', async () => {
        // Headers belong to the CALL, not to the response that first carried
        // them, which is how the success path treats them. A call that set a
        // cookie and then threw still owes the browser that cookie, and a
        // cross-origin caller cannot read the error body at all without the
        // CORS headers.
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
            cors: true,
        })
            .setGlobalErrorHandler((err, ctx, res) => res.raw({ statusCode: 500, body: `Error: ${err.message}` }))
            .addRoute('/boom', (ctx, res) => {
                res.setHeader('X-Written-During-Call', 'yes');
                res.addHeader('Set-Cookie', 'session=abc; Path=/');
                throw new Error('after the header');
            });

        const event = createMockEvent('/boom');
        event.headers = { ...event.headers, Origin: 'https://example.com' };
        const result = await lambder.getHandler()(event, createMockContext());

        expect(result.statusCode).toBe(500);
        const headers = { ...(result as any).headers, ...(result as any).multiValueHeaders };
        const flat = JSON.stringify(headers);
        expect(flat).toContain('X-Written-During-Call');
        expect(flat).toContain('session=abc');
        expect(flat.toLowerCase()).toContain('access-control-allow-origin');
    });

    it('should catch errors in API handlers', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                if (ctx?.api) {
                    return res.api({ error: err.message });
                }
                return res.raw({ statusCode: 500, body: err.message });
            })
            .addApi('errorApi', {
                input: z.object({ value: z.string() }),
                output: z.object({ result: z.string() })
            }, async (ctx, res) => {
                throw new Error('API handler error');
            });

        const handler = lambder.getHandler();
        const event = createApiEvent({ apiName: 'errorApi', payload: { value: 'test' } });
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body || '{}');
        expect(body.payload.error).toBe('API handler error');
    });

    it('should catch async errors', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.raw({ statusCode: 500, body: err.message });
            })
            .addRoute('/async-error', async (ctx, res) => {
                await Promise.resolve();
                throw new Error('Async error');
            });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/async-error'), createMockContext());

        expect(result.statusCode).toBe(500);
        expect(result.body).toBe('Async error');
    });

    it('should provide context in error handler', async () => {
        let capturedContext: any = null;

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                capturedContext = ctx;
                return res.raw({ statusCode: 500, body: 'Error' });
            })
            .addRoute('/test', (ctx, res) => {
                throw new Error('Test error');
            });

        const handler = lambder.getHandler();
        await handler(createMockEvent('/test'), createMockContext());

        expect(capturedContext).not.toBeNull();
        expect(capturedContext.path).toBe('/test');
        expect(capturedContext.method).toBe('GET');
    });

    it('should tolerate malformed events without invoking the error handler', async () => {
        let handlerCalled = false;

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                handlerCalled = true;
                return res.raw({ statusCode: 500, body: 'Error occurred' });
            });

        const handler = lambder.getHandler();

        // Missing headers are normalized to {} by the event decoder.
        const malformedEvent = {
            ...createMockEvent('/test'),
            headers: null as any
        };

        const result = await handler(malformedEvent, createMockContext());

        expect(handlerCalled).toBe(false);
        expect((result as any).statusCode).toBe(404);
    });
});

describe('Error Handling - Custom Error Responses', () => {
    it('should return custom error format for APIs', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                if (ctx?.api) {
                    return res.api(
                        { success: false, error: err.message },
                        { errorMessage: err.message }
                    );
                }
                return res.raw({ statusCode: 500, body: err.message });
            })
            .addApi('testApi', {
                input: z.void(),
                output: z.object({ success: z.boolean(), error: z.string().optional() })
            }, async (ctx, res) => {
                throw new Error('Custom error message');
            });

        const handler = lambder.getHandler();
        const event = createApiEvent({ apiName: 'testApi' });
        const result = await handler(event, createMockContext());

        const body = JSON.parse(result.body || '{}');
        expect(body.payload.success).toBe(false);
        expect(body.payload.error).toBe('Custom error message');
        expect(body.errorMessage).toEqual({ type: 'error', content: 'Custom error message' });
    });

    it('should return HTML error for routes', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.html(`<h1>Error</h1><p>${err.message}</p>`);
            })
            .addRoute('/page', (ctx, res) => {
                throw new Error('Page load failed');
            });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/page'), createMockContext());

        expect(result.statusCode).toBe(200);
        const body = decodeBody(result);
        expect(body).toContain('<h1>Error</h1>');
        expect(body).toContain('Page load failed');
    });

    it('should return JSON error for routes if desired', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.json({
                    error: true,
                    message: err.message,
                    timestamp: Date.now()
                });
            })
            .addRoute('/api-style-error', (ctx, res) => {
                throw new Error('JSON error');
            });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/api-style-error'), createMockContext());

        const body = JSON.parse(result.body || '{}');
        expect(body.error).toBe(true);
        expect(body.message).toBe('JSON error');
        expect(body.timestamp).toBeDefined();
    });
});

describe('Error Handling - Different Error Types', () => {
    it('should handle Error objects', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.raw({ statusCode: 500, body: err.message });
            })
            .addRoute('/test', (ctx, res) => {
                throw new Error('Standard Error');
            });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/test'), createMockContext());

        expect(result.body).toBe('Standard Error');
    });

    it('should handle TypeError', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.raw({ statusCode: 500, body: `${err.name}: ${err.message}` });
            })
            .addRoute('/test', (ctx, res) => {
                const obj: any = null;
                // Reading through null is the TypeError the global handler must catch.
                const _boom = obj.property.access;
                return res.html('Never reached');
            });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/test'), createMockContext());

        expect(result.statusCode).toBe(500);
        expect(result.body).toContain('Error');
    });

    it('should handle string throws as errors', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.raw({ statusCode: 500, body: err.message });
            })
            .addRoute('/test', (ctx, res) => {
                throw 'String error'; // Non-standard but should be handled
            });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/test'), createMockContext());

        expect(result.statusCode).toBe(500);
        expect(result.body).toContain('String error');
    });
});

describe('Error Handling - Errors in Hooks', () => {
    it('should catch errors in beforeRender hooks', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.raw({ statusCode: 500, body: `Hook error: ${err.message}` });
            });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            throw new Error('Before render failed');
        });

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/test'), createMockContext());

        expect(result.statusCode).toBe(500);
        expect(result.body).toBe('Hook error: Before render failed');
    });

    it('should catch errors in afterRender hooks', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.raw({ statusCode: 500, body: `Hook error: ${err.message}` });
            });

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            throw new Error('After render failed');
        });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/test'), createMockContext());

        expect(result.statusCode).toBe(500);
        expect(result.body).toBe('Hook error: After render failed');
    });

    it('should handle Error returned from beforeRender hook', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.raw({ statusCode: 403, body: err.message });
            });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            return new Error('Access denied by hook');
        });

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/test'), createMockContext());

        expect(result.statusCode).toBe(403);
        expect(result.body).toBe('Access denied by hook');
    });

    it('should handle Error returned from afterRender hook', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.raw({ statusCode: 500, body: err.message });
            });

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            return new Error('Response validation failed');
        });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/test'), createMockContext());

        expect(result.statusCode).toBe(500);
        expect(result.body).toBe('Response validation failed');
    });
});

describe('Error Handling - Default Error Behavior', () => {
    it('should return 500 when no global error handler is set', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/error', (ctx, res) => {
                throw new Error('Unhandled error');
            });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/error'), createMockContext());

        expect(result.statusCode).toBe(500);
        expect(result.body).toBe('Internal Server Error.');
    });
});

describe('Error Handling - Input Validation Errors', () => {
    it('should return 400 for invalid API input', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addApi('testApi', {
                input: z.object({
                    email: z.email(),
                    age: z.number().positive()
                }),
                output: z.object({ success: z.boolean() })
            }, async (ctx, res) => {
                return res.api({ success: true });
            });

        const handler = lambder.getHandler();
        const event = createApiEvent({ apiName: 'testApi', payload: { email: 'invalid-email', age: -5 } });
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(422);
        const body = JSON.parse(result.body || '{}');
        expect(body.error).toBe('Input validation failed');
        expect(body.zodError).toBeDefined();
    });

    it('should allow custom handling of validation errors', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                // This won't be called for validation errors since they're handled before the handler
                return res.raw({ statusCode: 500, body: err.message });
            })
            .addApi('testApi', {
                input: z.object({ value: z.string().min(5) }),
                output: z.object({ result: z.string() })
            }, async (ctx, res) => {
                return res.api({ result: 'success' });
            });

        const handler = lambder.getHandler();
        const event = createApiEvent({ apiName: 'testApi', payload: { value: 'abc' } }); // Too short
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(422);
    });
});

describe('Error Handling - Error with Additional Context', () => {
    it('should access request context in error handler', async () => {
        let errorContext: any = null;

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                errorContext = {
                    path: ctx?.path,
                    method: ctx?.method,
                    host: ctx?.host
                };
                return res.raw({ statusCode: 500, body: 'Error' });
            })
            .addRoute('/test', (ctx, res) => {
                throw new Error('Test');
            });

        const handler = lambder.getHandler();
        await handler(createMockEvent('/test'), createMockContext());

        expect(errorContext.path).toBe('/test');
        expect(errorContext.method).toBe('GET');
        expect(errorContext.host).toBe('localhost');
    });

    it('should provide response builder in error handler', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, responseBuilder) => {
                // responseBuilder should have all response methods
                return responseBuilder.json({
                    error: err.message,
                    code: 'CUSTOM_ERROR'
                });
            })
            .addRoute('/test', (ctx, res) => {
                throw new Error('Test error');
            });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/test'), createMockContext());

        const body = JSON.parse(result.body || '{}');
        expect(body.error).toBe('Test error');
        expect(body.code).toBe('CUSTOM_ERROR');
    });
});

describe('Error Handling - Complex Error Scenarios', () => {
    it('should handle errors in chained operations', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.json({ error: err.message });
            })
            .addRoute('/chain-error', async (ctx, res) => {
                await Promise.resolve()
                    .then(() => Promise.resolve())
                    .then(() => {
                        throw new Error('Chain error');
                    });
                return res.html('Never reached');
            });

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/chain-error'), createMockContext());

        const body = JSON.parse(result.body || '{}');
        expect(body.error).toBe('Chain error');
    });

    it('should distinguish between route errors and API errors', async () => {
        const errorTypes: string[] = [];

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                if (ctx?.api) {
                    errorTypes.push('api');
                    return res.api({ error: err.message });
                } else {
                    errorTypes.push('route');
                    return res.html(`<h1>${err.message}</h1>`);
                }
            })
            .addRoute('/route-error', (ctx, res) => {
                throw new Error('Route error');
            })
            .addApi('errorApi', {
                input: z.void(),
                output: z.object({ error: z.string() })
            }, async (ctx, res) => {
                throw new Error('API error');
            });

        const handler = lambder.getHandler();

        await handler(createMockEvent('/route-error'), createMockContext());
        await handler(createApiEvent({ apiName: 'errorApi' }), createMockContext());

        expect(errorTypes).toEqual(['route', 'api']);
    });

    it('answers a thrown value that cannot even be turned into a string', async () => {
        // A value that throws on coercion must not make the last-resort catch
        // throw too: that leaves no error handler, no envelope, and an
        // invocation that rejects with a 502 carrying nothing a client can read.
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addRoute('/nullproto', () => { throw Object.create(null); })
            .addRoute('/throwing-tostring', () => {
                throw { toString(){ throw new Error('nope'); }, [Symbol.toPrimitive](){ throw new Error('nope'); } };
            });

        for(const path of ['/nullproto', '/throwing-tostring']){
            const result = await lambder.render(createMockEvent(path), createMockContext());
            expect(result.statusCode).toBe(500);
        }
    });
});

/**
 * LambderSessionNotFoundError from a route, a session route or a hook: the
 * session ended while the request held it (another tab logged out, a
 * password change landed), or a hook asked for a session the request never
 * had. Pins the bug where only an API handler's was answered as a missing
 * session; everywhere else it was a 500 and a crash report for what is an
 * ordinary logout.
 */
describe('Error Handling - A session that ended while the request held it', () => {
    type SessionData = { userId: string; theme: string };
    const buildApp = (sessionExpiredRouteHandler?: LambderFallbackHandler) => {
        const reported: string[] = [];
        const lambder = initLambder<SessionData>().create({
            apiPath: '/api',
            session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
            crashes: { report: (crash) => { reported.push(crash.message); } },
        })
            .addHook('beforeRender', async (ctx) => {
                // A hook that insists on a session for one area of the app.
                if(ctx.path.startsWith('/members') || ctx.apiName === 'membersOnly') await ctx.sessionController.fetchSession();
                return ctx;
            })
            .addHook('afterRender', async (ctx, res, response) => {
                if(ctx.path === '/refreshed') await ctx.sessionController.refreshSessionData();
                return response;
            })
            .addSessionRoute('/settings', async (ctx, res) => {
                // Another tab logs out everywhere while this request holds the session.
                await ctx.sessionController.deleteSessionAllByKey(ctx.session.sessionKey);
                await ctx.sessionController.updateSessionData({ ...ctx.session.data, theme: 'dark' });
                return res.text('saved');
            })
            .addRoute('/members/area', (ctx, res) => res.text('members'))
            .addRoute('/refreshed', (ctx, res) => res.text('refreshed'))
            .addApi('membersOnly', { input: z.object({}), output: z.object({}) }, async (ctx, res) => res.api({}));
        if(sessionExpiredRouteHandler) lambder.setSessionExpiredRouteHandler(sessionExpiredRouteHandler);
        return { app: lambderTestApp(lambder), reported };
    };

    it('answers a route, a beforeRender hook and an afterRender hook with the default 401, not a crash', async () => {
        const { app, reported } = buildApp();
        const ada = await app.signIn('ada', { userId: 'ada', theme: 'light' });

        for(const [visitor, path] of [[ada, '/settings'], [app.visitor(), '/members/area'], [app.visitor(), '/refreshed']] as const){
            const page = await visitor.request('GET', path);
            expect(page.statusCode).toBe(401);
            expect(page.text()).toBe('Session required.');
        }
        expect(app.crashes).toEqual([]);
        expect(reported).toEqual([]);
    });

    it('answers them with the setSessionExpiredRouteHandler answer when there is one, thrown or returned', async () => {
        const returned = buildApp((ctx, res) => res.redirect('/login'));
        const signedIn = await returned.app.signIn('ada', { userId: 'ada', theme: 'light' });
        const page = await signedIn.request('GET', '/settings');
        expect(page.statusCode).toBe(302);
        expect(page.headers['location']).toBe('/login');

        const thrown = buildApp((ctx, res) => { throw res.redirect('/login'); });
        const hooked = await thrown.app.visitor().request('GET', '/members/area');
        expect(hooked.statusCode).toBe(302);
        expect(hooked.headers['location']).toBe('/login');

        expect([...returned.app.crashes, ...thrown.app.crashes]).toEqual([]);
        expect([...returned.reported, ...thrown.reported]).toEqual([]);
    });

    it('answers an API call whose hook found no session with the sessionExpired envelope', async () => {
        const { app, reported } = buildApp();

        assertApiFailure(await app.visitor().apiOutcome('membersOnly', {}), 'sessionExpired');
        expect(app.crashes).toEqual([]);
        expect(reported).toEqual([]);
    });
});

/**
 * Session cookies that name more than one live session, at different scopes
 * (a sibling subdomain planted one at a parent domain): fetchSession()
 * refuses both with LambderSessionAmbiguousError and clears every scope. A
 * route, a hook or an API handler that asked for the session answers as a
 * missing one, with the clearing cookies. Pins the bug where only
 * fetchSessionIfExists() read the ambiguous case as "no session", and a
 * route or hook calling fetchSession() answered a 500 and a crash report.
 */
describe('Error Handling - Session cookies that name more than one live session', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    const buildApp = () => {
        const reported: string[] = [];
        const lambder = initLambder<{ userId: string }>().create({
            apiPath: '/api',
            session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
            crashes: { report: (crash) => { reported.push(crash.message); } },
        })
            .addHook('beforeRender', async (ctx) => {
                if(ctx.path.startsWith('/members') || ctx.apiName === 'membersOnly') await ctx.sessionController.fetchSession();
                return ctx;
            })
            .addRoute('/me', async (ctx, res) => res.text(`hi ${(await ctx.sessionController.fetchSession()).sessionKey}`))
            .addRoute('/members/area', (ctx, res) => res.text('members'))
            .addApi('whoAmI', { input: z.object({}), output: z.object({ sessionKey: z.string() }) },
                async (ctx, res) => res.api({ sessionKey: (await ctx.sessionController.fetchSession()).sessionKey }))
            .addApi('membersOnly', { input: z.object({}), output: z.object({}) }, async (ctx, res) => res.api({}));
        return { lambder, reported };
    };

    /** The visitor's own session and one a sibling host planted, both live, under the one cookie name. */
    const twoLiveSessions = async (lambder: ReturnType<typeof buildApp>['lambder']) => {
        const manager = lambder.getSessionManager();
        const own = await manager.createSession('ada', { userId: 'ada' });
        const planted = await manager.createSession('mallory', { userId: 'mallory' });
        return {
            headers: { Host: 'app.example.com', Cookie: `LMDRSESSIONTKID=${own.sessionToken}; LMDRSESSIONTKID=${planted.sessionToken}` },
            csrf: own.csrfToken,
        };
    };

    it('answers a route and a beforeRender hook that fetched the session with the default 401 and the clearing cookies, not a crash', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { lambder, reported } = buildApp();
        const { headers } = await twoLiveSessions(lambder);

        for(const path of ['/me', '/members/area']){
            const page = await lambder.render(createMockEvent(path, { headers }), createMockContext());
            expect(page.statusCode).toBe(401);
            expect(decodeBody(page)).toBe('Session required.');
            expect(page.multiValueHeaders?.['Set-Cookie']?.some((cookie) => cookie.startsWith('LMDRSESSIONTKID=;'))).toBe(true);
        }
        expect(reported).toEqual([]);
        expect(warn.mock.calls.some((call) => String(call[0]).includes('Refusing all of them'))).toBe(true);
    });

    it('answers an API handler and an API call\'s hook that fetched the session with the sessionExpired envelope and the clearing cookies', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { lambder, reported } = buildApp();
        const { headers, csrf } = await twoLiveSessions(lambder);

        for(const apiName of ['whoAmI', 'membersOnly']){
            const result = await lambder.render(createApiEvent({ apiName, token: csrf, payload: {} }, { headers }), createMockContext());
            expect(result.statusCode).toBe(200);
            expect(JSON.parse(decodeBody(result))).toMatchObject({ sessionExpired: true });
            expect(result.multiValueHeaders?.['Set-Cookie']?.some((cookie) => cookie.startsWith('LMDRSESSIONTKID=;'))).toBe(true);
        }
        expect(reported).toEqual([]);
    });
});
