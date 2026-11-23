/**
 * API facts: what an endpoint states about itself, in a vocabulary the app
 * declares on its init (declareApiFacts) and a module declares for its own
 * endpoints (defineApiModule). An endpoint writes its facts in its `facts`
 * option; registration holds them to the schema and fills in the defaults;
 * every call's context carries them as `ctx.apiFacts`, typed for a guard
 * built from the init and for the endpoint's handler; and the generated
 * options record them resolved.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import { lambderTestApp, assertApiRefusal } from '../../src/testing.js';
import { browse } from '../helpers.js';

type Session = { customerId: string };

const storeFacts = z.object({
    readOnly: z.boolean().default(false),
    audience: z.enum(['customers', 'staff']).default('customers'),
});
const storeInit = initLambder<Session>().declareRefusals({ 'staff-only': {} }).declareApiFacts(storeFacts);

/** What each guard read off the context of the call it ran for, by endpoint. */
const factsSeenByGuard: Record<string, unknown> = {};

const storeGuards = {
    anyone: storeInit.guard({
        handler: (ctx) => {
            expectTypeOf(ctx.apiFacts).toEqualTypeOf<Readonly<{ readOnly: boolean; audience: 'customers' | 'staff' }>>();
            factsSeenByGuard[ctx.apiName ?? ''] = ctx.apiFacts;
        },
    }),
    // One guard, deciding endpoint by endpoint from what each states.
    audience: storeInit.guard({
        refusals: ['staff-only'],
        handler: (ctx) => {
            if(ctx.apiFacts.audience === 'staff' && ctx.header('x-staff') !== 'yes') ctx.refuse('Staff only.', { code: 'staff-only' });
        },
    }),
};

const createStoreApp = () => storeInit.create({
    apiPath: '/api',
    session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
    guards: storeGuards,
});

const input = z.object({});
const output = z.object({ facts: z.record(z.string(), z.unknown()) });

describe('API facts', () => {
    it('reach the guards and the handler of every call, typed, with the defaults filled in', async () => {
        const app = createStoreApp();
        const lambder = app.registerApiGroups(app.defineApiGroup('orders', {
            list: app.defineApi({ input, output, guards: 'anyone', facts: { readOnly: true } }, async (ctx) => {
                expectTypeOf(ctx.apiFacts).toEqualTypeOf<Readonly<{ readOnly: boolean; audience: 'customers' | 'staff' }>>();
                return { facts: { ...ctx.apiFacts } };
            }),
            // An endpoint that states nothing is taken to state every default.
            place: app.defineApi({ input, output, guards: 'anyone' }, async (ctx) => ({ facts: { ...ctx.apiFacts } })),
            audit: app.defineApi({ input, output, guards: ['anyone', 'audience'], facts: { audience: 'staff', readOnly: true } }, async (ctx) => ({ facts: { ...ctx.apiFacts } })),
        }));
        const visitor = lambderTestApp(lambder).visitor();

        expect(await visitor.orders.list({})).toEqual({ facts: { readOnly: true, audience: 'customers' } });
        expect(await visitor.orders.place({})).toEqual({ facts: { readOnly: false, audience: 'customers' } });
        expect(factsSeenByGuard['orders.list']).toEqual({ readOnly: true, audience: 'customers' });
        expect(factsSeenByGuard['orders.place']).toEqual({ readOnly: false, audience: 'customers' });
        // The guard that reads a fact decides by it.
        assertApiRefusal(await visitor.orders.audit.outcome({}), 'staff-only');
        expect(await visitor.orders.audit({}, { headers: { 'x-staff': 'yes' } })).toEqual({ facts: { readOnly: true, audience: 'staff' } });
    });

    it('are one frozen object per endpoint, so nothing a call does to them reaches the next', async () => {
        const app = createStoreApp();
        const seen: object[] = [];
        const lambder = app.registerApiGroups(app.defineApiGroup('orders', {
            list: app.defineApi({ input, output: z.object({}), facts: { readOnly: true } }, async (ctx) => {
                seen.push(ctx.apiFacts);
                expect(() => { (ctx.apiFacts as { readOnly: boolean }).readOnly = false; }).toThrow(TypeError);
                return {};
            }),
        }));
        const visitor = lambderTestApp(lambder).visitor();
        await visitor.orders.list({});
        await visitor.orders.list({});

        expect(seen[0]).toBe(seen[1]);
        expect(Object.isFrozen(seen[0])).toBe(true);
        expect(seen[0]).toEqual({ readOnly: true, audience: 'customers' });
    });

    it('are held to the vocabulary where the endpoint is declared and again where it is registered', () => {
        const app = createStoreApp();
        const emptyOutput = z.object({});
        const registering = (api: ReturnType<typeof app.defineApi>) => () => app.registerApiGroups(app.defineApiGroup('orders', { api }));

        // @ts-expect-error readOnyl is no fact the app declared
        expect(registering(app.defineApi({ input, output: emptyOutput, facts: { readOnyl: true } }, async () => ({})))).toThrow(/API "orders.api" states "readOnyl", which no API facts vocabulary/);
        // @ts-expect-error a fact is held to its schema
        expect(registering(app.defineApi({ input, output: emptyOutput, facts: { readOnly: 'yes' } }, async () => ({})))).toThrow(/API "orders.api" states facts its vocabulary refuses \(readOnly: /);
        // @ts-expect-error audience is one of the two the schema names
        expect(registering(app.defineApi({ input, output: emptyOutput, facts: { audience: 'everyone' } }, async () => ({})))).toThrow(/states facts its vocabulary refuses \(audience: /);
        expect(registering(app.defineApi({ input, output: emptyOutput, facts: [] as never }, async () => ({})))).toThrow(/has a facts option that is not an object of facts by name/);
    });

    it('make a fact without a default something every endpoint states', () => {
        const init = initLambder<Session>().declareApiFacts(z.object({ owner: z.enum(['orders', 'billing']), readOnly: z.boolean().default(false) }));
        const app = init.create({ apiPath: '/api' });
        const emptyOutput = z.object({});

        // @ts-expect-error owner has no default, so the facts option is required
        const unowned = app.defineApi({ input, output: emptyOutput }, async () => ({}));
        expect(() => app.registerApiGroups(app.defineApiGroup('orders', { unowned }))).toThrow(/API "orders.unowned" states facts its vocabulary refuses \(owner: /);
        // @ts-expect-error owner is required among the facts stated
        app.defineApi({ input, output: emptyOutput, facts: { readOnly: true } }, async () => ({}));

        const lambder = app.registerApiGroups(app.defineApiGroup('billing', {
            statement: app.defineApi({ input, output: emptyOutput, facts: { owner: 'billing' } }, async (ctx) => {
                expectTypeOf(ctx.apiFacts.owner).toEqualTypeOf<'orders' | 'billing'>();
                return {};
            }),
        }));
        expect(lambder).toBeDefined();
    });

    it('are refused on an app that declares none, and a schema that declares nothing is refused as a vocabulary', () => {
        const app = initLambder<Session>().create({ apiPath: '/api' });
        const emptyOutput = z.object({});
        // @ts-expect-error this app declares no API facts
        const stated = app.defineApi({ input, output: emptyOutput, facts: { readOnly: true } }, async () => ({}));
        expect(() => app.registerApiGroups(app.defineApiGroup('orders', { stated }))).toThrow(/API "orders.stated" states facts, and no API facts were declared/);
        // With none declared, a handler's facts are an empty object and a route's context has none.
        const lambder = app.registerApiGroups(app.defineApiGroup('orders', {
            list: app.defineApi({ input, output }, async (ctx) => {
                expectTypeOf(ctx.apiFacts).toEqualTypeOf<Readonly<{}>>();
                return { facts: { ...ctx.apiFacts } };
            }),
        }));
        expect(lambder).toBeDefined();

        expect(() => initLambder().declareApiFacts(z.object({}))).toThrow(/an object schema with no keys, which declares no fact/);
        // @ts-expect-error the vocabulary is an object schema, one key per fact
        expect(() => initLambder().declareApiFacts(z.string())).toThrow(/declareApiFacts\(\) takes the API facts as an object schema/);
        // @ts-expect-error a plain object of schemas is not a schema
        expect(() => initLambder().declareApiFacts({ readOnly: z.boolean() })).toThrow(/takes the API facts as an object schema/);
    });

    it('hold only plain data, since the generated options write them as the values they are', () => {
        const init = initLambder<Session>().declareApiFacts(z.object({ since: z.date().nullable().default(null), tags: z.array(z.string()).default([]) }));
        const app = init.create({ apiPath: '/api' });
        const dated = app.defineApi({ input, output: z.object({}), facts: { since: new Date(0) } }, async () => ({}));

        expect(() => app.registerApiGroups(app.defineApiGroup('orders', { dated }))).toThrow(/the facts of API "orders.dated" must be plain data .* since is an instance of Date/);
    });

    it('are every one present on every call: a fact that could be absent is refused as a vocabulary', async () => {
        // @ts-expect-error an optional fact with no default could be absent
        expect(() => initLambder().declareApiFacts(z.object({ writes: z.boolean().optional() }))).toThrow(/declareApiFacts\(\) declares the fact "writes", which could be absent/);
        // @ts-expect-error after declareRefusals as before it
        expect(() => initLambder().declareRefusals({ 'staff-only': {} }).declareApiFacts(z.object({ readOnly: z.boolean().default(false), owner: z.string().optional() }))).toThrow(/declares the fact "owner", which could be absent/);
        const app = createStoreApp();
        // @ts-expect-error a module's facts are held to the same
        expect(() => app.defineApiModule({ apiFacts: z.object({ movesBalance: z.boolean().optional() }) })).toThrow(/defineApiModule\(\) declares the fact "movesBalance", which could be absent/);

        // "None" is a value like any other: nullable, with a default of null.
        const init = initLambder<Session>().declareApiFacts(z.object({ owner: z.enum(['orders', 'billing']).nullable().default(null) }));
        const plain = init.create({ apiPath: '/api' });
        const lambder = plain.registerApiGroups(plain.defineApiGroup('orders', {
            list: plain.defineApi({ input, output }, async (ctx) => {
                expectTypeOf(ctx.apiFacts.owner).toEqualTypeOf<'orders' | 'billing' | null>();
                return { facts: { ...ctx.apiFacts } };
            }),
        }));
        expect(await lambderTestApp(lambder).visitor().orders.list({})).toEqual({ facts: { owner: null } });
        expect((await lambder.apiOptionEntries()).apis['orders.list']).toEqual({ mode: 'public', facts: { owner: null } });
    });

    it('are declared with the refusal vocabulary in either order, each once', () => {
        const refusals = { 'staff-only': {} } as const;
        const factsFirst = initLambder<Session>().declareApiFacts(storeFacts).declareRefusals(refusals, { requireCodes: true });
        const guard = factsFirst.guard({
            refusals: ['staff-only'],
            handler: (ctx) => {
                expectTypeOf(ctx.apiFacts.readOnly).toEqualTypeOf<boolean>();
                // @ts-expect-error requireCodes carried through: a refusal names a code
                if(ctx.apiFacts.audience === 'staff') ctx.refuse('Staff only.');
            },
        });
        const app = factsFirst.create({ apiPath: '/api', guards: { guard } });
        app.defineApi({ input, output: z.object({}), guards: 'guard', refusals: 'staff-only', facts: { readOnly: true } }, async () => ({}));

        // Each is declared once: the init a declaration returns no longer offers it.
        expect('declareApiFacts' in factsFirst).toBe(false);
        expect('declareRefusals' in factsFirst).toBe(false);
        expect('declareApiFacts' in initLambder().declareApiFacts(storeFacts)).toBe(false);
        expect('declareRefusals' in initLambder().declareRefusals(refusals)).toBe(false);
        // A guard built from an init with no facts reads the context's own untyped field.
        initLambder<Session>().guard({ handler: (ctx) => { expectTypeOf(ctx.apiFacts).toEqualTypeOf<unknown>(); } });
    });

    it('are absent where no endpoint is being called: a route, and a hook before the call is dispatched', async () => {
        const app = createStoreApp();
        const seen: Record<string, unknown> = {};
        const lambder = app
            .registerApiGroups(app.defineApiGroup('orders', {
                list: app.defineApi({ input, output: z.object({}), facts: { readOnly: true } }, async () => ({})),
            }))
            .addHook('beforeRender', async (ctx) => { seen.beforeRender = ctx.apiFacts; return ctx; })
            .addHook('afterRender', async (ctx, _resolver, response) => { seen.afterRender = ctx.apiFacts; return response; })
            .addRoute('/status', (ctx, res) => { seen.route = ctx.apiFacts; return res.json({ ok: true }); });
        await lambderTestApp(lambder).visitor().orders.list({});
        expect(seen.beforeRender).toBeUndefined();
        expect(seen.afterRender).toEqual({ readOnly: true, audience: 'customers' });

        await browse(lambder).request('GET', '/status');
        expect(seen.route).toBeUndefined();
    });

    it('are written into the option entries resolved, and are no part of an endpoint\'s signature', async () => {
        const build = (listFacts: { readOnly?: boolean }) => {
            const app = createStoreApp();
            return app.registerApiGroups(app.defineApiGroup('orders', {
                list: app.defineApi({ input, output: z.object({}), guards: 'anyone', facts: listFacts }, async () => ({})),
                place: app.defineApi({ input, output: z.object({}), guards: 'anyone' }, async () => ({})),
            }));
        };
        const lambder = build({ readOnly: true });

        expect((await lambder.apiOptionEntries()).apis).toEqual({
            'orders.list': { mode: 'public', guards: 'anyone', facts: { readOnly: true, audience: 'customers' } },
            'orders.place': { mode: 'public', guards: 'anyone', facts: { readOnly: false, audience: 'customers' } },
        });
        // A fact changes what the server decides, never what a client sends or reads.
        expect(await build({ readOnly: false }).apiSignatures()).toEqual(await lambder.apiSignatures());

        const plain = initLambder<Session>().create({ apiPath: '/api' });
        const withoutFacts = plain.registerApiGroups(plain.defineApiGroup('orders', { list: plain.defineApi({ input, output: z.object({}) }, async () => ({})) }));
        expect((await withoutFacts.apiOptionEntries()).apis).toEqual({ 'orders.list': { mode: 'public' } });
    });
});

describe('A module\'s API facts', () => {
    const giftCardFacts = z.object({ movesBalance: z.boolean().default(false) });

    it('are stated by its endpoints beside the app\'s, and by no other endpoint', async () => {
        const app = createStoreApp();
        const giftCards = app.defineApiModule({ apiFacts: giftCardFacts });
        const lambder = app.registerApiGroups(
            giftCards.defineApiGroup('giftCards', {
                redeem: giftCards.defineApi({ input, output, guards: 'anyone', facts: { movesBalance: true } }, async (ctx) => {
                    expectTypeOf(ctx.apiFacts).toEqualTypeOf<Readonly<{ readOnly: boolean; audience: 'customers' | 'staff' } & { movesBalance: boolean }>>();
                    return { facts: { ...ctx.apiFacts } };
                }),
                balance: giftCards.defineApi({ input, output, guards: 'anyone', facts: { readOnly: true } }, async (ctx) => ({ facts: { ...ctx.apiFacts } })),
            }),
            app.defineApiGroup('orders', {
                list: app.defineApi({ input, output, guards: 'anyone' }, async (ctx) => ({ facts: { ...ctx.apiFacts } })),
            }),
        );
        const visitor = lambderTestApp(lambder).visitor();

        expect(await visitor.giftCards.redeem({})).toEqual({ facts: { readOnly: false, audience: 'customers', movesBalance: true } });
        expect(await visitor.giftCards.balance({})).toEqual({ facts: { readOnly: true, audience: 'customers', movesBalance: false } });
        // The instance's own endpoints carry the app's facts alone.
        expect(await visitor.orders.list({})).toEqual({ facts: { readOnly: false, audience: 'customers' } });
        expect((await lambder.apiOptionEntries()).apis['giftCards.redeem']).toEqual({ mode: 'public', guards: 'anyone', facts: { readOnly: false, audience: 'customers', movesBalance: true } });

        // @ts-expect-error movesBalance is the module's fact: the instance's builders do not know it
        const stray = app.defineApi({ input, output, facts: { movesBalance: true } }, async () => ({ facts: {} }));
        expect(() => app.registerApiGroups(app.defineApiGroup('stray', { stray }))).toThrow(/API "stray.stray" states "movesBalance", which no API facts vocabulary/);
    });

    it('are facts of its own: one the app declares, or another module does, is refused', () => {
        const app = createStoreApp();
        // @ts-expect-error readOnly is the app's fact
        expect(() => app.defineApiModule({ apiFacts: z.object({ readOnly: z.boolean().default(true) }) })).toThrow(/the API fact "readOnly" of the module being defined is declared already/);
        // @ts-expect-error a module's facts are an object schema too
        expect(() => app.defineApiModule({ apiFacts: z.boolean() })).toThrow(/defineApiModule\(\) takes the API facts as an object schema/);

        const first = app.defineApiModule({ apiFacts: giftCardFacts });
        const second = app.defineApiModule({ apiFacts: z.object({ movesBalance: z.boolean().default(true) }) });
        const emptyOutput = z.object({});
        const cards = first.defineApiGroup('cards', { a: first.defineApi({ input, output: emptyOutput }, async () => ({})) });
        const vouchers = second.defineApiGroup('vouchers', { a: second.defineApi({ input, output: emptyOutput }, async () => ({})) });
        expect(() => app.registerApiGroups(cards, vouchers)).toThrow(/the API fact "movesBalance" is declared by two modules/);
        app.registerApiGroups(cards);
        expect(() => app.registerApiGroups(vouchers)).toThrow(/the API fact "movesBalance" of the module declaring "vouchers.a" is declared already/);
    });

    it('are what a module on an app with no facts of its own may declare', async () => {
        const app = initLambder<Session>().create({ apiPath: '/api' });
        const giftCards = app.defineApiModule({ apiFacts: giftCardFacts });
        const lambder = app.registerApiGroups(giftCards.defineApiGroup('giftCards', {
            redeem: giftCards.defineApi({ input, output, facts: { movesBalance: true } }, async (ctx) => {
                expectTypeOf(ctx.apiFacts).toEqualTypeOf<Readonly<{} & { movesBalance: boolean }>>();
                return { facts: { ...ctx.apiFacts } };
            }),
        }));

        expect(await lambderTestApp(lambder).visitor().giftCards.redeem({})).toEqual({ facts: { movesBalance: true } });
    });
});
