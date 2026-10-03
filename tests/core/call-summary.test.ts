/**
 * Call summaries: one line per API call and per request a route answered,
 * written when it is answered, saying what was called, how it ended and how
 * long it took, with the ids that join it to the rest of the logs; and
 * nothing from the call's input, its path, session or caller.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { lambderGuard } from '../../src/core/LambderPolicyBuilders.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import { LambderMemoryRateLimiter } from '../../src/stores/LambderMemoryRateLimiter.js';
import { LambderMemoryIdempotencyStore } from '../../src/stores/LambderMemoryIdempotencyStore.js';
import { lambderTestApp } from '../../src/testing.js';
import { localLambdaContext, synthesizeLambdaHttpEvent, LAMBDER_PARENT_REQUEST_HEADER } from '../../src/invoke/LambderLambdaEvent.js';
import { runInvocation } from '../../src/core/LambderInvocationScope.js';
import type { LambderCallSummary } from '../../src/core/LambderCallSummary.js';
import { html } from '../../src/shared/LambderHtml.js';

type SessionData = { userId: string };

const createShop = (options: { callSummary?: false | ((summary: LambderCallSummary) => void) } = {}) => {
    const lambderInit = initLambder<SessionData>().declareRefusals({ 'order-closed': { status: 409 }, 'account-closed': { sessionExpired: true } });
    const app = lambderInit.create({
        apiPath: '/api',
        session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
        guards: { signedIn: lambderGuard({ session: true, handler: () => {} }) },
        rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: { oncePerMinute: { perMin: 1, per: 'ip' } } },
        idempotency: { store: new LambderMemoryIdempotencyStore() },
        ...options,
    });
    return app.registerApiGroups(app.defineApiGroup('order', {
        place: app.defineApi({
            input: z.object({ sku: z.string(), secretNote: z.string().optional() }),
            output: z.object({ orderId: z.string() }),
            refusals: 'order-closed',
        }, async (ctx) => {
            if(ctx.apiPayload.sku === 'closed') return ctx.refuse('Closed.', { code: 'order-closed' });
            if(ctx.apiPayload.sku === 'crash') throw new Error('the shelf fell over');
            return { orderId: `o-${ctx.apiPayload.sku}` };
        }),
        placeOnce: app.defineApi({ input: z.object({ sku: z.string() }), output: z.object({ orderId: z.string() }), idempotency: true }, async (ctx) => ({ orderId: `o-${ctx.apiPayload.sku}` })),
        mine: app.defineApi({ input: z.object({}), output: z.object({ userId: z.string() }), guards: 'signedIn' }, async (ctx) => ({ userId: ctx.session.data.userId })),
        limited: app.defineApi({ input: z.object({}), output: z.object({ ok: z.boolean() }), rateLimit: 'oncePerMinute' }, async () => ({ ok: true })),
        history: app.defineApi({ input: z.object({}), output: z.object({ ok: z.boolean() }), guards: 'signedIn', refusals: 'account-closed' }, async (ctx) => ctx.refuse('This account is closed.', { code: 'account-closed' })),
    })).addRoute({ path: '/page', method: 'GET' }, (_ctx, res) => res.html(html`<p>hello</p>`))
        .addRoute({ path: '/orders/:orderId/receipt', method: 'GET', name: 'receipt' }, (_ctx, res) => res.text('Your receipt.'))
        .addRoute(/^\/reports\/\d+$/, (_ctx, res) => res.text('A report.'))
        .addRoute((ctx) => ctx.path === '/by-predicate', (_ctx, res) => res.text('Matched.'))
        .addRoute({ path: '/shelf', method: 'GET' }, (_ctx, res) => res.text('No such shelf.', { statusCode: 404 }))
        .addRoute({ path: '/broken', method: 'GET' }, () => { throw new Error('the shelf fell over'); });
};

afterEach(() => { vi.restoreAllMocks(); });

describe('Call summaries: what a call records', () => {
    it('records a success: the endpoint, the status, both durations and the ids, and nothing of the input', async () => {
        const app = lambderTestApp(createShop());
        await app.visitor().api('order.place', { sku: 'apple', secretNote: 'leave at the door' });

        expect(app.callSummaries).toEqual([{
            kind: 'lambder.call',
            api: 'order.place',
            route: null,
            outcome: 'success',
            code: null,
            status: 200,
            durationMs: expect.any(Number),
            handlerMs: expect.any(Number),
            replayed: false,
            coldStart: expect.any(Boolean),
            requestId: expect.any(String),
            parentRequestId: null,
        }]);
        expect(JSON.stringify(app.callSummaries)).not.toContain('leave at the door');
        expect(app.callSummaries[0]!.durationMs).toBeGreaterThanOrEqual(app.callSummaries[0]!.handlerMs!);
    });

    it('names how a call that did not succeed ended, with the refusal\'s code', async () => {
        const app = lambderTestApp(createShop());
        const visitor = app.visitor();
        await visitor.apiOutcome('order.place', { sku: 'closed' });
        await visitor.apiOutcome('order.place', { sku: 42 as never });
        await visitor.apiOutcome('order.mine', {});
        await visitor.apiOutcome('order.limited', {});
        await visitor.apiOutcome('order.limited', {});
        await visitor.apiOutcome('order.place', { sku: 'crash' });
        await visitor.request('POST', '/api/order/unknown', { body: '{}', headers: { 'content-type': 'application/json' } });

        expect(app.callSummaries.map(({ api, outcome, code, status }) => ({ api, outcome, code, status }))).toEqual([
            { api: 'order.place', outcome: 'refusal', code: 'order-closed', status: 409 },
            { api: 'order.place', outcome: 'validation', code: null, status: 422 },
            { api: 'order.mine', outcome: 'sessionExpired', code: null, status: 200 },
            { api: 'order.limited', outcome: 'success', code: null, status: 200 },
            { api: 'order.limited', outcome: 'refusal', code: 'lambder/rate-limited', status: 429 },
            { api: 'order.place', outcome: 'crash', code: null, status: 500 },
            { api: 'order.unknown', outcome: 'refusal', code: 'lambder/api-not-found', status: 200 },
        ]);
        // Refused before the handler ran: no handler time.
        expect(app.callSummaries[2]!.handlerMs).toBeNull();
        expect(app.crashes).toHaveLength(1);
    });

    it('records the code of a declared refusal that ends the session, as it does a notAuthorized one\'s', async () => {
        const app = lambderTestApp(createShop());
        const member = await app.signIn('u1', { userId: 'u1' });
        await member.apiOutcome('order.history', {});

        expect(app.callSummaries.map(({ api, outcome, code }) => ({ api, outcome, code }))).toEqual([
            { api: 'order.history', outcome: 'sessionExpired', code: 'account-closed' },
        ]);
    });

    it('records a replayed idempotent answer as the answer it replays, with no handler time', async () => {
        const app = lambderTestApp(createShop());
        const visitor = app.visitor();
        const idempotencyKey = 'key-0123456789abcdef';
        await visitor.api('order.placeOnce', { sku: 'apple' }, { idempotencyKey });
        await visitor.api('order.placeOnce', { sku: 'apple' }, { idempotencyKey });

        expect(app.callSummaries.map(({ outcome, replayed, handlerMs }) => ({ outcome, replayed, handled: handlerMs !== null }))).toEqual([
            { outcome: 'success', replayed: false, handled: true },
            { outcome: 'success', replayed: true, handled: false },
        ]);
    });

    it('records a request a route answered: the route as registered, never the path asked for, with its status and the handler\'s time', async () => {
        const app = lambderTestApp(createShop());
        await app.visitor().request('GET', '/orders/o-apple/receipt?note=leave%20at%20the%20door');

        expect(app.callSummaries).toEqual([{
            kind: 'lambder.call',
            api: null,
            route: 'receipt',
            outcome: 'success',
            code: null,
            status: 200,
            durationMs: expect.any(Number),
            handlerMs: expect.any(Number),
            replayed: false,
            coldStart: expect.any(Boolean),
            requestId: expect.any(String),
            parentRequestId: null,
        }]);
        expect(JSON.stringify(app.callSummaries)).not.toContain('o-apple');
    });

    it('names a route by its matcher\'s name, else by its method and path pattern or the pattern alone, and a bare predicate not at all', async () => {
        const app = lambderTestApp(createShop());
        const visitor = app.visitor();
        await visitor.request('GET', '/page');
        await visitor.request('GET', '/reports/7');
        await visitor.request('GET', '/by-predicate');

        expect(app.callSummaries.map(({ api, route }) => ({ api, route }))).toEqual([
            { api: null, route: 'GET /page' },
            { api: null, route: '/^\\/reports\\/\\d+$/' },
            { api: null, route: null },
        ]);
    });

    it('reads a route\'s outcome from its status: other for the 4xx it answered, crash when it threw', async () => {
        const app = lambderTestApp(createShop());
        const visitor = app.visitor();
        await visitor.request('GET', '/shelf');
        await visitor.request('GET', '/broken');

        expect(app.callSummaries.map(({ route, outcome, status, handlerMs }) => ({ route, outcome, status, handled: handlerMs !== null }))).toEqual([
            { route: 'GET /shelf', outcome: 'other', status: 404, handled: true },
            { route: 'GET /broken', outcome: 'crash', status: 500, handled: true },
        ]);
        expect(app.crashes).toHaveLength(1);
    });

    it('writes no summary for a request nothing registered answered', async () => {
        const app = lambderTestApp(createShop());
        await app.visitor().request('GET', '/nowhere');
        expect(app.callSummaries).toEqual([]);
    });

    it('records a call that crashed before its context was read, as when a created hook failed', async () => {
        // The crash every call meets while the app cannot start: without its
        // line, a count of crashes by endpoint would read as calls stopping.
        const app = lambderTestApp(createShop().addHook('created', async () => { throw new Error('secrets unreachable'); }));
        const visitor = app.visitor();
        await visitor.apiOutcome('order.place', { sku: 'apple' });
        await visitor.request('GET', '/page');

        expect(app.callSummaries).toEqual([expect.objectContaining({ api: 'order.place', outcome: 'crash', code: null, status: 500, handlerMs: null })]);
    });
});

describe('Call summaries: where they go', () => {
    it('writes each as one JSON line on stdout by default', async () => {
        const writes: string[] = [];
        vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { writes.push(String(chunk)); return true; }) as never);
        const shop = createShop();
        await shop.getHandler()(synthesizeLambdaHttpEvent({ method: 'POST', path: '/api/order/place', host: 'shop.example', body: JSON.stringify({ payload: { sku: 'apple' } }) }, { invoke: false }), localLambdaContext('shop'));

        const lines = writes.filter((line) => line.includes('lambder.call'));
        expect(lines).toHaveLength(1);
        expect(lines[0]!.endsWith('\n')).toBe(true);
        expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'lambder.call', api: 'order.place', outcome: 'success' });
    });

    it('hands each to a function when given one, and writes none when told false', async () => {
        const received: LambderCallSummary[] = [];
        const event = () => synthesizeLambdaHttpEvent({ method: 'POST', path: '/api/order/place', host: 'shop.example', body: JSON.stringify({ payload: { sku: 'apple' } }) }, { invoke: false });
        await createShop({ callSummary: (summary) => { received.push(summary); } }).getHandler()(event(), localLambdaContext('shop'));
        expect(received.map(({ api }) => api)).toEqual(['order.place']);

        const write = vi.spyOn(process.stdout, 'write');
        await createShop({ callSummary: false }).getHandler()(event(), localLambdaContext('shop'));
        expect(write.mock.calls.filter(([chunk]) => String(chunk).includes('lambder.call'))).toEqual([]);
    });

    it('answers the call whatever the writer does, and says the line was lost', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const shop = createShop({ callSummary: () => { throw new Error('the log shipper is down'); } });
        const response = await shop.getHandler()(synthesizeLambdaHttpEvent({ method: 'POST', path: '/api/order/place', host: 'shop.example', body: JSON.stringify({ payload: { sku: 'apple' } }) }, { invoke: false }), localLambdaContext('shop'));

        expect(response.statusCode).toBe(200);
        expect(error.mock.calls.flat().join(' ')).toMatch(/the callSummary writer threw, so the summary of "order\.place" was not written/);
    });

    it('rejects a callSummary that is neither false nor a function', () => {
        // @ts-expect-error callSummary is false or a function
        expect(() => createShop({ callSummary: true })).toThrow(/callSummary is false, or a function/);
    });
});

describe('Call summaries: the invocation that invoked this one', () => {
    it('carries the calling invocation\'s request id on an invoke, which the callee records as its parent', async () => {
        const received: LambderCallSummary[] = [];
        const shop = createShop({ callSummary: (summary) => { received.push(summary); } });
        // A function calling the shop over invoke builds the event inside its
        // own invocation, whose request id the event carries.
        const event = await runInvocation(localLambdaContext('storefront', { awsRequestId: 'caller-request-1' }), async () =>
            synthesizeLambdaHttpEvent({ method: 'POST', path: '/api/order/place', host: 'shop.example', body: JSON.stringify({ payload: { sku: 'apple' } }) }, { invoke: true }));
        expect(event.headers?.[LAMBDER_PARENT_REQUEST_HEADER]).toBe('caller-request-1');

        await shop.getHandler()(event, localLambdaContext('shop', { awsRequestId: 'shop-request-1' }));
        expect(received[0]).toMatchObject({ requestId: 'shop-request-1', parentRequestId: 'caller-request-1' });
    });

    it('ignores the header on a request that did not come by invoke, where a client writes it', async () => {
        const received: LambderCallSummary[] = [];
        const shop = createShop({ callSummary: (summary) => { received.push(summary); } });
        const event = synthesizeLambdaHttpEvent({ method: 'POST', path: '/api/order/place', host: 'shop.example', body: JSON.stringify({ payload: { sku: 'apple' } }) }, { invoke: false });
        event.headers![LAMBDER_PARENT_REQUEST_HEADER] = 'made-up';

        await shop.getHandler()(event, localLambdaContext('shop'));
        expect(received[0]!.parentRequestId).toBeNull();
    });
});
