import { z } from "zod";
import { initLambder, LambderMemorySessionStore } from "../../../src/index.js";
import { orderRefusals } from "./vocabulary.js";
import { audited, orderHandlers, OrderMissingRefusal, refuseClosed, refusePlainly, refuseWith, requireOrder, Wallet, WalletShortRefusal } from "./helpers.js";

export const init = initLambder<{ userId: string }>().declareRefusals(orderRefusals, { requireCodes: true });

const staffOnly = init.guard({
    session: true,
    refusals: ["not-staff"],
    handler: (ctx) => {
        if(ctx.session.data.userId !== "staff") ctx.refuse("Staff only.", { code: "not-staff" });
    },
});

/** A guard that raises a code it does not declare, through a helper. */
const openOrder = init.guard({
    refusals: ["order-closed"],
    handler: () => requireOrder("guarded"),
});

const app = init.create({
    apiPath: "/api",
    session: { store: new LambderMemorySessionStore(), sessionSalt: "salt" },
    guards: { staffOnly, openOrder },
});

const Empty = z.object({});

export const lambder = app.registerApiGroups(app.defineApiGroup("orders", {
    // Reaches exactly what it declares: its own code, and one through a helper.
    get: app.defineApi({ input: z.object({ orderId: z.string() }), output: Empty, refusals: ["order-missing", "order-closed"] }, async (ctx) => {
        if(ctx.apiPayload.orderId === "closed") refuseClosed();
        return requireOrder(ctx.apiPayload.orderId);
    }),
    // A helper raises order-missing, which it does not declare.
    cancel: app.defineApi({ input: Empty, output: Empty, refusals: "order-closed" }, async (ctx) => {
        if(Math.random() > 2) ctx.refuse("Closed.", { code: "order-closed" });
        return requireOrder("1");
    }),
    // A method raises wallet-short; its guard's code needs no declaration of its own.
    refund: app.defineApi({ input: Empty, output: Empty, guards: "staffOnly" }, async () => new Wallet().charge()),
    // Throws a refusal class of the app's own, whose code it does not declare.
    reopen: app.defineApi({ input: Empty, output: Empty, refusals: "order-closed" }, async (ctx) => {
        if(Math.random() > 2) ctx.refuse("Closed.", { code: "order-closed" });
        throw new OrderMissingRefusal();
    }),
    // Declares a code nothing it reaches raises.
    list: app.defineApi({ input: Empty, output: Empty, refusals: "wallet-short" }, async () => ({})),
    // Reaches a refusal with no code, through a function it hands along rather than calls.
    archive: app.defineApi({ input: Empty, output: Empty }, async () => {
        [1].forEach(refusePlainly);
        return {};
    }),
    // Reaches a refusal whose code is any string.
    tag: app.defineApi({ input: Empty, output: Empty }, async () => refuseWith("order-closed")),
    // Reaches wallet-short in a module it loads lazily.
    audit: app.defineApi({ input: Empty, output: Empty, guards: "openOrder" }, async () => {
        const { refuseLater } = await import("./lazyHelpers.js");
        return refuseLater();
    }),
    // Throws a refusal class that inherits LambderApiRefusal's constructor, with a code it does not declare.
    settle: app.defineApi({ input: Empty, output: Empty }, async () => {
        throw new WalletShortRefusal("Short.", { refusal: { type: "warning", code: "wallet-short", content: "Short." } });
    }),
    // Wrapped by the app: the handler inside reaches a helper's code it does not declare.
    hold: app.defineApi({ input: Empty, output: Empty }, audited(async () => requireOrder("1"))),
    // Held in an object and registered by reference, reaching a code it does not declare.
    drop: app.defineApi({ input: Empty, output: Empty }, orderHandlers.drop),
}));

/** An app's own wrapper around a registration: what it registers is a parameter, which the check cannot follow. */
export const quietApi = (handler: () => Promise<{}>) => app.defineApi({ input: Empty, output: Empty }, handler);
