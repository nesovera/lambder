import { initLambderMock } from "../../../src/mock.js";
import { orderRefusals } from "./vocabulary.js";
import type { lambder } from "./server.js";

type Contract = typeof lambder.ApiContract;

const mock = initLambderMock<Contract, { userId: string }>().declareRefusals(orderRefusals, { requireCodes: true });

/** The mock's own helper, typed to the whole vocabulary. */
const refuseShort = (): never => mock.refuse("The wallet is short.", { code: "wallet-short" });

/** A mock guard, its ctx.refuse typed to its own refusals as a server guard's is. */
const mockStaffOnly = mock.guard({
    session: true,
    refusals: ["not-staff"],
    handler: (ctx) => {
        if(ctx.session.data.userId !== "staff") ctx.refuse("Staff only.", { code: "not-staff" });
    },
});

/** A mock guard raising, through the mock's helper, a code it does not declare. */
const mockOpenOrder = mock.guard({ handler: () => refuseShort() });

const mockApp = mock.create({ guards: { staffOnly: mockStaffOnly, openOrder: mockOpenOrder }, sessions: true });

export const orderMocks = mockApp.apiSlice(
    // What orders.get declares.
    mockApp.api("orders.get", async ({ refuse }) => refuse("No such order.", { code: "order-missing", data: { orderId: "1" } })),
    // wallet-short, which orders.cancel does not declare.
    mockApp.api("orders.cancel", async () => refuseShort()),
);
