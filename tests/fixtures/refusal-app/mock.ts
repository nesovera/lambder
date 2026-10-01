import { initLambderMock } from "../../../src/mock.js";
import { orderRefusals } from "./vocabulary.js";
import type { lambder } from "./server.js";

type Contract = typeof lambder.ApiContract;

const mock = initLambderMock<Contract, { userId: string }>().declareRefusals(orderRefusals, { requireCodes: true });
const mockApp = mock.create({ guards: {} as never, sessions: true });

/** The mock's own helper, typed to the whole vocabulary. */
const refuseShort = (): never => mock.refuse("The wallet is short.", { code: "wallet-short" });

export const orderMocks = mockApp.apiSlice(
    // What orders.get declares.
    mockApp.api("orders.get", async ({ refuse }) => refuse("No such order.", { code: "order-missing", data: { orderId: "1" } })),
    // wallet-short, which orders.cancel does not declare.
    mockApp.api("orders.cancel", async () => refuseShort()),
);
