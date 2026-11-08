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
    }, async (ctx) => {
        await ctx.rateLimit("refundsPerStore", ctx.guardData.cardHolder.cardNumber);
        return { balance: ctx.guardData.cardHolder.balance - ctx.apiPayload.amount };
    }),
});
