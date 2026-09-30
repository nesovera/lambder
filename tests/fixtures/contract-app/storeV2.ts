import { z } from "zod";
import { storeApp } from "./storeGuards.js";

const app = storeApp();

/**
 * The same store a release later: orders.get answers one more field,
 * orders.cancel is gone, orders.refund is new, and store.hours is as it was.
 */
export const lambder = app.registerApiGroups(
    app.defineApiGroup("orders", {
        get: app.defineApi({
            input: z.object({ orderId: z.string(), expand: z.boolean().default(false) }),
            output: z.object({ orderId: z.string(), placedAt: z.date(), total: z.number(), status: z.enum(["open", "paid"]), note: z.string().optional() }),
            guards: { storePermission: "orders.read" },
        }, async (_ctx) => null as never),
        refund: app.defineApi({
            input: z.object({ orderId: z.string(), amount: z.number() }),
            output: z.object({ refunded: z.boolean() }),
            guards: { storePermission: "orders.manage" },
            refusals: ["order-closed", "refund-too-large"],
        }, async (_ctx) => ({ refunded: true })),
    }),
    app.defineApiGroup("store", {
        hours: app.defineApi({
            input: z.void(),
            output: z.array(z.object({ day: z.string(), opens: z.string().nullable() })),
            guards: ["captcha"],
        }, async (_ctx) => []),
    }),
);
