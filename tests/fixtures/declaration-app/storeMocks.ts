import { z } from "zod";
import { initLambderMock, lambderMockPoliciesFrom } from "lambder/mock";
import type { StoreApiContract } from "./storeEntry.js";
import { StoreSessionSchema, storeRefusals, type StoreSession } from "./storeInit.js";
import { apiOptions, apiSchemas, guardDeclarations, rateLimitPolicies } from "./storeMockTables.js";

/*
 * The sample store's mock as an app's dev mock is built: the server's
 * vocabulary declared on the init, the generated tables given to create(),
 * so each entry is its handler; the app's own mock guards at create(), and
 * the gift card module's declared with its entries.
 */

export const storeMock = initLambderMock<StoreApiContract, StoreSession>().declareRefusals(storeRefusals, { requireCodes: true });
export const refuse: typeof storeMock.refuse = storeMock.refuse;

export const storeMockApp = storeMock.create({
    apiVersion: "1.0.0",
    sessions: { dataSchema: StoreSessionSchema },
    idempotency: true,
    rateLimits: {
        policies: lambderMockPoliciesFrom(rateLimitPolicies, {
            keys: { receiptsPerEmail: storeMock.rateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email.toLowerCase() }) },
        }),
    },
    guards: {
        signedIn: storeMock.guard({ session: true, handler: () => {} }),
        open: storeMock.guard({ handler: (_ctx, _input, _reason: string) => {} }),
        staff: storeMock.guard({ session: true, refusals: ["not-staff"], handler: (_ctx, _input, permission: "orders.read" | "orders.refund") => ({ permission, customerId: "c-1" }) }),
        storeFront: storeMock.guard({ guardInput: z.object({ storeId: z.string() }), handler: (_ctx, { storeId }) => ({ storeId }) }),
        orderToken: storeMock.guard({ apiInput: z.object({ orderToken: z.string() }), handler: (_ctx, { orderToken }) => ({ orderToken }) }),
    },
    guardDeclarations,
    apiOptions,
    apiSchemas,
});

export const orderMockSlice = storeMockApp.apiSlice(
    storeMockApp.api("orders.get", async ({ payload }) => ({ orderId: payload.orderId, total: 12, placedAt: new Date(0).toISOString() })),
    storeMockApp.api("orders.refund", async ({ payload }) => payload.amount > 100 ? refuse("Too large.", { code: "refund-too-large", data: { refundable: 100 } }) : { refunded: payload.amount }),
    storeMockApp.api("orders.receipt", async () => ({ sent: true })),
    storeMockApp.notMocked("reports.daily", "The daily count is not mocked."),
);

export const giftCardMocks = storeMockApp.defineApiModule({
    guards: {
        cardHolder: storeMock.guard({
            guardInput: z.object({ cardNumber: z.string() }),
            refusals: ["card-empty"],
            handler: (_ctx, { cardNumber }) => ({ cardNumber, balance: 25 }),
        }),
    },
});

export const giftCardMockSlice = giftCardMocks.apiSlice(
    giftCardMocks.api("giftCards.redeem", async ({ guardData }) => ({ balance: guardData.cardHolder.balance })),
);

/** The registry as an app's mock setup registers it: every endpoint, once. */
export const registeredStoreMockApp = storeMockApp.register(orderMockSlice, giftCardMockSlice);
export const overrideRedeem = () => giftCardMocks.override("giftCards.redeem", async () => ({ balance: 0 }));
