/**
 * Mock modules: the mock guards a part of an app declares with its own
 * entries (the mock app's defineApiModule), standing in for the guards the
 * server's module declares. A module's entry builders type its entries on
 * the app's guards and its own; registering its entries adds its guards to
 * the app, and a name the app or another module declares is refused.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { initLambderMock } from '../../src/mock/LambderMockApp.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import { LambderMemoryRateLimiter } from '../../src/stores/LambderMemoryRateLimiter.js';
import LambderCaller from '../../src/client/LambderCaller.js';
import { LambderCookieJar } from '../../src/shared/transport/LambderCookieJar.js';
import { assertApiFailure, assertApiRefusal } from '../../src/shared/wire/LambderOutcomeAssertions.js';

type Session = { customerId: string };

// The server: an instance with its own guard, and a gift card module with a
// guard of its own, as an app on Lambder declares them.
const storeInit = initLambder<Session>().declareRefusals({ 'card-empty': {} });
const storeApp = storeInit.create({
    apiPath: '/api',
    session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
    rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: { browsePerIp: { perMin: 100, per: 'ip' } } },
    guards: { signedIn: storeInit.guard({ session: true, handler: () => {} }) },
});
const giftCards = storeApp.defineApiModule({
    guards: {
        cardHolder: storeInit.guard({ guardInput: z.object({ cardNumber: z.string() }), session: true, refusals: ['card-empty'], handler: (_ctx, { cardNumber }) => ({ cardNumber }) }),
    },
});
const server = storeApp.registerApiGroups(
    storeApp.defineApiGroup('account', {
        me: storeApp.defineApi({ input: z.object({}), output: z.object({ customerId: z.string() }), guards: 'signedIn' }, async (ctx) => ({ customerId: ctx.session.data.customerId })),
    }),
    giftCards.defineApiGroup('giftCards', {
        balance: giftCards.defineApi({ input: z.object({}), output: z.object({ cardNumber: z.string() }), guards: 'cardHolder' }, async (ctx) => ({ cardNumber: ctx.guardData.cardHolder.cardNumber })),
        redeem: giftCards.defineApi({ input: z.object({ amount: z.number() }), output: z.object({ left: z.number() }), guards: ['signedIn', 'cardHolder'] }, async () => ({ left: 1 })),
    }),
);
type Contract = typeof server.ApiContract;

const mock = initLambderMock<Contract, Session>().declareRefusals({ 'card-empty': {} });
const signedIn = mock.guard({ session: true, handler: () => {} });
const cardHolder = mock.guard({
    guardInput: z.object({ cardNumber: z.string() }),
    session: true,
    refusals: ['card-empty'],
    handler: (ctx, { cardNumber }) => {
        if(cardNumber === 'empty') ctx.refuse('This card is empty.', { code: 'card-empty' });
        return { cardNumber, holder: ctx.session.data.customerId };
    },
});
const createMockApp = () => mock.create({ sessions: true, guards: { signedIn } });

const callerOf = (mockApp: ReturnType<typeof createMockApp>, jar: LambderCookieJar) =>
    new LambderCaller<Contract>({ apiPath: '/api', transport: mockApp.transport({ cookies: jar }) });

describe('A mock module', () => {
    it('builds entries that run its mock guards beside the app\'s, which registering them adds to the app', async () => {
        const mockApp = createMockApp();
        const giftCardMocks = mockApp.defineApiModule({ guards: { cardHolder } });
        mockApp.register(
            mockApp.apiSlice(mockApp.api('account.me', { guards: 'signedIn', handler: async ({ session }) => ({ customerId: session.data.customerId }) })),
            giftCardMocks.apiSlice(
                giftCardMocks.api('giftCards.balance', {
                    guards: 'cardHolder',
                    handler: async ({ guardData }) => {
                        expectTypeOf(guardData.cardHolder).toEqualTypeOf<{ cardNumber: string; holder: string }>();
                        return { cardNumber: guardData.cardHolder.cardNumber };
                    },
                }),
                giftCardMocks.api('giftCards.redeem', { guards: ['signedIn', 'cardHolder'], handler: async () => ({ left: 4 }) }),
            ),
        );
        const jar = new LambderCookieJar();
        const caller = callerOf(mockApp, jar);
        // cardHolder needs a session, so the module's endpoints are session endpoints, as on the server.
        assertApiFailure(await caller.giftCards.balance.outcome({}, { guardInputs: { cardHolder: { cardNumber: 'c-1' } } }), 'sessionExpired');
        await mockApp.signIn('ada', { customerId: 'ada' }, { jar });
        expect(await caller.giftCards.balance({}, { guardInputs: { cardHolder: { cardNumber: 'c-1' } } })).toEqual({ cardNumber: 'c-1' });
        assertApiRefusal(await caller.giftCards.redeem.outcome({ amount: 1 }, { guardInputs: { cardHolder: { cardNumber: 'empty' } } }), 'card-empty');
    });

    it('is where an entry naming its guards is built: the app\'s own builders do not know them', () => {
        const mockApp = createMockApp();
        // @ts-expect-error cardHolder is the module's guard, and the app's map has no mock guard for it
        expect(() => mockApp.api('giftCards.balance', { guards: 'cardHolder', handler: async () => ({ cardNumber: 'c' }) })).toThrow(/unknown guard "cardHolder"/);
        const giftCardMocks = mockApp.defineApiModule({ guards: { cardHolder } });
        expect(giftCardMocks.api('giftCards.balance', { guards: 'cardHolder', handler: async () => ({ cardNumber: 'c' }) }).mode).toBe('session');
        // Its notMocked reads a session endpoint's mode off its guards, the module's among them.
        expect(giftCardMocks.notMocked('giftCards.balance', { reason: 'later', guards: 'cardHolder' }).mode).toBe('session');
    });

    it('may not declare a guard the app declares, nor one another module declares, and a refused registration leaves the app as it was', async () => {
        const mockApp = createMockApp();
        expect(() => mockApp.defineApiModule({
            // @ts-expect-error signedIn is the app's guard
            guards: { signedIn: mock.guard({ session: true, handler: () => {} }) },
        })).toThrow('Lambder: the guard "signedIn" of the module being defined is declared already, at creation or by a module registered before. A module declares names of its own: rename one of the two.');

        const first = mockApp.defineApiModule({ guards: { cardHolder } });
        const second = mockApp.defineApiModule({ guards: { cardHolder } });
        const balance = first.apiSlice(first.api('giftCards.balance', { guards: 'cardHolder', handler: async () => ({ cardNumber: 'c' }) }));
        const redeem = second.apiSlice(second.api('giftCards.redeem', { guards: ['signedIn', 'cardHolder'], handler: async () => ({ left: 1 }) }));
        expect(() => mockApp.registerPartial(balance, redeem)).toThrow(
            'Lambder: the guard "cardHolder" is declared by two modules, the one building the entry of "giftCards.balance" and the one building the entry of "giftCards.redeem". Declare each name once.',
        );
        expect(mockApp.registeredNames).toEqual([]);
        mockApp.registerPartial(balance);
        expect(() => mockApp.registerPartial(redeem)).toThrow(/the guard "cardHolder" of the module building the entry of "giftCards.redeem" is declared already/);
        expect(mockApp.registeredNames).toEqual(['giftCards.balance']);
    });

    it('takes guards alone, held to the server guard\'s declaration as create()\'s are', async () => {
        // The table writeApiOptions writes, which holds the module's guards beside the instance's.
        const guardDeclarations = {
            cardHolder: { input: 'guardInput', session: true, runAt: 'beforeInputValidation', refusals: ['card-empty'] },
            signedIn: { input: 'none', session: true, runAt: 'beforeInputValidation' },
        } as const;
        expect((await server.apiOptionEntries()).guards).toEqual(guardDeclarations);
        const declared = mock.create({ sessions: true, guards: { signedIn }, guardDeclarations });
        expect(() => declared.defineApiModule({
            guards: {
                // @ts-expect-error the server's cardHolder declares card-empty
                cardHolder: mock.guard({ guardInput: z.object({ cardNumber: z.string() }), session: true, handler: (_ctx, { cardNumber }) => ({ cardNumber }) }),
            },
        })).toThrow(/the mock guard "cardHolder" declares the refusals none, and the server's guard of that name declares "card-empty"/);
        expect(() => declared.defineApiModule({
            guards: {
                // @ts-expect-error the server's cardHolder needs a session
                cardHolder: mock.guard({ guardInput: z.object({ cardNumber: z.string() }), refusals: ['card-empty'], handler: (_ctx, { cardNumber }) => ({ cardNumber }) }),
            },
        })).not.toThrow();
        expect(() => declared.defineApiModule({ guards: {} })).toThrow('LambderMockApp: defineApiModule() was given no guard, which declares nothing a module\'s entries could name beyond the app\'s own. Declare the module\'s mock guards, or build its entries with the app\'s own builders.');
        // @ts-expect-error a mock takes its rate-limit policies at create(), from the generated table
        expect(() => declared.defineApiModule({ guards: { cardHolder }, rateLimitPolicies: { redeemPerCard: { perMin: 1 } } })).toThrow(/defineApiModule\(\) takes guards alone/);
    });

    it('overrides one of its registered handlers with its guards typed', async () => {
        const mockApp = createMockApp();
        const giftCardMocks = mockApp.defineApiModule({ guards: { cardHolder } });
        mockApp.registerPartial(giftCardMocks.apiSlice(giftCardMocks.api('giftCards.balance', { guards: 'cardHolder', handler: async () => ({ cardNumber: 'first' }) })));
        const override = giftCardMocks.override('giftCards.balance', async ({ guardData }) => ({ cardNumber: `${guardData.cardHolder.holder}:${guardData.cardHolder.cardNumber}` }));
        const jar = new LambderCookieJar();
        await mockApp.signIn('ada', { customerId: 'ada' }, { jar });
        expect(await callerOf(mockApp, jar).giftCards.balance({}, { guardInputs: { cardHolder: { cardNumber: 'c-3' } } })).toEqual({ cardNumber: 'ada:c-3' });
        override.restore();
    });
});
