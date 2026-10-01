import { LambderApiRefusal, refuse } from "../../../src/index.js";
import { init } from "./server.js";

// Shared helpers: none has an endpoint in hand, so each raises with the
// init's refuse, typed to the whole vocabulary, or the free one.

const ORDER_CLOSED = "order-closed" as const;

export const requireOrder = (orderId: string): never => init.refuse("No such order.", { code: "order-missing", data: { orderId } });

/** Its code held in a constant, which still reads as the literal. */
export const refuseClosed = (): never => init.refuse("Closed.", { code: ORDER_CLOSED });

export class Wallet {
    charge(): never {
        return init.refuse("The wallet is short.", { code: "wallet-short" });
    }
}

/** No code at all, which an app that requires codes answers as a crash. */
export const refusePlainly = (): never => refuse("Not today.");

/** A refusal of the app's own class, with a code, raised wherever it is constructed. */
export class OrderMissingRefusal extends LambderApiRefusal {
    constructor() {
        super("No such order.", { refusal: { type: "warning", code: "order-missing", content: "No such order." } });
    }
}

/** A code only known at run time. */
export const refuseWith = (code: string): never => refuse("Something.", { code });

/** A refusal class of the app's own that declares no constructor, so it is built by LambderApiRefusal's. */
export class WalletShortRefusal extends LambderApiRefusal {}

/** A wrapper an app puts around a handler, handing back the one it is given. */
export const audited = <T>(handler: T): T => handler;

/** Handlers held in an object and registered by reference. */
export const orderHandlers = { drop: async (): Promise<{}> => refuseClosed() };
