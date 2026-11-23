import { z } from "zod";
import { defineApi, defineApiGroup } from "./giftCardModule.js";

/** The gift card module's endpoints: each names the instance's guards and policies and the module's own. */
export const giftCardApis = defineApiGroup("giftCards", {
    redeem: defineApi({
        input: z.object({ amount: z.number() }),
        output: z.object({ balance: z.number() }),
        guards: ["signedIn", "cardHolder"],
        rateLimit: ["browsePerIp", "redeemPerCustomer"],
        idempotency: true,
        facts: { movesBalance: true },
    }, async (ctx) => {
        await ctx.rateLimit("refundsPerStore", ctx.guardData.cardHolder.cardNumber);
        // The store's fact and the module's own, both typed and present.
        const spent = ctx.apiFacts.movesBalance && !ctx.apiFacts.readOnly ? ctx.apiPayload.amount : 0;
        return { balance: ctx.guardData.cardHolder.balance - spent };
    }),
});
