import { z } from "zod";
import { storeApp } from "./storeGuards.js";

const app = storeApp();

/** A store's API, as build-contract.test.ts first prints it. */
export const lambder = app.registerApiGroups(
    app.defineApiGroup("orders", {
        get: app.defineApi({
            input: z.object({ orderId: z.string(), expand: z.boolean().default(false) }),
            output: z.object({ orderId: z.string(), placedAt: z.date(), total: z.number(), status: z.enum(["open", "paid"]) }),
            guards: { storePermission: "orders.read" },
        }, async (_ctx) => null as never),
        cancel: app.defineApi({
            input: z.object({ orderId: z.string() }),
            output: z.object({ cancelled: z.boolean() }),
            guards: { storePermission: "orders.manage" },
            refusals: "order-closed",
        }, async (_ctx) => ({ cancelled: true })),
    }),
    app.defineApiGroup("store", {
        hours: app.defineApi({
            input: z.void(),
            output: z.array(z.object({ day: z.string(), opens: z.string().nullable() })),
            guards: ["captcha"],
        }, async (_ctx) => []),
    }),
);
