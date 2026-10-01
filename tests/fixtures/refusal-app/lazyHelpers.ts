import { init } from "./server.js";

/** Loaded by an endpoint with import(), which the check follows as it does a static import. */
export const refuseLater = (): never => init.refuse("The wallet is short.", { code: "wallet-short" });
