import { z } from "zod";
import { initLambder, lambderGuard, LambderMemorySessionStore } from "../../../src/index.js";

/*
 * The instance both versions of the fixture store register their APIs on: a
 * session, a parameterized guard that needs it (so the endpoints declaring it
 * are session endpoints) and a guardInput one, and a refusal vocabulary with
 * a code the guard raises, so the printed contract carries every kind of
 * entry an app's does.
 */

type StorePermission = "orders.read" | "orders.manage";

export const storeApp = () => initLambder<{ customerId: string }>().declareRefusals({
    "order-closed": {},
    "not-permitted": {},
    "refund-too-large": { data: z.object({ refundable: z.number(), placedAt: z.date() }) },
}).create({
    apiPath: "/api",
    session: { store: new LambderMemorySessionStore(), sessionSalt: "salt" },
    guards: {
        storePermission: lambderGuard({ session: true, refusals: ["not-permitted"], handler: async (_ctx, _payload, permission: StorePermission) => ({ permission }) }),
        captcha: lambderGuard({ guardInput: z.object({ token: z.string() }), handler: async () => {} }),
    },
});
