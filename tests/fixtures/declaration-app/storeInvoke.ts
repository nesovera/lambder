import { LambderInvokeCaller, type LambderInvokeFailureHandler } from "lambder";
import type { StoreApiContract } from "./storeEntry.js";

const reportFailure: LambderInvokeFailureHandler = () => {};

/** Another function's caller, over the store's contract. */
export const storeCaller = new LambderInvokeCaller<StoreApiContract>({
    functionName: "store-function",
    requestCompression: true,
    onFailure: reportFailure,
});
