/**
 * Modules: guards and rate-limit policies a part of an app declares for its
 * own endpoints (defineApiModule), beside the ones its instance was created
 * with. A module's builders type its endpoints on the instance's names and
 * its own; registering their groups adds the module to the instance, a lazy
 * group's at registration rather than at its first call, and a name the
 * instance or another module declares is refused, as create() refuses a name
 * two of its maps declare.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { lambderGuard } from '../../src/core/LambderPolicyBuilders.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import { LambderMemoryRateLimiter } from '../../src/stores/LambderMemoryRateLimiter.js';
import { lambderTestApp, assertApiRefusal, assertApiSuccess } from '../../src/testing.js';
import { createMockContext, createMockEvent } from '../helpers.js';
import { LAMBDER_REFUSAL_CODES } from '../../src/shared/wire/LambderApiRefusal.js';
import type { LambderRenderContextOf } from '../../src/core/LambderContext.js';

type Session = { customerId: string };

const storeInit = initLambder<Session>().declareRefusals({ 'card-empty': {}, 'not-staff': {} });

const storeGuards = {
    signedIn: storeInit.guard({ session: true, handler: (ctx) => ({ customerId: ctx.session.data.customerId }) }),
    anyone: storeInit.guard({ handler: () => {} }),
};

/** A store's instance: its own guards and policies, and nothing of any module's. */
const createStoreApp = () => storeInit.create({
    apiPath: '/api',
    session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
    rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: { browsePerIp: { perMin: 100, per: 'ip' } } },
    guards: storeGuards,
});

/** The gift card module's own: a guard reading the card from the guard inputs, and two policies. */
const cardHolder = storeInit.guard({
    guardInput: z.object({ cardNumber: z.string() }),
    refusals: ['card-empty'],
    handler: (ctx, { cardNumber }) => {
        if(cardNumber === 'empty') ctx.refuse('This card is empty.', { code: 'card-empty' });
        return { cardNumber };
    },
});
const giftCardPolicies = {
    redeemPerCustomer: { perMin: 2, per: 'session' },
    balanceChecksPerCard: { perMin: 1, refusal: { type: 'warning', content: 'Too many balance checks for this card.' } },
} as const;

const giftCardApisOf = (app: ReturnType<typeof createStoreApp>) => {
    const giftCards = app.defineApiModule({ guards: { cardHolder }, rateLimitPolicies: giftCardPolicies });
    const apis = giftCards.defineApiGroup('giftCards', {
        redeem: giftCards.defineApi({
            input: z.object({ amount: z.number() }),
            output: z.object({ cardNumber: z.string(), customerId: z.string() }),
            guards: ['signedIn', 'cardHolder'],
            rateLimit: ['browsePerIp', 'redeemPerCustomer'],
        }, async (ctx) => {
            expectTypeOf(ctx.guardData.cardHolder).toEqualTypeOf<{ cardNumber: string }>();
            return { cardNumber: ctx.guardData.cardHolder.cardNumber, customerId: ctx.guardData.signedIn.customerId };
        }),
        balance: giftCards.defineApi({
            input: z.object({}),
            output: z.object({ checked: z.boolean() }),
            guards: 'cardHolder',
        }, async (ctx) => {
            await ctx.rateLimit('balanceChecksPerCard', ctx.guardData.cardHolder.cardNumber);
            return { checked: true };
        }),
    });
    return { giftCards, apis };
};

describe('A module', () => {
    it('declares endpoints that name the instance\'s guards and policies and its own, which run as the instance\'s do', async () => {
        const app = createStoreApp();
        const { apis } = giftCardApisOf(app);
        const lambder = app.registerApiGroups(apis);
        const testApp = lambderTestApp(lambder);
        const ada = await testApp.signIn('ada', { customerId: 'ada' });

        expect(await ada.giftCards.redeem({ amount: 5 }, { guardInputs: { cardHolder: { cardNumber: 'c-1' } } })).toEqual({ cardNumber: 'c-1', customerId: 'ada' });
        // The module's guard refuses with the code it declares, from the instance's vocabulary.
        assertApiRefusal(await ada.giftCards.redeem.outcome({ amount: 5 }, { guardInputs: { cardHolder: { cardNumber: 'empty' } } }), 'card-empty');
        // Two a minute per session, the module's own policy: the third is refused.
        assertApiRefusal(await ada.giftCards.redeem.outcome({ amount: 5 }, { guardInputs: { cardHolder: { cardNumber: 'c-1' } } }), LAMBDER_REFUSAL_CODES.rateLimited);
        // A policy a handler charges by name, with the key it supplies.
        const visitor = testApp.visitor();
        assertApiSuccess(await visitor.giftCards.balance.outcome({}, { guardInputs: { cardHolder: { cardNumber: 'c-2' } } }));
        const refused = await visitor.giftCards.balance.outcome({}, { guardInputs: { cardHolder: { cardNumber: 'c-2' } } });
        assertApiRefusal(refused, LAMBDER_REFUSAL_CODES.rateLimited);
        expect(refused.refusal.data.policy).toBe('balanceChecksPerCard');
    });

    it('types its endpoints on the instance\'s names and its own alone, and the instance\'s builders on the instance\'s alone', () => {
        const app = createStoreApp();
        const { giftCards } = giftCardApisOf(app);
        const input = z.object({});
        const output = z.object({});
        // @ts-expect-error unknownGuard is neither the instance's guard nor the module's
        expect(() => app.registerApiGroups(giftCards.defineApiGroup('cards', { a: giftCards.defineApi({ input, output, guards: 'unknownGuard' }, async () => ({})) }))).toThrow(/unknown guard "unknownGuard"/);
        // @ts-expect-error cardHolder is the module's: the instance's builders do not know it
        expect(() => app.registerApiGroups(app.defineApiGroup('cards', { a: app.defineApi({ input, output, guards: 'cardHolder' }, async () => ({})) }))).toThrow(/unknown guard "cardHolder"/);
        // @ts-expect-error redeemPerCustomer is the module's policy: the instance's builders do not know it
        app.defineApi({ input, output, guards: 'signedIn', rateLimit: 'redeemPerCustomer' }, async () => ({}));

        // Its context type, for a helper handed one of its handlers' contexts:
        // the module's policies are charged by name there, the instance's too.
        const chargeBalanceCheck = async (ctx: LambderRenderContextOf<typeof giftCards>) => {
            await ctx.rateLimit('balanceChecksPerCard', 'c-1');
            await ctx.rateLimit('browsePerIp');
            // @ts-expect-error neither the instance nor the module declares this policy
            await ctx.rateLimit('nightlyPerCard', 'c-1');
        };
        expect(chargeBalanceCheck).toBeTypeOf('function');
    });

    it('may not declare a name its instance declares, at compile time and where it is defined', () => {
        const app = createStoreApp();
        expect(() => app.defineApiModule({
            // @ts-expect-error signedIn is the instance's guard
            guards: { signedIn: storeInit.guard({ handler: () => {} }) },
        })).toThrow('Lambder: the guard "signedIn" of the module being defined is declared already, at creation or by a module registered before. A module declares names of its own: rename one of the two.');
        expect(() => app.defineApiModule({
            // @ts-expect-error browsePerIp is the instance's policy
            rateLimitPolicies: { browsePerIp: { perMin: 1, per: 'ip' } },
        })).toThrow(/the rate-limit policy "browsePerIp" of the module being defined is declared already/);
    });

    it('declares something, and holds its guards and policies to what create() holds its own to', () => {
        const app = createStoreApp();
        // @ts-expect-error a module needs a guard or a policy to declare
        expect(() => app.defineApiModule({})).toThrow(/defineApiModule\(\) was given no guard and no rate-limit policy/);
        // @ts-expect-error policies is not an option of defineApiModule; rateLimitPolicies is
        expect(() => app.defineApiModule({ policies: { a: { perMin: 1 } } })).toThrow(/no guard and no rate-limit policy/);
        expect(() => app.defineApiModule({ rateLimitPolicies: { never: {} } })).toThrow('Lambder: rate-limit policy "never" declares no window (perMin/per10Min/perHour/perDay/perWeek/perMonth).');
        // @ts-expect-error perMinute is not a window
        expect(() => app.defineApiModule({ rateLimitPolicies: { typo: { perMin: 1, perMinute: 2 } } })).not.toThrow();
        expect(() => app.defineApiModule({
            // @ts-expect-error a guard names codes from the instance's vocabulary
            guards: { strange: lambderGuard({ refusals: ['no-such-code'], handler: () => {} }) },
        })).toThrow('Lambder: guard "strange" declares the refusal "no-such-code", which the refusals vocabulary does not hold.');
        // @ts-expect-error twice is declared in both maps of the list
        expect(() => app.defineApiModule({ guards: [{ twice: storeInit.guard({ handler: () => {} }) }, { twice: storeInit.guard({ handler: () => {} }) }] }))
            .toThrow('Lambder: the guard "twice" is declared in two of the maps given to defineApiModule(). Declare each name once.');
    });

    it('refuses a name another module declares when the second is registered, and that registration leaves the instance as it was', async () => {
        const app = createStoreApp();
        const loyalty = app.defineApiModule({ rateLimitPolicies: { redeemPerCustomer: { perHour: 9, per: 'session' } } });
        const loyaltyApis = loyalty.defineApiGroup('loyalty', {
            points: loyalty.defineApi({ input: z.object({}), output: z.object({ points: z.number() }), guards: 'signedIn', rateLimit: 'redeemPerCustomer' }, async () => ({ points: 3 })),
        });
        const { apis: giftCardApis } = giftCardApisOf(app);
        const lambder = app.registerApiGroups(giftCardApis);
        expect(() => app.registerApiGroups(loyaltyApis)).toThrow(
            'Lambder: the rate-limit policy "redeemPerCustomer" of the module declaring "loyalty.points" is declared already, at creation or by a module registered before. A module declares names of its own: rename one of the two.',
        );

        const other = createStoreApp();
        const { apis: otherGiftCards } = giftCardApisOf(other);
        expect(() => other.registerApiGroups(otherGiftCards, loyaltyApis)).toThrow(
            'Lambder: the rate-limit policy "redeemPerCustomer" is declared by two modules, the one declaring "giftCards.redeem" and the one declaring "loyalty.points". Declare each name once.',
        );
        // Nothing of the refused registration was taken: neither module, nor either group's name.
        const entries = await other.apiOptionEntries();
        expect(Object.keys(entries.rateLimitPolicies)).toEqual(['browsePerIp']);
        expect(Object.keys(entries.guards)).toEqual(['anyone', 'signedIn']);
        other.registerApiGroups(otherGiftCards);

        // The same module's groups, registered in two calls, are one module.
        const third = createStoreApp();
        const { giftCards } = giftCardApisOf(third);
        const first = giftCards.defineApiGroup('first', { ping: giftCards.defineApi({ input: z.object({}), output: z.object({}), guards: 'cardHolder' }, async () => ({})) });
        const second = giftCards.defineApiGroup('second', { ping: giftCards.defineApi({ input: z.object({}), output: z.object({}), guards: 'cardHolder' }, async () => ({})) });
        third.registerApiGroups(first).registerApiGroups(second);
        expect(lambder).toBeDefined();
    });

    it('is added when its lazy group is registered, before the group loads: the options list it and a route may charge its policies', async () => {
        const app = createStoreApp();
        const { giftCards, apis } = giftCardApisOf(app);
        let loads = 0;
        const lambder = app.registerApiGroups(giftCards.lazyApiGroup('giftCards', async () => { loads++; return apis; }))
            .addRoute({ path: '/cards/:cardNumber', method: 'GET' }, async (ctx, res) => {
                const limited = await ctx.isRateLimited('balanceChecksPerCard', ctx.pathParams.cardNumber!);
                return res.text(limited ? 'limited' : 'ok');
            });

        const route = async () => (await lambder.render(createMockEvent('/cards/c-9'), createMockContext())).body;
        expect(await route()).toBe('ok');
        expect(await route()).toBe('limited');
        expect(loads).toBe(0);

        const entries = await lambder.apiOptionEntries();
        expect(loads).toBe(1);
        expect(Object.keys(entries.guards)).toEqual(['anyone', 'cardHolder', 'signedIn']);
        expect(Object.keys(entries.rateLimitPolicies)).toEqual(['balanceChecksPerCard', 'browsePerIp', 'redeemPerCustomer']);
        expect(entries.guards.cardHolder).toEqual({ input: 'guardInput', session: false, runAt: 'beforeInputValidation', refusals: ['card-empty'] });
        expect(Object.keys(await lambder.apiSignatures())).toHaveLength(2);
    });

    it('rides on its endpoints into any group, and a group of them registered lazily without the module is refused when it loads', async () => {
        const app = createStoreApp();
        const { giftCards } = giftCardApisOf(app);
        const redeem = giftCards.defineApi({ input: z.object({}), output: z.object({ ok: z.boolean() }), guards: 'cardHolder' }, async () => ({ ok: true }));
        // The instance's own group builder takes a module's endpoint: registering it adds the module.
        const mixed = app.registerApiGroups(app.defineApiGroup('counter', {
            redeem,
            hours: app.defineApi({ input: z.object({}), output: z.object({ open: z.boolean() }), guards: 'anyone' }, async () => ({ open: true })),
        }));
        expect(await lambderTestApp(mixed).visitor().counter.redeem({}, { guardInputs: { cardHolder: { cardNumber: 'c-1' } } })).toEqual({ ok: true });

        const other = createStoreApp();
        const late = other.registerApiGroups(other.lazyApiGroup('counter', async () => other.defineApiGroup('counter', { redeem })));
        await expect(late.loadApiGroups()).rejects.toThrow(
            'Lambder: lazy group "counter" loaded endpoints a module\'s builders declared, and was registered with a lazyApiGroup that does not carry that module. Register it with the module\'s own lazyApiGroup, so its guards and rate-limit policies are added at startup.',
        );
    });

    it('counts its policies on the instance\'s limiter, which an instance with no policies of its own still gives', async () => {
        const without = storeInit.create({ apiPath: '/api', session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' }, guards: storeGuards });
        expect(() => without.defineApiModule({ rateLimitPolicies: giftCardPolicies })).toThrow(
            'Lambder: the module being defined declares rate-limit policies, and no rateLimits option was given at creation, which gives the limiter they count on. Pass rateLimits at creation; on a server its own policies may be left out (rateLimits: { limiter }).',
        );
        // Guards alone need no limiter.
        without.defineApiModule({ guards: { cardHolder } });

        const limiterOnly = storeInit.create({ apiPath: '/api', rateLimits: { limiter: new LambderMemoryRateLimiter() } });
        const quotes = limiterOnly.defineApiModule({ rateLimitPolicies: { quotesPerIp: { perMin: 1, per: 'ip' } } });
        const lambder = limiterOnly.registerApiGroups(quotes.defineApiGroup('quotes', {
            get: quotes.defineApi({ input: z.object({}), output: z.object({ price: z.number() }), rateLimit: 'quotesPerIp' }, async () => ({ price: 4 })),
        }));
        const visitor = lambderTestApp(lambder).visitor();
        assertApiSuccess(await visitor.quotes.get.outcome({}));
        assertApiRefusal(await visitor.quotes.get.outcome({}), LAMBDER_REFUSAL_CODES.rateLimited);
        // An empty map is still refused: it declares nothing.
        expect(() => storeInit.create({ apiPath: '/api', rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: {} } })).toThrow(/declared with no policies in it/);
    });

    it('is added to whichever instance registers its groups, and checked against that one', () => {
        // An app with two functions builds one instance for each, alike, and
        // registers a module's groups on either.
        const main = createStoreApp();
        const { apis } = giftCardApisOf(main);
        const tiles = createStoreApp();
        tiles.registerApiGroups(apis);
        main.registerApiGroups(apis);

        const clashing = storeInit.create({
            apiPath: '/api',
            rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: { redeemPerCustomer: { perMin: 1, per: 'ip' } } },
            guards: { anyone: storeInit.guard({ handler: () => {} }) },
        });
        expect(() => clashing.registerApiGroups(apis)).toThrow(/the guard "cardHolder" of the module declaring "giftCards.redeem" is declared already|the rate-limit policy "redeemPerCustomer" of the module declaring "giftCards.redeem" is declared already/);
    });
});
