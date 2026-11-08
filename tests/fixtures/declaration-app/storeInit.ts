import { z } from "zod";
import { initLambder, lambderRateLimitKey, type LambderApiRateLimitPolicyConfig } from "lambder";

/*
 * The sample store's init, guards and rate-limit policies: what an app
 * declares before its instance, each exported, as an app split into projects
 * exports them for its other parts to import.
 */

export const StoreSessionSchema = z.object({ customerId: z.string(), staff: z.boolean() });
export type StoreSession = z.infer<typeof StoreSessionSchema>;

/** The refusal vocabulary, shared code: the server's init declares it, and the mock declares the same object. */
export const storeRefusals = {
    "not-staff": {},
    "order-closed": { status: 409 },
    "refund-too-large": { data: z.object({ refundable: z.number() }) },
    "card-empty": {},
} as const;

export const storeInit = initLambder<StoreSession>().declareRefusals(storeRefusals, { requireCodes: true });

export const storeGuards = {
    signedIn: storeInit.guard({ session: true, handler: () => {} }),
    open: storeInit.guard({ handler: (_ctx, _input, _reason: string) => {} }),
    staff: storeInit.guard({
        session: true,
        refusals: ["not-staff"],
        handler: (ctx, _input, permission: "orders.read" | "orders.refund") => {
            if(!ctx.session.data.staff) ctx.refuse("Staff only.", { code: "not-staff" });
            return { permission, customerId: ctx.session.data.customerId };
        },
    }),
    storeFront: storeInit.guard({
        guardInput: z.object({ storeId: z.string() }),
        handler: (_ctx, { storeId }) => ({ storeId }),
    }),
    orderToken: storeInit.guard({
        apiInput: z.object({ orderToken: z.string() }),
        handler: (_ctx, { orderToken }) => ({ orderToken }),
    }),
};

export const storeRateLimitPolicies = {
    browsePerIp: { perMin: 60, per: "ip" },
    writesPerCustomer: { perMin: 10, per: "session" },
    receiptsPerEmail: {
        perHour: 5,
        budget: "perPolicy",
        per: lambderRateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email.toLowerCase() }),
        refusal: { type: "warning", content: "Too many receipts for this address." },
    },
    refundsPerStore: { perDay: 20 },
} as const satisfies Record<string, LambderApiRateLimitPolicyConfig>;

/** An init exported before its vocabulary is declared, as a shared package exports one for its apps to declare theirs on. */
export const plainStoreInit = initLambder<StoreSession>();
