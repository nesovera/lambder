/**
 * addAction: unified handlers filtering on the raw Lambda event or the HTTP context; the only handler kind for non-HTTP invocations.
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../src/core/Lambder.js';
import { browse, testPublicFiles } from './helpers.js';
import { lambderTestApp } from '../src/testing.js';
describe('Actions (addAction: raw event or context filtering)', () => {
    const sourceIs = (source: string) => (event: unknown) =>
        (event as { source?: string } | null)?.source === source;

    it('dispatches non-HTTP events, first match wins', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute('/page', (ctx, res) => res.html('http'))
            .addAction(sourceIs('app.reconciliation'), async (event) => ({ reconciled: true, id: (event as any).id }))
            .addAction(() => true, async () => 'catch-all');

        const app = lambderTestApp(lambder);
        expect(await app.event({ source: 'app.reconciliation', id: 'evt-1' })).toEqual({ reconciled: true, id: 'evt-1' });
        expect(await app.event({ source: 'anything.else' })).toBe('catch-all');
    });

    it('supports type-guard filters for typed events', async () => {
        type SqsLikeEvent = { Records: { eventSource: string, body: string }[] };
        const isSqsEvent = (event: unknown): event is SqsLikeEvent =>
            !!event && typeof event === 'object' && Array.isArray((event as any).Records)
            && (event as any).Records[0]?.eventSource === 'aws:sqs';

        const lambder = new Lambder({ files: testPublicFiles() })
            .addAction(isSqsEvent, async (event) => event.Records.map((r) => r.body));

        const result = await lambderTestApp(lambder).event({ Records: [{ eventSource: 'aws:sqs', body: 'msg' }] });
        expect(result).toEqual(['msg']);
    });

    it('non-HTTP invocations get null ctx/res in tools', async () => {
        let seenTools: any = null;
        const lambder = new Lambder({ files: testPublicFiles() })
            .addAction(() => true, async (event, tools) => { seenTools = tools; return 'ok'; });

        await lambderTestApp(lambder).event({ source: 'x' }, { functionName: 'nightly' });
        expect(seenTools.ctx).toBeNull();
        expect(seenTools.res).toBeNull();
        expect(seenTools.lambdaContext.functionName).toBe('nightly');
    });

    it('can intercept HTTP requests by filtering on ctx', async () => {
        let handlerRan = false;
        const lambder = new Lambder({ files: testPublicFiles() })
            .addAction(
                (event, ctx) => ctx !== null && ctx.host === 'dev.example.com' && ctx.cookie.dev !== 'atlas',
                async (event, { res }) => res!.status404('Not found'),
            )
            .addRoute('/page', (ctx, res) => { handlerRan = true; return res.html('secret'); });

        const blocked = await browse(lambder, { host: 'dev.example.com' }).request('GET', '/page');
        expect(blocked.statusCode).toBe(404);
        expect(handlerRan).toBe(false);

        const allowed = await browse(lambder).request('GET', '/page');
        expect(allowed.text()).toBe('secret');
    });

    it('joins the same first-match chain as routes, in registration order', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute('/page', (ctx, res) => res.html('route wins'))
            .addAction((event, ctx) => ctx !== null && ctx.path === '/page', async (event, { res }) => res!.html('action'));

        const result = await browse(lambder).request('GET', '/page');
        expect(result.text()).toBe('route wins');
    });

    it('errors when an HTTP-matched action does not return a response', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .setGlobalErrorHandler((err, ctx, res) => res.status(500, err.message))
            .addAction((event, ctx) => ctx !== null && ctx.path === '/oops', async () => ({ not: 'a response' }));

        const result = await browse(lambder).request('GET', '/oops');
        expect(result.statusCode).toBe(500);
        expect(result.text()).toContain('did not return a response');
    });

    it('still routes HTTP events normally when no action filter matches', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addAction((event, ctx) => ctx === null, async () => 'event only')
            .addRoute('/page', (ctx, res) => res.html('http'));

        const visitor = browse(lambder);
        const result = await visitor.request('GET', '/page');
        expect(result.text()).toBe('http');
    });

    it('throws a descriptive error for unmatched non-HTTP events', async () => {
        const lambder = new Lambder({ files: testPublicFiles() });
        await expect(lambderTestApp(lambder).event({ source: 'unknown.source' }))
            .rejects.toThrow(/no action matched.*unknown\.source/);
    });

    it('rethrows action errors for Lambda-native retry/DLQ semantics', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .setGlobalErrorHandler((err, ctx, res) => res.status(500, 'should not be used for events'))
            .addAction(sourceIs('app.fails'), async () => { throw new Error('job failed'); });

        await expect(lambderTestApp(lambder).event({ source: 'app.fails' })).rejects.toThrow('job failed');
    });
});

