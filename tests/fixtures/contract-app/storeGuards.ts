import { z } from "zod";
import { initLambder, lambderGuard, LambderMemorySessionStore } from "../../../src/index.js";

/*
 * The instance both versions of the fixture store register their APIs on: a
 * session, a parameterized guard and a guardInput one, so the printed
 * contract carries every kind of entry an app's does.
 */

type StorePermission = "orders.read" | "orders.manage";

export const storeApp = () => initLambder<{ customerId: string }>().create({
    apiPath: "/api",
    session: { store: new LambderMemorySessionStore(), sessionSalt: "salt" },
    guards: {
        storePermission: lambderGuard({ handler: async (_ctx, _payload, permission: StorePermission) => ({ permission }) }),
        captcha: lambderGuard({ guardInput: z.object({ token: z.string() }), handler: async () => {} }),
    },
});
