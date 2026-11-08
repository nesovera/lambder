import { z } from "zod";
import { defineApi, defineApiGroup } from "./storeApp.js";

/** The sample store's order endpoints: every kind of guard, rate limit and refusal an endpoint declares. */
export const orderApis = defineApiGroup("orders", {
    get: defineApi({
        input: z.object({ orderId: z.string() }),
        output: z.object({ orderId: z.string(), total: z.number(), placedAt: z.date() }),
        guards: { staff: "orders.read" },
        rateLimit: "browsePerIp",
    }, async (ctx) => ({ orderId: ctx.apiPayload.orderId, total: 12, placedAt: new Date(0) })),
    refund: defineApi({
        input: z.object({ orderId: z.string(), amount: z.number() }),
        output: z.object({ refunded: z.number() }),
        guards: { staff: "orders.refund", storeFront: true },
        rateLimit: { writesPerCustomer: { perMin: 2 } },
        refusals: ["order-closed", "refund-too-large"],
        idempotency: true,
    }, async (ctx) => {
        await ctx.rateLimit("refundsPerStore", ctx.guardData.storeFront.storeId);
        if(ctx.apiPayload.amount > 100) ctx.refuse("Too large.", { code: "refund-too-large", data: { refundable: 100 } });
        return { refunded: ctx.apiPayload.amount };
    }),
    receipt: defineApi({
        input: z.object({ orderToken: z.string(), email: z.string() }),
        output: z.object({ sent: z.boolean() }),
        guards: ["orderToken"],
        rateLimit: ["browsePerIp", "receiptsPerEmail"],
    }, async () => ({ sent: true })),
});
