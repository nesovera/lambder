/**
 * Session guards: the guards an instance runs on every session endpoint
 * (create()'s sessionGuards), before the endpoint's own. What an app decides
 * for every signed-in call at once is written once, and no endpoint, and no
 * guard an endpoint declares, has to remember it. Such a guard reads the
 * context alone, the endpoint's facts among it, and its refusal codes join
 * those of every session endpoint.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import { lambderTestApp, assertApiFailure, assertApiRefusal, assertApiSuccess } from '../../src/testing.js';

type Session = { customerId: string; viewOnly?: boolean; onHold?: boolean };

const storeInit = initLambder<Session>()
    .declareRefusals({ 'view-only-session': {}, 'account-on-hold': { status: 403 }, 'not-yours': {} })
    .declareApiFacts(z.object({ readOnly: z.boolean().default(false) }));

/** The guards that ran, in order, across the calls of one test. */
let ran: string[] = [];

const storeGuards = {
    signedIn: storeInit.guard({ session: true, handler: (ctx) => { ran.push('signedIn'); return { customerId: ctx.session.data.customerId }; } }),
    anyone: storeInit.guard({ handler: () => { ran.push('anyone'); } }),
    owner: storeInit.guard({
        session: true,
        refusals: ['not-yours'],
        handler: (ctx) => { ran.push('owner'); if(ctx.session.data.customerId === 'mallory') ctx.refuse('Not yours.', { code: 'not-yours' }); },
    }),
    // A session that may only look is refused every endpoint that does not say it only reads.
    viewOnlySession: storeInit.guard({
        session: true,
        refusals: ['view-only-session'],
        handler: (ctx) => {
            ran.push('viewOnlySession');
            if(ctx.session.data.viewOnly && !ctx.apiFacts.readOnly) ctx.refuse('This session may only look.', { code: 'view-only-session' });
        },
    }),
    accountInGoodStanding: storeInit.guard({
        session: true,
        refusals: ['account-on-hold'],
        handler: (ctx) => {
            ran.push('accountInGoodStanding');
            if(ctx.session.data.onHold) ctx.refuse('This account is on hold.', { code: 'account-on-hold' });
        },
    }),
    withInput: storeInit.guard({ session: true, guardInput: z.object({ storeId: z.string() }), handler: () => {} }),
    withSlice: storeInit.guard({ session: true, apiInput: z.object({ orderId: z.string() }), handler: () => {} }),
    withParam: storeInit.guard({ session: true, handler: (_ctx, _input, _permission: string) => {} }),
    afterInput: storeInit.guard({ session: true, runAt: 'afterInputValidation', handler: () => { ran.push('afterInput'); } }),
};

const session = () => ({ store: new LambderMemorySessionStore(), sessionSalt: 'salt' });

const createStoreApp = () => storeInit.create({
    apiPath: '/api',
    session: session(),
    guards: storeGuards,
    sessionGuards: ['accountInGoodStanding', 'viewOnlySession'],
});

const input = z.object({});
const output = z.object({ ok: z.boolean() });

const storeOf = (app: ReturnType<typeof createStoreApp>) => app.registerApiGroups(app.defineApiGroup('orders', {
    list: app.defineApi({ input, output, guards: 'signedIn', facts: { readOnly: true } }, async () => ({ ok: true })),
    place: app.defineApi({ input, output, guards: ['signedIn', 'owner'] }, async () => ({ ok: true })),
    catalog: app.defineApi({ input, output, guards: 'anyone' }, async () => ({ ok: true })),
}));

describe('Session guards', () => {
    it('run on every session endpoint, in their order, before its own guards, and on no public endpoint', async () => {
        const testApp = lambderTestApp(storeOf(createStoreApp()));
        const ada = await testApp.signIn('ada', { customerId: 'ada' });

        ran = [];
        expect(await ada.orders.place({})).toEqual({ ok: true });
        expect(ran).toEqual(['accountInGoodStanding', 'viewOnlySession', 'signedIn', 'owner']);

        ran = [];
        expect(await ada.orders.catalog({})).toEqual({ ok: true });
        expect(ran).toEqual(['anyone']);
    });

    it('decide for every signed-in call at once, endpoint by endpoint, from the facts each states', async () => {
        const testApp = lambderTestApp(storeOf(createStoreApp()));
        const viewer = await testApp.signIn('grace', { customerId: 'grace', viewOnly: true });
        const held = await testApp.signIn('hal', { customerId: 'hal', onHold: true });

        // The endpoint that says it only reads is open to a session that may only look.
        expect(await viewer.orders.list({})).toEqual({ ok: true });
        // Every other one is closed to it, and nothing after the guard that refused ran.
        ran = [];
        const refused = await viewer.orders.place.outcome({});
        assertApiRefusal(refused, 'view-only-session');
        expect(ran).toEqual(['accountInGoodStanding', 'viewOnlySession']);
        // A public endpoint reads no session, so the rule never meets it.
        expect(await viewer.orders.catalog({})).toEqual({ ok: true });

        // The first session guard refuses before the second runs, with its declared status.
        ran = [];
        const onHold = await held.orders.list.outcome({});
        assertApiRefusal(onHold, 'account-on-hold');
        expect(onHold.status).toBe(403);
        expect(ran).toEqual(['accountInGoodStanding']);
    });

    it('add their refusal codes to every session endpoint\'s contract, and to no public endpoint\'s', async () => {
        const lambder = storeOf(createStoreApp());
        type Contract = typeof lambder.ApiContract;
        // The endpoint's own guards' codes and the session guards', and nothing on a public endpoint.
        expectTypeOf<keyof Contract['orders.list']['refusals']>().toEqualTypeOf<'view-only-session' | 'account-on-hold'>();
        expectTypeOf<keyof Contract['orders.place']['refusals']>().toEqualTypeOf<'view-only-session' | 'account-on-hold' | 'not-yours'>();
        expectTypeOf<'refusals' extends keyof Contract['orders.catalog'] ? true : false>().toEqualTypeOf<false>();

        // A session endpoint's handler may send one itself; a public one's may not.
        const app = createStoreApp();
        app.defineApi({ input, output, guards: 'signedIn' }, async (ctx) => ctx.refuse('On hold.', { code: 'account-on-hold' }));
        // @ts-expect-error a public endpoint does not carry the session guards' codes
        app.defineApi({ input, output, guards: 'anyone' }, async (ctx) => ctx.refuse('On hold.', { code: 'account-on-hold' }));

        // A caller narrows on them like on any declared code.
        const viewer = await lambderTestApp(lambder).signIn('grace', { customerId: 'grace', viewOnly: true });
        const outcome = await viewer.orders.place.outcome({});
        if(outcome.ok === false && outcome.reason === 'refusal' && outcome.refusal.code === 'view-only-session'){
            expect(outcome.refusal.content).toBe('This session may only look.');
        }
        assertApiRefusal(outcome, 'view-only-session');
        // The codes are part of what a client's build is checked against.
        const entries = await lambder.apiSignatureEntries();
        const plain = storeInit.create({ apiPath: '/api', session: session(), guards: storeGuards });
        const plainEntries = await plain.registerApiGroups(plain.defineApiGroup('orders', {
            list: plain.defineApi({ input, output, guards: 'signedIn', facts: { readOnly: true } }, async () => ({ ok: true })),
            catalog: plain.defineApi({ input, output, guards: 'anyone' }, async () => ({ ok: true })),
        })).apiSignatureEntries();
        const signatureOf = (list: typeof entries, name: string) => list.find((entry) => entry.name === name)!.signature;
        expect(signatureOf(entries, 'orders.list')).not.toBe(signatureOf(plainEntries, 'orders.list'));
        expect(signatureOf(entries, 'orders.catalog')).toBe(signatureOf(plainEntries, 'orders.catalog'));
    });

    it('run on a module\'s session endpoints too, and at the step each is placed at', async () => {
        const app = storeInit.create({ apiPath: '/api', session: session(), guards: storeGuards, sessionGuards: ['afterInput', 'viewOnlySession'] });
        const giftCards = app.defineApiModule({
            guards: { cardHolder: storeInit.guard({ session: true, handler: () => { ran.push('cardHolder'); } }) },
        });
        const lambder = app.registerApiGroups(giftCards.defineApiGroup('giftCards', {
            redeem: giftCards.defineApi({ input: z.object({ amount: z.number() }), output, guards: 'cardHolder' }, async () => ({ ok: true })),
        }));
        const testApp = lambderTestApp(lambder);
        const ada = await testApp.signIn('ada', { customerId: 'ada' });

        ran = [];
        expect(await ada.giftCards.redeem({ amount: 5 })).toEqual({ ok: true });
        // Before the input: the session guard placed there, then the endpoint's own. After it: the one placed after.
        expect(ran).toEqual(['viewOnlySession', 'cardHolder', 'afterInput']);

        // An input the schema refuses never reaches the guard placed after validation.
        ran = [];
        assertApiFailure(await ada.giftCards.redeem.outcome({ amount: 'five' as never }), 'validation');
        expect(ran).toEqual(['viewOnlySession', 'cardHolder']);

        const viewer = await testApp.signIn('grace', { customerId: 'grace', viewOnly: true });
        assertApiRefusal(await viewer.giftCards.redeem.outcome({ amount: 5 }), 'view-only-session');
    });

    it('are marked in the guard declarations with their place in the order', async () => {
        const { guards } = await storeOf(createStoreApp()).apiOptionEntries();

        expect(guards.accountInGoodStanding).toEqual({ input: 'none', session: true, runAt: 'beforeInputValidation', refusals: ['account-on-hold'], sessionGuardOrder: 1 });
        expect(guards.viewOnlySession).toEqual({ input: 'none', session: true, runAt: 'beforeInputValidation', refusals: ['view-only-session'], sessionGuardOrder: 2 });
        expect(guards.signedIn).toEqual({ input: 'none', session: true, runAt: 'beforeInputValidation' });
    });

    it('are named from the guards given at creation that can run on every session endpoint', () => {
        const options = { apiPath: '/api', session: session(), guards: storeGuards } as const;

        // @ts-expect-error noSuchGuard is no guard of the map
        expect(() => storeInit.create({ ...options, sessionGuards: ['noSuchGuard'] })).toThrow(/the sessionGuards option names "noSuchGuard", which is not a guard of the guards option given at creation/);
        // @ts-expect-error anyone needs no session
        expect(() => storeInit.create({ ...options, sessionGuards: ['anyone'] })).toThrow(/names guard "anyone", which does not need a session/);
        // @ts-expect-error withInput takes a guardInput no caller knows to send
        expect(() => storeInit.create({ ...options, sessionGuards: ['withInput'] })).toThrow(/names guard "withInput", which takes an input/);
        // @ts-expect-error withSlice reads a payload slice no endpoint is held to
        expect(() => storeInit.create({ ...options, sessionGuards: ['withSlice'] })).toThrow(/names guard "withSlice", which takes an input/);
        // @ts-expect-error withParam takes a parameter no declaration gives it
        storeInit.create({ ...options, sessionGuards: ['withParam'] });
        // @ts-expect-error signedIn returns a value no handler's guardData is typed to hold
        storeInit.create({ ...options, sessionGuards: ['signedIn'] });

        expect(() => storeInit.create({ ...options, sessionGuards: ['viewOnlySession', 'viewOnlySession'] })).toThrow(/names guard "viewOnlySession" twice/);
        expect(() => storeInit.create({ ...options, sessionGuards: [] })).toThrow(/the sessionGuards option is a non-empty list of guard names/);
        // @ts-expect-error without a guards map there is nothing to name
        expect(() => storeInit.create({ apiPath: '/api', session: session(), sessionGuards: ['viewOnlySession'] })).toThrow(/sessionGuards needs a guards map at creation/);
        expect(() => storeInit.create({ apiPath: '/api', guards: storeGuards, sessionGuards: ['viewOnlySession'] })).toThrow(/the sessionGuards option needs the session option at creation/);
    });

    it('are no endpoint\'s to declare, and return nothing', async () => {
        const app = createStoreApp();
        const twice = app.defineApi({ input, output, guards: ['signedIn', 'viewOnlySession'] }, async () => ({ ok: true }));
        expect(() => app.registerApiGroups(app.defineApiGroup('orders', { twice }))).toThrow(/API "orders.twice" declares guard "viewOnlySession", which the sessionGuards option already runs on every session endpoint/);

        // A value a session guard returns has no typed place to land, which the
        // names are held to at compile time; one cast past that crashes the call.
        const answering = storeInit.create({ apiPath: '/api', session: session(), guards: storeGuards, sessionGuards: ['signedIn' as 'viewOnlySession'] });
        const lambder = answering.registerApiGroups(answering.defineApiGroup('orders', {
            list: answering.defineApi({ input, output, guards: 'owner' }, async () => ({ ok: true })),
        }));
        const ada = await lambderTestApp(lambder).signIn('ada', { customerId: 'ada' });
        assertApiFailure(await ada.orders.list.outcome({}), 'server');
    });

    it('leave an instance without them as it was', async () => {
        const app = storeInit.create({ apiPath: '/api', session: session(), guards: storeGuards });
        const lambder = app.registerApiGroups(app.defineApiGroup('orders', {
            place: app.defineApi({ input, output, guards: 'signedIn' }, async () => ({ ok: true })),
        }));
        type Contract = typeof lambder.ApiContract;
        expectTypeOf<'refusals' extends keyof Contract['orders.place'] ? true : false>().toEqualTypeOf<false>();

        const viewer = await lambderTestApp(lambder).signIn('grace', { customerId: 'grace', viewOnly: true });
        ran = [];
        assertApiSuccess(await viewer.orders.place.outcome({}));
        expect(ran).toEqual(['signedIn']);
        expect((await lambder.apiOptionEntries()).guards.viewOnlySession).toEqual({ input: 'none', session: true, runAt: 'beforeInputValidation', refusals: ['view-only-session'] });
    });
});
