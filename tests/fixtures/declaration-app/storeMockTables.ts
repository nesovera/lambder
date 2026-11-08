/*
 * The tables writeApiOptions and writeApiSchemas write for the sample store,
 * as a mock imports them: every endpoint's declared options, every guard's
 * and policy's declaration, and every endpoint's schemas.
 */

export const apiOptions = {
    "giftCards.redeem": { mode: "session", guards: ["signedIn", "cardHolder"], rateLimit: ["browsePerIp", "redeemPerCustomer"], idempotency: true },
    "orders.get": { mode: "session", guards: { staff: "orders.read" }, rateLimit: "browsePerIp" },
    "orders.receipt": { mode: "public", guards: ["orderToken"], rateLimit: ["browsePerIp", "receiptsPerEmail"] },
    "orders.refund": { mode: "session", guards: { staff: "orders.refund", storeFront: true }, rateLimit: { writesPerCustomer: { perMin: 2 } }, idempotency: true, refusals: ["order-closed", "refund-too-large"] },
    "reports.daily": { mode: "public", guards: { open: "The daily count is public." } },
} as const;

export const guardDeclarations = {
    cardHolder: { input: "guardInput", session: false, runAt: "beforeInputValidation", refusals: ["card-empty"] },
    open: { input: "none", session: false, runAt: "beforeInputValidation" },
    orderToken: { input: "apiInput", session: false, runAt: "beforeInputValidation" },
    signedIn: { input: "none", session: true, runAt: "beforeInputValidation" },
    staff: { input: "none", session: true, runAt: "beforeInputValidation", refusals: ["not-staff"] },
    storeFront: { input: "guardInput", session: false, runAt: "beforeInputValidation" },
} as const;

export const rateLimitPolicies = {
    browsePerIp: { perMin: 60, per: "ip" },
    receiptsPerEmail: { perHour: 5, per: "custom", budget: "perPolicy", refusal: { type: "warning", content: "Too many receipts for this address." } },
    redeemPerCustomer: { perHour: 5, per: "session" },
    refundsPerStore: { perDay: 20 },
    writesPerCustomer: { perMin: 10, per: "session" },
} as const;

const anything = { type: "object" } as const;
export const apiSchemas = {
    "giftCards.redeem": { input: anything, output: anything },
    "orders.get": { input: anything, output: anything },
    "orders.receipt": { input: anything, output: anything },
    "orders.refund": { input: anything, output: anything },
    "reports.daily": { input: anything, output: anything },
} as const;
