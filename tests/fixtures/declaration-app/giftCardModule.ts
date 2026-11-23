import { z } from "zod";
import { storeApp, type StoreLambder } from "./storeApp.js";
import { storeInit } from "./storeInit.js";

/*
 * A module of the sample store with guards, a rate-limit policy and an API
 * fact of its own: the instance knows nothing of them, and the module's
 * endpoints name them beside the instance's.
 */

export const giftCardGuards = {
    cardHolder: storeInit.guard({
        guardInput: z.object({ cardNumber: z.string() }),
        refusals: ["card-empty"],
        handler: (ctx, { cardNumber }) => {
            if(cardNumber === "empty") ctx.refuse("This card is empty.", { code: "card-empty" });
            return { cardNumber, balance: 25 };
        },
    }),
};

export const giftCardRateLimitPolicies = {
    redeemPerCustomer: { perHour: 5, per: "session" },
} as const;

/** What the module's endpoints state beside the store's own facts: whether one moves a card's balance. */
export const giftCardApiFacts = z.object({ movesBalance: z.boolean().default(false) });

export const giftCardModule = storeApp.defineApiModule({ guards: giftCardGuards, rateLimitPolicies: giftCardRateLimitPolicies, apiFacts: giftCardApiFacts });

export type GiftCardModule = typeof giftCardModule;
export type GiftCardContext = import("lambder").LambderRenderContextOf<GiftCardModule>;

// The module's builders handed out under its name, as the instance's are.
export const defineApi: GiftCardModule["defineApi"] = giftCardModule.defineApi;
export const defineApiGroup: GiftCardModule["defineApiGroup"] = giftCardModule.defineApiGroup;
export const lazyApiGroup: GiftCardModule["lazyApiGroup"] = giftCardModule.lazyApiGroup;

/** The module's type written out by hand, for an app that annotates it rather than inferring it. */
export type GiftCardModuleWritten = import("lambder").LambderApiModule<import("lambder").LambderModuleAppTypes<StoreLambder["AppTypes"], typeof giftCardGuards, typeof giftCardRateLimitPolicies, typeof giftCardApiFacts>>;

/** The inferred module assigned to its written type: the two are one type, so an app may annotate the module and keep its declaration file small. */
export const giftCardModuleAnnotated: GiftCardModuleWritten = giftCardModule;
