/**
 * The mock and the guards a server runs on every session endpoint (create()'s
 * sessionGuards). The generated guardDeclarations table marks them, so a mock
 * given the tables runs its own guards of those names on every session entry,
 * in the server's order, and lets each such entry refuse with their codes;
 * the entry's context carries the facts the apiOptions table records.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { initLambderMock } from '../../src/mock/LambderMockApp.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import LambderCaller from '../../src/client/LambderCaller.js';
import { LambderCookieJar } from '../../src/shared/transport/LambderCookieJar.js';
import { assertApiRefusal } from '../../src/shared/wire/LambderOutcomeAssertions.js';
import { LAMBDER_REFUSAL_CODES } from '../../src/shared/wire/LambderApiRefusal.js';

type Session = { customerId: string; viewOnly?: boolean };

const refusals = { 'view-only-session': {}, 'account-on-hold': {} } as const;

// The server: every endpoint states whether it only reads, and two guards run
// on every session endpoint, the first deciding from that fact.
const storeInit = initLambder<Session>().declareRefusals(refusals).declareApiFacts(z.object({ readOnly: z.boolean().default(false) }));
const storeApp = storeInit.create({
    apiPath: '/api',
    session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
    guards: {
        signedIn: storeInit.guard({ session: true, handler: () => {} }),
        anyone: storeInit.guard({ handler: () => {} }),
        viewOnlySession: storeInit.guard({
            session: true,
            refusals: ['view-only-session'],
            handler: (ctx) => { if(ctx.session.data.viewOnly && !ctx.apiFacts.readOnly) ctx.refuse('This session may only look.', { code: 'view-only-session' }); },
        }),
        accountInGoodStanding: storeInit.guard({ session: true, refusals: ['account-on-hold'], handler: () => {} }),
    },
    // Not in the table's order, which is by name: the mark keeps the place.
    sessionGuards: ['viewOnlySession', 'accountInGoodStanding'],
});
const input = z.object({});
const output = z.object({ ok: z.boolean() });
const server = storeApp.registerApiGroups(storeApp.defineApiGroup('orders', {
    list: storeApp.defineApi({ input, output, guards: 'signedIn', facts: { readOnly: true } }, async () => ({ ok: true })),
    place: storeApp.defineApi({ input, output, guards: 'signedIn' }, async () => ({ ok: true })),
    catalog: storeApp.defineApi({ input, output, guards: 'anyone', facts: { readOnly: true } }, async () => ({ ok: true })),
}));
type Contract = typeof server.ApiContract;

// The tables writeApiOptions writes for that server.
const apiOptions = {
    'orders.catalog': { mode: 'public', guards: 'anyone', facts: { readOnly: true } },
    'orders.list': { mode: 'session', guards: 'signedIn', facts: { readOnly: true } },
    'orders.place': { mode: 'session', guards: 'signedIn', facts: { readOnly: false } },
} as const;
const guardDeclarations = {
    accountInGoodStanding: { input: 'none', session: true, runAt: 'beforeInputValidation', refusals: ['account-on-hold'], sessionGuardOrder: 2 },
    anyone: { input: 'none', session: false, runAt: 'beforeInputValidation' },
    signedIn: { input: 'none', session: true, runAt: 'beforeInputValidation' },
    viewOnlySession: { input: 'none', session: true, runAt: 'beforeInputValidation', refusals: ['view-only-session'], sessionGuardOrder: 1 },
} as const;

const mock = initLambderMock<Contract, Session>().declareRefusals(refusals);

/** The guards that ran, in order, and the facts each session guard read. */
let ran: string[] = [];
let factsRead: unknown[] = [];

const mockGuards = {
    signedIn: mock.guard({ session: true, handler: () => { ran.push('signedIn'); } }),
    anyone: mock.guard({ handler: () => { ran.push('anyone'); } }),
    viewOnlySession: mock.guard({
        session: true,
        refusals: ['view-only-session'],
        handler: (ctx) => {
            ran.push('viewOnlySession');
            factsRead.push(ctx.apiFacts);
            // The table is where a mock reads an endpoint's facts typed.
            if(ctx.session.data.viewOnly && !apiOptions[ctx.apiName as keyof typeof apiOptions].facts.readOnly) ctx.refuse('This session may only look.', { code: 'view-only-session' });
        },
    }),
    accountInGoodStanding: mock.guard({ session: true, refusals: ['account-on-hold'], handler: () => { ran.push('accountInGoodStanding'); } }),
};

const createMockApp = () => {
    const mockApp = mock.create({ sessions: true, guards: mockGuards, apiOptions, guardDeclarations });
    mockApp.register(mockApp.apiSlice(
        mockApp.api('orders.list', async () => ({ ok: true })),
        mockApp.api('orders.place', async () => ({ ok: true })),
        mockApp.api('orders.catalog', async () => ({ ok: true })),
    ));
    return mockApp;
};

const callerOf = (mockApp: ReturnType<typeof createMockApp>, jar: LambderCookieJar) =>
    new LambderCaller<Contract>({ apiPath: '/api', transport: mockApp.transport({ cookies: jar }) });

describe('A mock given the generated tables', () => {
    it('holds tables that are the server\'s own', async () => {
        const entries = await server.apiOptionEntries();
        expect(entries.apis).toEqual(apiOptions);
        expect(entries.guards).toEqual(guardDeclarations);
    });

    it('runs its guards of the marked names on every session entry, in the server\'s order, and on no public one', async () => {
        const mockApp = createMockApp();
        const jar = new LambderCookieJar();
        await mockApp.signIn('ada', { customerId: 'ada' }, { jar });
        const ada = callerOf(mockApp, jar);

        ran = [];
        factsRead = [];
        expect(await ada.orders.place({})).toEqual({ ok: true });
        expect(ran).toEqual(['viewOnlySession', 'accountInGoodStanding', 'signedIn']);
        // The entry's context carries the facts the table records for it.
        expect(factsRead).toEqual([{ readOnly: false }]);

        ran = [];
        expect(await ada.orders.catalog({})).toEqual({ ok: true });
        expect(ran).toEqual(['anyone']);
    });

    it('lets a session entry refuse with a marked guard\'s code, as the server\'s endpoint may', async () => {
        const mockApp = createMockApp();
        const jar = new LambderCookieJar();
        await mockApp.signIn('grace', { customerId: 'grace', viewOnly: true }, { jar });
        const viewer = callerOf(mockApp, jar);

        expect(await viewer.orders.list({})).toEqual({ ok: true });
        assertApiRefusal(await viewer.orders.place.outcome({}), 'view-only-session');
        // A handler may raise the code itself, since the endpoint's contract lists it.
        mockApp.override('orders.list', async ({ refuse }) => refuse('On hold.', { code: 'account-on-hold' }));
        assertApiRefusal(await viewer.orders.list.outcome({}), 'account-on-hold');
    });

    it('runs them on a session entry nothing mocks too, with the endpoint\'s facts on their context', async () => {
        const mockApp = mock.create({ sessions: true, guards: mockGuards, apiOptions, guardDeclarations });
        mockApp.register(
            mockApp.apiSlice(mockApp.notMocked('orders.list', 'Not mocked yet.')),
            mockApp.restNotMocked('The rest is not mocked.'),
        );
        const jar = new LambderCookieJar();
        await mockApp.signIn('grace', { customerId: 'grace', viewOnly: true }, { jar });
        const viewer = callerOf(mockApp as never, jar);

        ran = [];
        factsRead = [];
        // The endpoint that only reads passes the guard and answers that nothing mocks it.
        assertApiRefusal(await viewer.orders.list.outcome({}), LAMBDER_REFUSAL_CODES.notMocked);
        // The one that writes is refused by the guard first, a rest entry as a named one.
        assertApiRefusal(await viewer.orders.place.outcome({}), 'view-only-session');
        expect(factsRead).toEqual([{ readOnly: true }, { readOnly: false }]);
        expect(ran).toEqual(['viewOnlySession', 'accountInGoodStanding', 'viewOnlySession']);
    });

    it('needs a mock guard for every marked name, and sessions to run them on', () => {
        const { viewOnlySession: _left, ...withoutOne } = mockGuards;
        expect(() => mock.create({ sessions: true, guards: withoutOne, apiOptions, guardDeclarations }))
            .toThrow('LambderMockApp: the server runs guard "viewOnlySession" on every session endpoint by the guardDeclarations table, and create() was given no mock guard of that name. Declare it in the guards option, as every guard an entry runs is.');
        expect(() => mock.create({ sessions: false as never, guards: mockGuards, guardDeclarations }))
            .toThrow('LambderMockApp: the guardDeclarations table names guards the server runs on every session endpoint, which needs the sessions option at creation.');
    });
});
