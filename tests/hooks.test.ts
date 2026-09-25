/**
 * The hook lifecycle: beforeRender (every request, including the ones the
 * fallback chain answers), afterRender, fallback and created, their priority
 * ordering and what each one may do to a context or a response.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { browse, testPublicFiles } from './helpers.js';
import { z } from 'zod';
import Lambder from '../src/core/Lambder.js';
import type { LambderResponse } from '../src/core/LambderResponse.js';
import { LambderLocalFileSource } from '../src/stores/LambderLocalFileSource.js';
import type { LambderRenderContext } from '../src/core/LambderContext.js';



describe('Hooks - beforeRender Hook', () => {
    it('should execute beforeRender hook before route handler', async () => {
        const executionOrder: string[] = [];

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push('beforeRender');
            return ctx;
        });

        lambder.addRoute('/test', (ctx, res) => {
            executionOrder.push('routeHandler');
            return res.html('Test');
        });

        const visitor = browse(lambder);
        await visitor.request('GET', '/test');

        expect(executionOrder).toEqual(['beforeRender', 'routeHandler']);
    });

    it('should allow context modification in beforeRender', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            // Add custom property to context
            (ctx as any).customData = 'modified';
            return ctx;
        });

        lambder.addRoute('/test', (ctx, res) => {
            return res.json({ data: (ctx as any).customData });
        });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/test');

        const body = (result.json() as Record<string, any>);
        expect(body.data).toBe('modified');
    });

    it('should execute multiple beforeRender hooks', async () => {
        const executionOrder: number[] = [];

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push(1);
            return ctx;
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push(2);
            return ctx;
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push(3);
            return ctx;
        });

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        const visitor = browse(lambder);
        await visitor.request('GET', '/test');

        expect(executionOrder).toEqual([1, 2, 3]);
    });

    it('should stop execution if beforeRender returns Error', async () => {
        let routeHandlerCalled = false;

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.raw({ statusCode: 403, body: err.message });
            });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            return new Error('Access Denied');
        });

        lambder.addRoute('/test', (ctx, res) => {
            routeHandlerCalled = true;
            return res.html('Test');
        });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/test');

        expect(result.statusCode).toBe(403);
        expect(result.text()).toBe('Access Denied');
        expect(routeHandlerCalled).toBe(false);
    });
});

describe('Hooks - afterRender Hook', () => {
    it('should execute afterRender hook after route handler', async () => {
        const executionOrder: string[] = [];

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        lambder.addRoute('/test', (ctx, res) => {
            executionOrder.push('routeHandler');
            return res.html('Test');
        });

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push('afterRender');
            return response;
        });

        const visitor = browse(lambder);
        await visitor.request('GET', '/test');

        expect(executionOrder).toEqual(['routeHandler', 'afterRender']);
    });

    it('should allow response modification in afterRender', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        lambder.addRoute('/test', (ctx, res) => {
            return res.json({ original: true });
        });

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            // Modify response body
            const body = JSON.parse(String(response.body || '{}'));
            body.modified = true;
            response.body = JSON.stringify(body);
            return response;
        });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/test');

        const body = (result.json() as Record<string, any>);
        expect(body.original).toBe(true);
        expect(body.modified).toBe(true);
    });

    it('should execute multiple afterRender hooks', async () => {
        const executionOrder: number[] = [];

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push(1);
            return response;
        });

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push(2);
            return response;
        });

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push(3);
            return response;
        });

        const visitor = browse(lambder);
        await visitor.request('GET', '/test');

        expect(executionOrder).toEqual([1, 2, 3]);
    });

    it('copies a response a hook answers with before the next hook writes into it, so a kept one collects nothing across requests', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });
        lambder.addRoute('/test', (ctx, res) => res.json({ data: 'test' }));

        // A module-level answer, the way a maintenance page or a 404 is kept.
        let kept: LambderResponse | undefined;
        await lambder.addHook('afterRender', async (ctx, res) => {
            kept ??= res.html('kept');
            return kept;
        });
        await lambder.addHook('afterRender', async (ctx, res, response) => {
            response.setHeader('X-Request', ctx.get.n ?? '');
            return response;
        });

        const visitor = browse(lambder);
        expect((await visitor.request('GET', '/test?n=1')).headers['x-request']).toBe('1');
        expect((await visitor.request('GET', '/test?n=2')).headers['x-request']).toBe('2');
        expect(Object.keys(kept!.headers).map((name) => name.toLowerCase())).not.toContain('x-request');
    });

    it('should add custom headers in afterRender', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        lambder.addRoute('/test', (ctx, res) => res.json({ data: 'test' }));

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            response.setHeader('X-Custom-Header', 'CustomValue');
            return response;
        });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/test');

        expect(result.headers['x-custom-header']).toBe('CustomValue');
    });

    it('should stop execution if afterRender returns Error', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.raw({ statusCode: 500, body: `Error: ${err.message}` });
            });

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            return new Error('Post-processing failed');
        });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/test');

        expect(result.statusCode).toBe(500);
        expect(result.text()).toContain('Post-processing failed');
    });

    it('is handed the context a beforeRender hook replaced, on a matched route and on the fallback chain', async () => {
        // Regression: the replacement reached the handler alone, and the
        // afterRender hooks read the context as it arrived, without what the
        // beforeRender hook added.
        const seenTenants: (string | undefined)[] = [];
        const lambder = new Lambder({ files: new LambderLocalFileSource({ root: path.resolve('./tests/fixtures/public') }) })
            .servePublicFiles()
            .addRoute('/test', (ctx, res) => res.text('Test'))
            .addHook('beforeRender', async (ctx) => {
                const replaced: LambderRenderContext & { tenant: string } = { ...ctx, tenant: 'acme' };
                return replaced;
            })
            .addHook('afterRender', async (ctx, res, response) => {
                seenTenants.push((ctx as LambderRenderContext & { tenant?: string }).tenant);
                return response;
            });
        const visitor = browse(lambder);

        expect((await visitor.request('GET', '/test')).text()).toBe('Test');
        expect((await visitor.request('GET', '/main.css')).statusCode).toBe(200);
        expect(seenTenants).toEqual(['acme', 'acme']);
    });
});

describe('Hooks - fallback Hook', () => {
    it('should execute fallback hook when no route matches', async () => {
        let fallbackCalled = false;

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        lambder.addRoute('/exists', (ctx, res) => res.html('Exists'));

        await lambder.addHook('fallback', async (ctx, res) => {
            fallbackCalled = true;
        });

        lambder.setRouteFallbackHandler((ctx, res) => {
            return res.status404('Not Found');
        });

        const visitor = browse(lambder);
        await visitor.request('GET', '/nonexistent');

        expect(fallbackCalled).toBe(true);
    });

    it('should execute multiple fallback hooks', async () => {
        const executionOrder: number[] = [];

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        await lambder.addHook('fallback', async (ctx, res) => {
            executionOrder.push(1);
        });

        await lambder.addHook('fallback', async (ctx, res) => {
            executionOrder.push(2);
        });

        lambder.setRouteFallbackHandler((ctx, res) => res.status404('Not Found'));

        const visitor = browse(lambder);
        await visitor.request('GET', '/nonexistent');

        expect(executionOrder).toEqual([1, 2]);
    });

    it('should not execute fallback hook when route matches', async () => {
        let fallbackCalled = false;

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        await lambder.addHook('fallback', async (ctx, res) => {
            fallbackCalled = true;
        });

        const visitor = browse(lambder);
        await visitor.request('GET', '/test');

        expect(fallbackCalled).toBe(false);
    });
});

describe('Hooks - created Hook', () => {
    it('should execute created hook lazily at first render', async () => {
        let createdCalled = false;
        let lambderInstance: Lambder | null = null;

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        lambder.addHook('created', async (instance) => {
            createdCalled = true;
            lambderInstance = instance;
        });

        // Lazy: runs once at the first render, keeping addHook chainable.
        expect(createdCalled).toBe(false);

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));
        const visitor = browse(lambder);
        await visitor.request('GET', '/test');

        expect(createdCalled).toBe(true);
        expect(lambderInstance).toBe(lambder);
    });

    it('should allow configuration in created hook', async () => {
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        lambder.addHook('created', async (instance) => {
            instance.addRoute('/from-created', (ctx, res) => res.html('Configured'));
        });

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/from-created');
        expect(result.text()).toBe('Configured');
    });

    /**
     * A created hook reaches something that can be briefly unavailable: a
     * first DynamoDB read, a secret fetch, a warm-up call. Keeping a failed
     * run's promise would answer every later invocation on that warm
     * container with the first error, and only a cold start would recover.
     */
    it('retries the created hooks after one of them fails', async () => {
        let attempts = 0;
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addRoute('/test', (ctx, res) => res.html('Ready'))
            .setGlobalErrorHandler((err, ctx, res) => res.status(500, err.message));

        lambder.addHook('created', async () => {
            attempts += 1;
            if(attempts === 1) throw new Error('the secret store was not there yet');
        });

        const visitor = browse(lambder);
        const failed = await visitor.request('GET', '/test');
        expect(failed.statusCode).toBe(500);
        expect(failed.text()).toContain('the secret store was not there yet');

        const recovered = await visitor.request('GET', '/test');
        expect(recovered.text()).toBe('Ready');
        expect(attempts).toBe(2);

        // And a hook that has succeeded still runs only once.
        await visitor.request('GET', '/test');
        expect(attempts).toBe(2);
    });
});

describe('Hooks - Priority Ordering', () => {
    it('should execute beforeRender hooks in priority order', async () => {
        const executionOrder: number[] = [];

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push(20);
            return ctx;
        }, 20);

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push(10);
            return ctx;
        }, 10);

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push(30);
            return ctx;
        }, 30);

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        const visitor = browse(lambder);
        await visitor.request('GET', '/test');

        // Should execute in priority order: 10, 20, 30
        expect(executionOrder).toEqual([10, 20, 30]);
    });

    it('should execute afterRender hooks in priority order', async () => {
        const executionOrder: number[] = [];

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push(50);
            return response;
        }, 50);

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push(5);
            return response;
        }, 5);

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push(25);
            return response;
        }, 25);

        const visitor = browse(lambder);
        await visitor.request('GET', '/test');

        expect(executionOrder).toEqual([5, 25, 50]);
    });

    it('should use priority 0 as default', async () => {
        const executionOrder: string[] = [];

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push('no-priority');
            return ctx;
        }); // No priority specified, defaults to 0

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push('negative');
            return ctx;
        }, -10);

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push('positive');
            return ctx;
        }, 10);

        lambder.addRoute('/test', (ctx, res) => res.html('Test'));

        const visitor = browse(lambder);
        await visitor.request('GET', '/test');

        expect(executionOrder).toEqual(['negative', 'no-priority', 'positive']);
    });
});

describe('Hooks - Combined Workflow', () => {
    it('should execute hooks in correct order: beforeRender -> handler -> afterRender', async () => {
        const executionOrder: string[] = [];

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push('before-1');
            return ctx;
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push('before-2');
            return ctx;
        });

        lambder.addRoute('/test', (ctx, res) => {
            executionOrder.push('handler');
            return res.html('Test');
        });

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push('after-1');
            return response;
        });

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push('after-2');
            return response;
        });

        const visitor = browse(lambder);
        await visitor.request('GET', '/test');

        expect(executionOrder).toEqual([
            'before-1',
            'before-2',
            'handler',
            'after-1',
            'after-2'
        ]);
    });

    it('should work with API handlers', async () => {
        const executionOrder: string[] = [];

        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api'
        });

        await lambder.addHook('beforeRender', async (ctx, res) => {
            executionOrder.push('beforeRender');
            return ctx;
        });

        lambder.addApi('testApi', {
            input: z.object({ value: z.string() }),
            output: z.object({ result: z.string() })
        }, async (ctx, res) => {
            executionOrder.push('apiHandler');
            return res.api({ result: ctx.apiPayload.value });
        });

        await lambder.addHook('afterRender', async (ctx, res, response) => {
            executionOrder.push('afterRender');
            return response;
        });

        await browse(lambder).api('testApi', { value: 'test' });

        expect(executionOrder).toEqual(['beforeRender', 'apiHandler', 'afterRender']);
    });
});

describe('Hooks - beforeRender on the fallback chain', () => {
    /**
     * beforeRender runs for every request, not only a matched route or API.
     * A servePublicFiles asset and a serveIndexHtml shell are the 200s a
     * frontend is made of, and they need the one hook that can inspect a
     * request, replace its context or answer in its place.
     */
    const buildApp = () => new Lambder({
        files: new LambderLocalFileSource({ root: path.resolve('./tests/fixtures/public') }),
        apiPath: '/api',
    })
        .servePublicFiles()
        .serveIndexHtml();

    it('runs for a servePublicFiles answer and a serveIndexHtml answer, and its headers reach both', async () => {
        const seen: string[] = [];
        const lambder = buildApp()
            .addRoute('/route', (ctx, res) => res.text('route'))
            .addHook('beforeRender', async (ctx, res) => {
                seen.push(ctx.path);
                res.setHeader('Content-Security-Policy', "default-src 'self'");
                return ctx;
            });
        const visitor = browse(lambder);

        const asset = await visitor.request('GET', '/main.css');
        expect(asset.statusCode).toBe(200);
        expect(asset.text()).toContain('body { margin: 0; }');
        expect(asset.headers['content-security-policy']).toBe("default-src 'self'");

        const shell = await visitor.request('GET', '/some/app/page');
        expect(shell.statusCode).toBe(200);
        expect(shell.text()).toContain('<h1>Test HTML</h1>');
        expect(shell.headers['content-security-policy']).toBe("default-src 'self'");

        const route = await visitor.request('GET', '/route');
        expect(route.headers['content-security-policy']).toBe("default-src 'self'");

        expect(seen).toEqual(['/main.css', '/some/app/page', '/route']);
    });

    it('can short-circuit an asset and a shell, the way a maintenance-mode hook has to', async () => {
        const lambder = buildApp()
            .addHook('beforeRender', async (ctx, res) => res.text('maintenance', { statusCode: 503 }));
        const visitor = browse(lambder);

        for(const requestPath of ['/main.css', '/some/app/page']){
            const result = await visitor.request('GET', requestPath);
            expect(result.statusCode).toBe(503);
            expect(result.text()).toBe('maintenance');
        }
    });

    it('still has pathParams populated when it runs for a matched route', async () => {
        let seenParams: Record<string, string> | null = null;
        const lambder = buildApp()
            .addRoute('/user/:userId', (ctx, res) => res.text(ctx.pathParams.userId ?? ''))
            .addHook('beforeRender', async (ctx) => { seenParams = { ...ctx.pathParams }; return ctx; });

        const result = await browse(lambder).request('GET', '/user/u-7');

        expect(result.text()).toBe('u-7');
        expect(seenParams).toEqual({ userId: 'u-7' });
    });

    it('runs before the fallback hooks, which still cannot answer', async () => {
        const order: string[] = [];
        const lambder = buildApp()
            .addHook('beforeRender', async (ctx) => { order.push('beforeRender'); return ctx; })
            .addHook('fallback', async () => { order.push('fallback'); });

        await browse(lambder).request('GET', '/main.css');

        expect(order).toEqual(['beforeRender', 'fallback']);
    });
});
