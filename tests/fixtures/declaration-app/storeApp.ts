import { LambderMemoryIdempotencyStore, LambderMemoryRateLimiter, LambderMemorySessionStore, type LambderRenderContextOf, type LambderSessionRenderContextOf } from "lambder";
import { StoreSessionSchema, storeGuards, storeInit, storeRateLimitPolicies } from "./storeInit.js";

/**
 * An instance configured as the store's, with every typed policy the
 * builders read: a factory, as an app with a function per role builds one
 * instance for each, alike.
 */
export const createStoreApp = () => storeInit.create({
    apiPath: "/api",
    session: { store: new LambderMemorySessionStore(), sessionSalt: "a-salt-for-the-sample-store", dataSchema: StoreSessionSchema },
    rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: storeRateLimitPolicies, failOpen: true },
    guards: storeGuards,
    requireApiGuards: true,
    idempotency: { store: new LambderMemoryIdempotencyStore() },
});

/** The main function's instance. */
export const storeApp = createStoreApp();

export type StoreLambder = typeof storeApp;
export type StoreContext = LambderRenderContextOf<StoreLambder>;
export type StoreSessionContext = LambderSessionRenderContextOf<StoreLambder>;

// The builders handed out under the instance's name: each declaration then
// refers to the app's types through `StoreLambder`.
export const defineApi: StoreLambder["defineApi"] = storeApp.defineApi;
export const defineApiGroup: StoreLambder["defineApiGroup"] = storeApp.defineApiGroup;
export const lazyApiGroup: StoreLambder["lazyApiGroup"] = storeApp.lazyApiGroup;
