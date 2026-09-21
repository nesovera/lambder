/**
 * Mock entry point (`import ... from "lambder/mock"`).
 *
 * The mock runtime: the API core over memory stores, serving a typed
 * contract from mock handlers in development and in tests, in a browser or
 * in Node. Browser-safe like `lambder/client`, and never part of a
 * production bundle by construction: nothing else imports it.
 */
export { LambderMockApp, initLambderMock } from "./mock/LambderMockApp.js";
// The four collaborators behind LambderMockApp (the entry registry, the call
// recorder, the failure injector, the browser cookies) are deliberately not
// exported: the runtime is reached through the app, and its surface did not
// change when they moved out of it. Only the error a transport rejects with is
// public, as before.
export { LambderMockTransportError } from "./mock/LambderMockFailureInjector.js";
export { lambderMockConsoleLogger } from "./mock/lambderMockConsoleLogger.js";
export { lambderMockMswHandler } from "./mock/lambderMockMswHandler.js";
export { lambderMockInvokeTransport } from "./mock/lambderMockInvokeTransport.js";
// What a mock setup reaches for beside the app: the stores it runs on, the
// jar its transport carries, and the refusal a handler says no with.
export { LambderCookieJar } from "./shared/transport/LambderCookieJar.js";
export { lambderCookieJarTransport } from "./shared/transport/lambderCookieJarTransport.js";
export { LambderMemorySessionStore } from "./stores/LambderMemorySessionStore.js";
export { LambderMemoryRateLimiter } from "./stores/LambderMemoryRateLimiter.js";
export { LambderMemoryIdempotencyStore } from "./stores/LambderMemoryIdempotencyStore.js";
export { LambderWebCrypto, LambderPlainSessionCrypto } from "./session/LambderSessionCrypto.js";
export { LambderApiRefusal, refuse, LAMBDER_REFUSAL_CODES } from "./shared/wire/LambderApiRefusal.js";
// The outcome assertions a test over the mock app narrows with; the same two
// `lambder/testing` exports for a test over the real server.
export { assertApiSuccess, assertApiFailure } from "./shared/wire/LambderOutcomeAssertions.js";
