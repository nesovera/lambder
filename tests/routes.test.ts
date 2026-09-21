/**
 * Routes Tests
 * 
 * Tests for addRoute and addSessionRoute functionality including:
 * - String path matching
 * - Path parameter extraction
 * - RegExp route matching
 * - Function-based conditional routing
 * - Session-protected routes
 * - Route priority/ordering
 * - Wildcard routes
 */

import { describe, it, expect } from 'vitest';
import { browse, testPublicFiles } from './helpers.js';
import Lambder, { initLambder } from '../src/core/Lambder.js';
import { LambderDdbSessionStore } from '../src/stores/LambderDdbSessionStore.js';
import { lambderTestApp } from '../src/testing.js';

describe('Routes - Basic Path Matching', () => {
    it('should match simple string paths', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/hello', (ctx, res) => {
                return res.html('Hello World');
            });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/hello');

        expect(result.statusCode).toBe(200);
        const body = result.text();
        expect(body).toBe('Hello World');
    });

    it('should not match wrong paths', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/hello', (ctx, res) => {
                return res.html('Hello');
            })
            .setRouteFallbackHandler((ctx, res) => {
                return res.status404('Not Found');
            });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/goodbye');

        expect(result.statusCode).toBe(404);
    });

    it('should match multiple routes', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/home', (ctx, res) => {
                return res.html('Home Page');
            })
            .addRoute('/about', (ctx, res) => {
                return res.html('About Page');
            })
            .addRoute('/contact', (ctx, res) => {
                return res.html('Contact Page');
            });

        const visitor = browse(lambder);

        const homeResult = await visitor.request('GET', '/home');
        expect(homeResult.text()).toBe('Home Page');

        const aboutResult = await visitor.request('GET', '/about');
        expect(aboutResult.text()).toBe('About Page');

        const contactResult = await visitor.request('GET', '/contact');
        expect(contactResult.text()).toBe('Contact Page');
    });
});

describe('Routes - Path Parameters', () => {
    it('should extract path parameters from string patterns', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/user/:userId', (ctx, res) => {
                return res.json({ userId: ctx.pathParams?.userId });
            });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/user/123');

        expect(result.statusCode).toBe(200);
        const body = result.json() as Record<string, unknown>;
        expect(body.userId).toBe('123');
    });

    it('should extract multiple path parameters', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/users/:userId/posts/:postId', (ctx, res) => {
                return res.json({ 
                    userId: ctx.pathParams?.userId,
                    postId: ctx.pathParams?.postId
                });
            });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/users/456/posts/789');

        const body = result.json() as Record<string, unknown>;
        expect(body.userId).toBe('456');
        expect(body.postId).toBe('789');
    });

    it('should handle optional parameters', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/files/:path*', (ctx, res) => {
                return res.json({ path: ctx.pathParams?.path });
            });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/files/documents/report.pdf');

        const body = result.json() as Record<string, unknown>;
        expect(body.path).toBeTruthy();
    });
});

describe('Routes - RegExp Matching', () => {
    it('should match routes using RegExp', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute(/^\/admin/, (ctx, res) => {
                return res.html('Admin Area');
            });

        const visitor = browse(lambder);
        
        const adminResult = await visitor.request('GET', '/admin');
        expect(adminResult.text()).toBe('Admin Area');

        const adminDashResult = await visitor.request('GET', '/admin/dashboard');
        expect(adminDashResult.text()).toBe('Admin Area');
    });

    it('should extract regex match groups', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute(/^\/products\/(\d+)$/, (ctx, res) => {
                const productId = ctx.pathParams?.[1];
                return res.json({ productId });
            });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/products/999');

        const body = result.json() as Record<string, unknown>;
        expect(body.productId).toBe('999');
    });

    it('should support complex regex patterns', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute(/^\/api\/v\d+/, (ctx, res) => {
                return res.json({ matched: true });
            });

        const visitor = browse(lambder);
        
        const v1Result = await visitor.request('GET', '/api/v1');
        expect((v1Result.json() as { matched: boolean }).matched).toBe(true);

        const v2Result = await visitor.request('GET', '/api/v2');
        expect((v2Result.json() as { matched: boolean }).matched).toBe(true);
    });
});

describe('Routes - Function-based Conditional Routing', () => {
    it('should match routes using custom functions', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute((ctx) => ctx.path.startsWith('/custom'), (ctx, res) => {
                return res.html('Custom Route');
            });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/custom/anything');

        expect(result.text()).toBe('Custom Route');
    });

    it('should support complex conditional logic', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute(
                (ctx) => ctx.path === '/special' && ctx.get.key === 'secret',
                (ctx, res) => {
                    return res.html('Special Access');
                }
            );

        const visitor = browse(lambder);

        // Without query param
        expect((await visitor.request('GET', '/special')).statusCode).toBe(404); // Fallback

        // With query param
        expect((await visitor.request('GET', '/special?key=secret')).text()).toBe('Special Access');
    });

    it('should access context variables in condition', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute(
                (ctx) => ctx.host === 'admin.example.com' && ctx.path === '/dashboard',
                (ctx, res) => {
                    return res.html('Admin Dashboard');
                }
            );

        const page = await browse(lambder, { host: 'admin.example.com' }).request('GET', '/dashboard');

        expect(page.text()).toBe('Admin Dashboard');
    });
});

describe('Routes - Session Protected Routes', () => {
    type SessionData = { userId: string; role: string; username?: string };
    // Created over the DynamoDB store, as a deployed app is; the test app puts
    // a memory store under the instance, so no table and no SDK mock is needed
    // to get a session in front of a session route.
    const createSessionApp = () => initLambder<SessionData>().create({ files: testPublicFiles(),
        apiPath: '/api', session: { store: new LambderDdbSessionStore({ tableName: 'test-sessions', region: 'us-east-1', partitionKey: 'pk', sortKey: 'sk' }), sessionSalt: 'test-salt' } });

    it('should protect routes with addSessionRoute', async () => {
        const lambder = createSessionApp()
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.html(`<h1>Error: ${err.message}</h1>`);
            })
            .addSessionRoute('/protected', (ctx, res) => {
                return res.html(`Welcome ${ctx.session.data.userId}`);
            });

        const visitor = await lambderTestApp(lambder).signIn('user-123', { userId: '123', role: 'user' });
        const page = await visitor.request('GET', '/protected');

        expect(page.statusCode).toBe(200);
        expect(page.text()).toContain('Welcome 123');
    });

    it('should reject access without valid session', async () => {
        const lambder = createSessionApp()
            .addSessionRoute('/protected', (ctx, res) => {
                return res.html('Protected');
            })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.raw({ statusCode: 401, body: 'Unauthorized' });
            });

        const app = lambderTestApp(lambder);
        expect((await app.visitor().request('GET', '/protected')).statusCode).toBe(401);

        // A cookie that is not a minted token is no session either.
        const forged = app.visitor();
        forged.jar.storeSetCookies(['LMDRSESSIONTKID=invalid-token; Path=/'], { host: forged.host });
        expect((await forged.request('GET', '/protected')).statusCode).toBe(401);
        expect(app.crashes).toEqual([]);
    });

    it('should access session data in session routes', async () => {
        const lambder = createSessionApp()
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.json({ error: err.message });
            })
            .addSessionRoute('/profile', (ctx, res) => {
                return res.json({
                    sessionKey: ctx.session.sessionKey,
                    username: ctx.session.data.username,
                    role: ctx.session.data.role
                });
            });

        const visitor = await lambderTestApp(lambder).signIn('user-456', { userId: '456', username: 'testuser', role: 'admin' });

        expect((await visitor.request('GET', '/profile')).json()).toEqual({ sessionKey: 'user-456', username: 'testuser', role: 'admin' });
    });
});

describe('Routes - Priority and Ordering', () => {
    it('should match first defined route when multiple routes match', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/item', (ctx, res) => {
                return res.html('Exact Match');
            })
            .addRoute(/^\/item/, (ctx, res) => {
                return res.html('Regex Match');
            });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/item');

        // First route should win
        expect(result.text()).toBe('Exact Match');
    });

    it('should respect route definition order', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/users/admin', (ctx, res) => {
                return res.html('Admin User');
            })
            .addRoute('/users/:userId', (ctx, res) => {
                return res.html(`User ${ctx.pathParams?.userId}`);
            });

        const visitor = browse(lambder);
        
        // Should match specific route first
        const adminResult = await visitor.request('GET', '/users/admin');
        expect(adminResult.text()).toBe('Admin User');

        // Should match parameterized route
        const userResult = await visitor.request('GET', '/users/123');
        expect(userResult.text()).toContain('User 123');
    });
});

describe('Routes - Wildcard and Catch-all Routes', () => {
    it('should support wildcard routes', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/(.*)', (ctx, res) => {
                return res.html('Catch All');
            });

        const visitor = browse(lambder);
        
        const result1 = await visitor.request('GET', '/anything');
        expect(result1.text()).toBe('Catch All');

        const result2 = await visitor.request('GET', '/deeply/nested/path');
        expect(result2.text()).toBe('Catch All');
    });

    it('should use wildcard as final fallback', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/specific', (ctx, res) => {
                return res.html('Specific');
            })
            .addRoute('/(.*)', (ctx, res) => {
                return res.html('Fallback');
            });

        const visitor = browse(lambder);
        
        const specificResult = await visitor.request('GET', '/specific');
        expect(specificResult.text()).toBe('Specific');

        const fallbackResult = await visitor.request('GET', '/anything-else');
        expect(fallbackResult.text()).toBe('Fallback');
    });
});

describe('Routes - Method Filtering', () => {
    it('should match all HTTP methods when no method is specified', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .addRoute('/resource', (ctx, res) => {
                return res.html(`${ctx.method} Response`);
            });

        const visitor = browse(lambder);
        
        // GET should work
        const getResult = await visitor.request('GET', '/resource');
        expect(getResult.text()).toBe('GET Response');

        // POST should also work (no method restriction)
        const postResult = await visitor.request('POST', '/resource');
        expect(postResult.statusCode).toBe(200);
        expect(postResult.text()).toBe('POST Response');
    });
});
