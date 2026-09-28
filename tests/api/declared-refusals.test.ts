/**
 * Declared refusals: an app's refusal vocabulary at creation, the codes each
 * API and each guard names from it, the typed ctx.refuse that raises them,
 * the data parsed through a code's schema before it is sent, the contract
 * that records every code an endpoint can refuse with, and a caller that
 * narrows on them. A refusal outside its endpoint's declaration is a crash,
 * never an answer, which is what makes the caller's narrowing exact.
 */

import { describe, it, expect, expectTypeOf, vi, afterEach } from 'vitest';
import { z } from 'zod';
import Lambder, { initLambder } from '../../src/core/Lambder.js';
import { lambderGuard } from '../../src/core/LambderPolicyBuilders.js';
import type { LambderDeclaredRefuseOptions } from '../../src/shared/wire/LambderApiRefusal.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import { LambderMemoryRateLimiter } from '../../src/stores/LambderMemoryRateLimiter.js';
import { lambderTestApp, assertApiFailure, assertApiRefusal, assertApiSuccess } from '../../src/testing.js';
import { refuse, LAMBDER_REFUSAL_CODES, type LambderRefusalMessage } from '../../src/shared/wire/LambderApiRefusal.js';
import type { LambderContractAnyRefusalMessage, LambderContractRefusalMessage } from '../../src/shared/wire/LambderApiContract.js';
import LambderCaller from '../../src/client/LambderCaller.js';

type SessionData = { userId: string; role: 'clerk' | 'manager' };

const lambderInit = initLambder<SessionData>().declareRefusals({
    'order-closed': { status: 409 },
    'wallet-short': { data: z.object({ available: z.number(), currency: z.string().default('USD') }) },
    'not-a-manager': { notAuthorized: true, status: 403 },
    'price-changed': { data: z.object({ cents: z.number().transform((cents) => cents / 100) }) },
});

// The init's guard builder types ctx.refuse to the guard's own codes.
const managerOnly = lambderInit.guard({
    session: true,
    refusals: ['not-a-manager'],
    handler: (ctx) => {
        if(ctx.session.data.role !== 'manager') ctx.refuse('Managers only.', { code: 'not-a-manager' });
    },
});

const createStore = () => lambderInit.create({
    apiPath: '/api',
    session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
    guards: { managerOnly },
})
    .addApi('order.pay', {
        input: z.object({ orderId: z.string(), amount: z.number() }),
        output: z.object({ paid: z.literal(true) }),
        refusals: ['order-closed', 'wallet-short'],
    }, async (ctx) => {
        if(ctx.apiPayload.orderId === 'closed') return ctx.refuse('This order is closed.', { code: 'order-closed' });
        if(ctx.apiPayload.amount > 100) return ctx.refuse('The wallet holds less than the total.', { code: 'wallet-short', data: { available: 100 } });
        if(ctx.apiPayload.orderId === 'plain') return ctx.refuse('Not today.');
        return { paid: true };
    })
    .addApi('order.quote', {
        input: z.object({ mode: z.enum(['changed', 'undeclared', 'bad-data', 'missing-data', 'stray-data', 'own-status', 'own-flag', 'helper']) }),
        output: z.object({ cents: z.number() }),
        refusals: 'price-changed',
    }, async (ctx) => {
        switch(ctx.apiPayload.mode){
            // Parsed through the code's schema: the transform runs once, on the way out.
            case 'changed': return ctx.refuse('The price changed.', { code: 'price-changed', data: { cents: 1250 } });
            case 'undeclared': return refuse('Closed.', { code: 'order-closed' });
            case 'bad-data': return refuse('Changed.', { code: 'price-changed', data: { cents: 'many' } });
            case 'missing-data': return refuse('Changed.', { code: 'price-changed' });
            case 'stray-data': return refuse('No.', { data: { anything: true } });
            // The declaration owns a code's status and flag; a raise site that sets one is checked where it is rendered.
            case 'own-status': return refuse('The price changed.', { code: 'price-changed', data: { cents: 1 }, statusCode: 404 });
            case 'own-flag': return refuse('The price changed.', { code: 'price-changed', data: { cents: 1 }, notAuthorized: true });
            // A shared helper with nothing of the request in hand still
            // raises a declared code, checked where it is rendered.
            case 'helper': return requirePrice();
        }
    })
    .addSessionApi('order.refund', {
        input: z.object({ orderId: z.string() }),
        output: z.object({ refunded: z.literal(true) }),
        guards: 'managerOnly',
        refusals: 'order-closed',
    }, async (ctx) => {
        if(ctx.apiPayload.orderId === 'closed') return ctx.refuse('This order is closed.', { code: 'order-closed' });
        return { refunded: true };
    })
    .addApi('order.peek', { input: z.object({}), output: z.object({ open: z.boolean() }) }, async (_ctx) => ({ open: true }));

const requirePrice = (): never => refuse('The price changed.', { code: 'price-changed', data: { cents: 99 } });

type Contract = ReturnType<typeof createStore>['ApiContract'];

afterEach(() => { vi.restoreAllMocks(); });

describe('Declared refusals: the contract', () => {
    it('records every code an endpoint can refuse with, its guards\' included, each with its data as it arrives', () => {
        expectTypeOf<Contract['order.pay']['refusals']>().toEqualTypeOf<{
            'order-closed': {};
            'wallet-short': { data: { available: number; currency: string } };
        }>();
        expectTypeOf<Contract['order.quote']['refusals']>().toEqualTypeOf<{ 'price-changed': { data: { cents: number } } }>();
        // The guard's code joins the endpoint's own.
        expectTypeOf<Contract['order.refund']['refusals']>().toEqualTypeOf<{ 'order-closed': {}; 'not-a-manager': {} }>();
        // An endpoint that declares none carries no member.
        expectTypeOf<keyof Contract['order.peek']>().toEqualTypeOf<'input' | 'output' | 'mode'>();
    });

    it('narrows a message on its code, so each code\'s data reads with its own type and a switch is exhaustive', () => {
        const describe = (message: LambderContractRefusalMessage<Contract, 'order.pay'>): string => {
            switch(message.code){
                case 'order-closed':
                    expectTypeOf(message.data).toEqualTypeOf<undefined>();
                    return 'closed';
                case 'wallet-short':
                    expectTypeOf(message.data).toEqualTypeOf<{ available: number; currency: string }>();
                    return `short by ${message.data.available}`;
                case undefined:
                    return message.content;
                default:
                    // The framework's own codes are the only others.
                    expectTypeOf(message.code).toEqualTypeOf<(typeof LAMBDER_REFUSAL_CODES)[keyof typeof LAMBDER_REFUSAL_CODES]>();
                    return message.content;
            }
        };
        expect(describe({ type: 'warning', code: 'wallet-short', content: 'Short.', data: { available: 1, currency: 'USD' } })).toBe('short by 1');
        // @ts-expect-error a code order.pay does not declare
        describe({ type: 'warning', code: 'not-a-manager', content: 'No.' });
    });

    it('types a handler for every endpoint at once with every code the contract declares, each once', () => {
        type Any = LambderContractAnyRefusalMessage<Contract>;
        expectTypeOf<Extract<Any, { code: 'wallet-short' }>['data']>().toEqualTypeOf<{ available: number; currency: string }>();
        expectTypeOf<Extract<Any, { code: 'not-a-manager' }>['data']>().toEqualTypeOf<undefined>();
        expectTypeOf<Exclude<Any, LambderRefusalMessage>['code']>().toEqualTypeOf<'order-closed' | 'wallet-short' | 'not-a-manager' | 'price-changed'>();
    });
});

describe('Declared refusals: raising one', () => {
    it('types ctx.refuse to the endpoint\'s codes, with data required where the code declares it and forbidden where it does not', () => {
        const store = initLambder().declareRefusals({ 'order-closed': {}, 'wallet-short': { data: z.object({ available: z.number() }) } }).create({ apiPath: '/api' });
        store.addApi('a', { input: z.object({}), output: z.object({}), refusals: ['order-closed', 'wallet-short'] }, async (ctx) => {
            // @ts-expect-error the code declares data, so it is required
            ctx.refuse('Short.', { code: 'wallet-short' });
            // @ts-expect-error the code declares no data
            ctx.refuse('Closed.', { code: 'order-closed', data: { available: 1 } });
            // @ts-expect-error the data is the code's own shape
            ctx.refuse('Short.', { code: 'wallet-short', data: { available: 'many' } });
            // @ts-expect-error a code of the vocabulary this API does not declare
            ctx.refuse('Nope.', { code: 'unknown-code' });
            // @ts-expect-error a declared code's status is its declaration's
            ctx.refuse('Closed.', { code: 'order-closed', statusCode: 404 });
            // @ts-expect-error and so is its flag
            ctx.refuse('Closed.', { code: 'order-closed', notAuthorized: true });
            // An uncoded refusal still chooses its own.
            ctx.refuse('Plain.', { statusCode: 404, notAuthorized: true });
            return ctx.refuse('Plain.');
        });
        store.addApi('b', { input: z.object({}), output: z.object({}) }, async (ctx) => {
            // @ts-expect-error an API with no refusals option raises no code
            ctx.refuse('Closed.', { code: 'order-closed' });
            return {};
        });
        // @ts-expect-error a code the vocabulary does not hold
        expect(() => store.addApi('c', { input: z.object({}), output: z.object({}), refusals: 'order-lost' }, async () => ({}))).toThrow(/order-lost/);
        // @ts-expect-error an empty list declares nothing
        expect(() => store.addApi('d', { input: z.object({}), output: z.object({}), refusals: [] }, async () => ({}))).toThrow(/empty refusals option/);
        expect(store).toBeDefined();
    });

    it('sends a declared code with its data parsed through the schema: defaults filled, transforms run, strays stripped', async () => {
        const visitor = lambderTestApp(createStore()).visitor();
        const short = await visitor.apiOutcome('order.pay', { orderId: 'o1', amount: 250 });
        assertApiRefusal(short, 'wallet-short');
        expectTypeOf(short.refusal.data).toEqualTypeOf<{ available: number; currency: string }>();
        expect(short.refusal).toEqual({ type: 'warning', code: 'wallet-short', content: 'The wallet holds less than the total.', data: { available: 100, currency: 'USD' } });
        expect(short.reason).toBe('refusal');

        const changed = await visitor.apiOutcome('order.quote', { mode: 'changed' });
        assertApiRefusal(changed, 'price-changed');
        expect(changed.refusal.data).toEqual({ cents: 12.5 });

        const closed = await visitor.apiOutcome('order.pay', { orderId: 'closed', amount: 1 });
        assertApiRefusal(closed, 'order-closed');
        expect(closed.refusal).toEqual({ type: 'warning', code: 'order-closed', content: 'This order is closed.' });
        // The declaration's status, not the raise site's.
        expect(closed.status).toBe(409);

        const plain = await visitor.apiOutcome('order.pay', { orderId: 'plain', amount: 1 });
        assertApiFailure(plain, 'refusal');
        expect(plain.refusal.code).toBeUndefined();

        assertApiSuccess(await visitor.apiOutcome('order.pay', { orderId: 'o2', amount: 1 }));
    });

    it('checks a code a shared helper raises with the free refuse() the same way', async () => {
        const outcome = await lambderTestApp(createStore()).visitor().apiOutcome('order.quote', { mode: 'helper' });
        assertApiRefusal(outcome, 'price-changed');
        expect(outcome.refusal.data).toEqual({ cents: 0.99 });
    });

    it('joins a guard\'s codes to the endpoint\'s, whichever reason the refusal arrives under', async () => {
        const app = lambderTestApp(createStore());
        const clerk = await app.signIn('u1', { userId: 'u1', role: 'clerk' });
        const refused = await clerk.apiOutcome('order.refund', { orderId: 'o1' });
        // The declaration's flag makes notAuthorized the reason and its
        // status the answer's; the code rides beside them.
        assertApiFailure(refused, 'notAuthorized', { status: 403 });
        assertApiRefusal(refused, 'not-a-manager');

        const manager = await app.signIn('u2', { userId: 'u2', role: 'manager' });
        assertApiRefusal(await manager.apiOutcome('order.refund', { orderId: 'closed' }), 'order-closed');
        assertApiSuccess(await manager.apiOutcome('order.refund', { orderId: 'o1' }));
    });
});

describe('Declared refusals: what is never sent', () => {
    const crashesOf = async (mode: 'undeclared' | 'bad-data' | 'missing-data' | 'stray-data' | 'own-status' | 'own-flag') => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const app = lambderTestApp(createStore());
        const outcome = await app.visitor().apiOutcome('order.quote', { mode });
        assertApiFailure(outcome, 'server', { status: 500 });
        expect(app.crashes).toHaveLength(1);
        return app.crashes[0]!;
    };

    it('crashes on a code the endpoint does not declare, naming it and the fix', async () => {
        const crash = await crashesOf('undeclared');
        expect(crash.name).toBe('LambderApiRefusalValidationError');
        expect(crash.message).toMatch(/API "order\.quote" refused with the code "order-closed", which it does not declare/);
        // The refusal as thrown is the cause, so its stack points at the raise site.
        expect((crash.cause as Error).name).toBe('LambderApiRefusal');
    });

    it('crashes on data its code\'s schema rejects, naming the paths and never the values', async () => {
        const crash = await crashesOf('bad-data');
        expect(crash.message).toMatch(/refused with the code "price-changed" and data its schema does not accept, so the refusal was not sent\. cents: /);
        expect(crash.message).not.toContain('many');
    });

    it('crashes on a declared code that carries data sent without it', async () => {
        expect((await crashesOf('missing-data')).message).toMatch(/refused with the code "price-changed", which carries data, and no data/);
    });

    it('crashes on data beside no declared code', async () => {
        expect((await crashesOf('stray-data')).message).toMatch(/refused with data but no code/);
    });

    it('crashes on a declared code raised with a status or flag of its own, which its declaration owns', async () => {
        expect((await crashesOf('own-status')).message).toMatch(/declared code "price-changed" and a status or flag of its own/);
        expect((await crashesOf('own-flag')).message).toMatch(/declared code "price-changed" and a status or flag of its own/);
    });

    it('checks a refusal a hook throws against the endpoint the call names', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const hooked = createStore().addHook('beforeRender', async (ctx) => {
            if(ctx.apiName === 'order.pay' && ctx.apiPayload?.orderId === 'hook-declared') refuse('Closed.', { code: 'order-closed' });
            if(ctx.apiName === 'order.peek') refuse('Closed.', { code: 'order-closed' });
            return ctx;
        });
        const app = lambderTestApp(hooked);
        assertApiRefusal(await app.visitor().apiOutcome('order.pay', { orderId: 'hook-declared', amount: 1 }), 'order-closed');
        assertApiFailure(await app.visitor().apiOutcome('order.peek', {}), 'server', { status: 500 });
        expect(app.crashes.at(-1)?.message).toMatch(/API "order\.peek" refused with the code "order-closed", which it does not declare/);
    });
});

describe('Declared refusals: the caller', () => {
    it('types a caller\'s outcome, its per-call handler and its constructor handler from the contract', async () => {
        const caller = new LambderCaller<Contract>({
            apiPath: '/api',
            refusalHandler: (message) => {
                expectTypeOf(message).toEqualTypeOf<LambderContractAnyRefusalMessage<Contract>>();
            },
        });
        void (async () => {
            const outcome = await caller.apiOutcome('order.pay', { orderId: 'o1', amount: 1 }, {
                refusalHandler: (message) => { expectTypeOf(message).toEqualTypeOf<LambderContractRefusalMessage<Contract, 'order.pay'>>(); },
            });
            if(!outcome.ok && outcome.reason === 'refusal' && outcome.refusal.code === 'wallet-short'){
                expectTypeOf(outcome.refusal.data.available).toEqualTypeOf<number>();
            }
            // @ts-expect-error a code order.pay does not declare
            assertApiRefusal(outcome, 'not-a-manager');
        });
        expect(caller).toBeDefined();
    });
});

describe('Declared refusals: creation', () => {
    it('refuses a vocabulary it cannot use, at the type level and at creation', () => {
        // @ts-expect-error a code under the framework's prefix
        expect(() => initLambder().declareRefusals({ 'lambder/mine': {} }).create({ apiPath: '/api' })).toThrow(/under the "lambder\/" prefix/);
        // @ts-expect-error a misspelled declaration key
        expect(() => initLambder().declareRefusals({ 'order-closed': { dat: z.object({}) } }).create({ apiPath: '/api' })).toThrow(/has "dat" beside data/);
        // @ts-expect-error a code's data is an object or an array
        expect(() => initLambder().declareRefusals({ 'order-closed': { data: z.string() } }).create({ apiPath: '/api' })).not.toThrow();
        // @ts-expect-error nor one that may be undefined, which JSON would drop
        expect(() => initLambder().declareRefusals({ 'order-closed': { data: z.object({}).optional() } }).create({ apiPath: '/api' })).not.toThrow();
        // @ts-expect-error a declared status is one a reader files as this refusal: never 422
        expect(() => initLambder().declareRefusals({ 'order-closed': { status: 422 } }).create({ apiPath: '/api' })).toThrow(/declares the status 422/);
        // @ts-expect-error nor a 5xx
        expect(() => initLambder().declareRefusals({ 'order-closed': { status: 503 } }).create({ apiPath: '/api' })).toThrow(/declares the status 503/);
        // @ts-expect-error the flag is declared as true or not at all
        expect(() => initLambder().declareRefusals({ 'order-closed': { notAuthorized: false } }).create({ apiPath: '/api' })).toThrow(/declares notAuthorized as false/);
        expect(() => initLambder().declareRefusals({}).create({ apiPath: '/api' })).toThrow(/declared with no codes/);
        expect(() => initLambder().declareRefusals({ closed: { data: 'no' as never } }).create({ apiPath: '/api' })).toThrow(/not a zod schema/);
    });

    it('refuses a guard naming a code the vocabulary does not hold, as it is built and at creation, and an API naming one at registration', () => {
        // The init's own builder knows the vocabulary and refuses at once.
        // @ts-expect-error the guard names a code the vocabulary does not hold
        expect(() => initLambder().declareRefusals({ 'order-closed': {} }).guard({ refusals: ['order-closd'], handler: () => {} })).toThrow(/a guard declares the refusal "order-closd", which the refusals vocabulary does not hold/);
        // @ts-expect-error an init that declared no vocabulary has no code to name
        expect(() => initLambder().guard({ refusals: ['order-closed'], handler: () => {} })).toThrow(/a guard declares the refusal "order-closed", but no refusals vocabulary was declared/);
        // The standalone builder knows no vocabulary; create() meets the guard first.
        const typo = lambderGuard({ refusals: ['order-closd'], handler: () => {} });
        // @ts-expect-error the guard names a code the vocabulary does not hold
        expect(() => initLambder().declareRefusals({ 'order-closed': {} }).create({ apiPath: '/api', guards: { typo } })).toThrow(/guard "typo" declares the refusal "order-closd", which the refusals vocabulary does not hold/);
        // @ts-expect-error a guard names codes, and there is no vocabulary to name them from
        expect(() => initLambder().create({ apiPath: '/api', guards: { typo } })).toThrow(/no refusals vocabulary was declared/);
        const store = initLambder().declareRefusals({ 'order-closed': {} }).create({ apiPath: '/api' });
        expect(() => store.addApi('x', { input: z.object({}), output: z.object({}), refusals: 'order-lost' as never }, async () => ({}))).toThrow(/API "x" declares the refusal "order-lost", which the refusals vocabulary does not hold/);
        expect(() => store.addApi('y', { input: z.object({}), output: z.object({}), refusals: [] as never }, async () => ({}))).toThrow(/empty refusals option/);
        expect(() => initLambder().create({ apiPath: '/api' }).addApi('z', { input: z.object({}), output: z.object({}), refusals: 'x' as never }, async () => ({}))).toThrow(/no refusals vocabulary was declared/);
        // The vocabulary is declared once, at the init, and create() takes none.
        // @ts-expect-error create() has no refusals option
        expect(() => initLambder().create({ apiPath: '/api', refusals: { 'order-closed': {} } })).not.toThrow();
    });

    it('types a guard\'s ctx.refuse to the guard\'s own codes, and the init\'s refuse to the whole vocabulary', () => {
        const init = initLambder().declareRefusals({ 'order-closed': {}, 'wallet-short': { data: z.object({ available: z.number() }) } });
        init.guard({
            refusals: ['order-closed'],
            handler: (ctx) => {
                // @ts-expect-error a code the guard does not declare
                if(Math.random() > 2) ctx.refuse('Short.', { code: 'wallet-short', data: { available: 1 } });
                // @ts-expect-error the code declares no data
                if(Math.random() > 2) ctx.refuse('Closed.', { code: 'order-closed', data: { available: 1 } });
                if(Math.random() > 2) ctx.refuse('Closed.', { code: 'order-closed' });
            },
        });
        init.guard({ handler: (ctx) => {
            // @ts-expect-error a guard declaring no refusals raises no code
            if(Math.random() > 2) ctx.refuse('Closed.', { code: 'order-closed' });
        } });
        // The init's refuse names any code of the vocabulary, data typed; the endpoint check happens where it is rendered.
        expectTypeOf(init.refuse).parameter(1).toEqualTypeOf<LambderDeclaredRefuseOptions<{ 'order-closed': {}; 'wallet-short': { data: { available: number } } }> | undefined>();
        // @ts-expect-error a code outside the vocabulary
        expect(() => init.refuse('Nope.', { code: 'order-lost' })).toThrow();
        expect(() => init.refuse('Short.', { code: 'wallet-short', data: { available: 1 } })).toThrow(/Short\./);
    });

    it('requires a code on every refusal an API answers with when the vocabulary says so', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const init = initLambder().declareRefusals({ 'order-closed': {} }, { requireCodes: true });
        const store = init.create({ apiPath: '/api' })
            .addApi('a', { input: z.object({ mode: z.enum(['coded', 'uncoded', 'framework']) }), output: z.object({}), refusals: 'order-closed' }, async (ctx) => {
                switch(ctx.apiPayload.mode){
                    case 'coded': return ctx.refuse('Closed.', { code: 'order-closed' });
                    // The free refuse() still compiles; the render check is what catches it.
                    case 'uncoded': return refuse('Plain.');
                    case 'framework': return refuse('Reused.', { code: LAMBDER_REFUSAL_CODES.idempotencyKeyReused });
                }
            });
        // ctx.refuse and the init's refuse take no uncoded form.
        store.addApi('b', { input: z.object({}), output: z.object({}) }, async (ctx) => {
            // @ts-expect-error a refusal names a code here
            if(Math.random() > 2) ctx.refuse('Plain.');
            // @ts-expect-error the options are not optional either
            if(Math.random() > 2) ctx.refuse('Plain.', {});
            return {};
        });
        // @ts-expect-error the init's refuse names a code too
        expect(() => init.refuse('Plain.')).toThrow();
        const app = lambderTestApp(store);
        assertApiRefusal(await app.visitor().apiOutcome('a', { mode: 'coded' }), 'order-closed');
        assertApiFailure(await app.visitor().apiOutcome('a', { mode: 'framework' }), 'refusal', { code: LAMBDER_REFUSAL_CODES.idempotencyKeyReused });
        assertApiFailure(await app.visitor().apiOutcome('a', { mode: 'uncoded' }), 'server', { status: 500 });
        expect(app.crashes.at(-1)?.message).toMatch(/API "a" refused without a code, and this app requires every refusal/);
        // The switch needs a vocabulary to name codes from.
        expect(() => new Lambder({ apiPath: '/api', requireRefusalCodes: true })).toThrow(/requireRefusalCodes needs a refusals vocabulary/);
    });

    it('keeps a rate limit\'s code the framework\'s: a policy may not set one', () => {
        expect(() => initLambder().create({
            apiPath: '/api',
            // @ts-expect-error a rate-limit message has no code
            rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: { burst: { per: 'ip', perMin: 1, refusal: { type: 'warning', code: 'app/slow', content: 'Slow down.' } } } },
        })).toThrow(/rate-limit policy "burst" sets a refusal code/);
    });
});
