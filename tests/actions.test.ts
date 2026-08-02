/**
 * addAction: unified handlers filtering on the raw Lambda event or the HTTP context; the only handler kind for non-HTTP invocations.
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../src/Lambder.js';
import { decodeBody, createMockEvent, createMockContext } from './helpers.js';
describe('Actions (addAction: raw event or context filtering)', () => {
    const sourceIs = (source: string) => (event: unknown) =>
        (event as { source?: string } | null)?.source === source;

    it('dispatches non-HTTP events, first match wins', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/page', (ctx, res) => res.html('http'))
            .addAction(sourceIs('app.reconciliation'), async (event) => ({ reconciled: true, id: (event as any).id }))
            .addAction(() => true, async () => 'catch-all');

        const handler = lambder.getHandler();
        expect(await handler({ source: 'app.reconciliation', id: 'evt-1' }, createMockContext())).toEqual({ reconciled: true, id: 'evt-1' });
        expect(await handler({ source: 'anything.else' }, createMockContext())).toBe('catch-all');
    });

    it('supports type-guard filters for typed events', async () => {
        type SqsLikeEvent = { Records: { eventSource: string, body: string }[] };
        const isSqsEvent = (event: unknown): event is SqsLikeEvent =>
            !!event && typeof event === 'object' && Array.isArray((event as any).Records)
            && (event as any).Records[0]?.eventSource === 'aws:sqs';

        const lambder = new Lambder({ publicPath: './public' })
            .addAction(isSqsEvent, async (event) => event.Records.map((r) => r.body));

        const handler = lambder.getHandler();
        const result = await handler({ Records: [{ eventSource: 'aws:sqs', body: 'msg' }] }, createMockContext());
        expect(result).toEqual(['msg']);
    });

    it('non-HTTP invocations get null ctx/res in tools', async () => {
        let seenTools: any = null;
        const lambder = new Lambder({ publicPath: './public' })
            .addAction(() => true, async (event, tools) => { seenTools = tools; return 'ok'; });

        await lambder.getHandler()({ source: 'x' }, createMockContext());
        expect(seenTools.ctx).toBeNull();
        expect(seenTools.res).toBeNull();
        expect(seenTools.lambdaContext.functionName).toBe('test');
    });

    it('can intercept HTTP requests by filtering on ctx', async () => {
        let handlerRan = false;
        const lambder = new Lambder({ publicPath: './public' })
            .addAction(
                (event, ctx) => ctx !== null && ctx.host === 'dev.example.com' && ctx.cookie.dev !== 'atlas',
                async (event, { res }) => res!.status404('Not found'),
            )
            .addRoute('/page', (ctx, res) => { handlerRan = true; return res.html('secret'); });

        const blocked = await lambder.render(
            createMockEvent('/page', { headers: { Host: 'dev.example.com' } }),
            createMockContext(),
        );
        expect(blocked.statusCode).toBe(404);
        expect(handlerRan).toBe(false);

        const allowed = await lambder.render(createMockEvent('/page'), createMockContext());
        expect(decodeBody(allowed)).toBe('secret');
    });

    it('joins the same first-match chain as routes, in registration order', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/page', (ctx, res) => res.html('route wins'))
            .addAction((event, ctx) => ctx !== null && ctx.path === '/page', async (event, { res }) => res!.html('action'));

        const result = await lambder.render(createMockEvent('/page'), createMockContext());
        expect(decodeBody(result)).toBe('route wins');
    });

    it('errors when an HTTP-matched action does not return a response', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .setGlobalErrorHandler((err, ctx, res) => res.status(500, err.message))
            .addAction((event, ctx) => ctx !== null && ctx.path === '/oops', async () => ({ not: 'a response' }));

        const result = await lambder.render(createMockEvent('/oops'), createMockContext());
        expect(result.statusCode).toBe(500);
        expect(decodeBody(result)).toContain('did not return a response');
    });

    it('still routes HTTP events normally when no action filter matches', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addAction((event, ctx) => ctx === null, async () => 'event only')
            .addRoute('/page', (ctx, res) => res.html('http'));

        const handler = lambder.getHandler();
        const result = await handler(createMockEvent('/page'), createMockContext());
        expect(decodeBody(result as any)).toBe('http');
    });

    it('throws a descriptive error for unmatched non-HTTP events', async () => {
        const lambder = new Lambder({ publicPath: './public' });
        await expect(lambder.getHandler()({ source: 'unknown.source' }, createMockContext()))
            .rejects.toThrow(/no action matched.*unknown\.source/);
    });

    it('rethrows action errors for Lambda-native retry/DLQ semantics', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .setGlobalErrorHandler((err, ctx, res) => res.status(500, 'should not be used for events'))
            .addAction(sourceIs('app.fails'), async () => { throw new Error('job failed'); });

        await expect(lambder.getHandler()({ source: 'app.fails' }, createMockContext())).rejects.toThrow('job failed');
    });
});

