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
// exported: the runtime is reached through the app. Only the error a
// transport rejects with is public.
export { LambderMockTransportError } from "./mock/LambderMockFailureInjector.js";
export type { LambderMockAppOptions, LambderMockSessionsOptions, LambderMockIdempotencyOptions, LambderMockInvalidInputAnswer, LambderMockTransport, LambderMockTransportOptions } from "./mock/LambderMockCreateOptions.js";
export type {
    LambderMockCallContext,
    LambderMockSessionCallContext,
    LambderMockContext,
    LambderMockGuards,
    LambderMockHandler,
    LambderMockEntry,
    LambderMockEntryOptions,
    LambderMockEntryInput,
    LambderMockSlice,
    LambderMockRestEntry,
    LambderMockRegistryCheck,
    LambderMockMissingNames,
    LambderMockStrayNames,
    LambderMockDuplicateNames,
    LambderMockPublicNames,
    LambderMockSessionNames,
    LambderMockLatency,
    LambderMockFailure,
    LambderMockFailureReason,
    LambderMockOutcome,
    LambderMockCallEvent,
    LambderMockRequestEvent,
    LambderMockResponseEvent,
    LambderMockCallRecord,
    LambderMockListener,
    LambderMockRateLimitPolicies,
    LambderMockInputOf,
    LambderMockOutputOf,
    LambderMockOverride,
} from "./mock/LambderMockTypes.js";
export { lambderMockConsoleLogger } from "./mock/lambderMockConsoleLogger.js";
export type { LambderMockConsoleLoggerOptions } from "./mock/lambderMockConsoleLogger.js";
export { lambderMockMswHandler } from "./mock/lambderMockMswHandler.js";
export type { LambderMswModule, LambderMockMswTarget } from "./mock/lambderMockMswHandler.js";
export { lambderMockInvokeTransport } from "./mock/lambderMockInvokeTransport.js";
// The event and answer shapes that transport reads and returns, declared
// structurally so the mock entry's type graph reaches neither aws-lambda nor
// the Lambda SDK; a caller that names them needs them from here.
export type { LambderMockInvokeEvent, LambderMockInvokeResult } from "./mock/lambderMockInvokeTransport.js";

// What a mock setup reaches for beside the app: the stores it runs on, the
// jar its transport carries, and the refusal a handler says no with.
export { LambderCookieJar } from "./shared/transport/LambderCookieJar.js";
export { lambderCookieJarTransport } from "./shared/transport/lambderCookieJarTransport.js";
export type { LambderApiTransport, LambderApiTransportRequest } from "./shared/transport/LambderApiTransport.js";
export { LambderMemorySessionStore } from "./stores/LambderMemorySessionStore.js";
export { LambderMemoryRateLimiter } from "./stores/LambderMemoryRateLimiter.js";
export { LambderMemoryIdempotencyStore } from "./stores/LambderMemoryIdempotencyStore.js";
export { LambderWebCrypto, LambderPlainSessionCrypto } from "./session/LambderSessionCrypto.js";
export type { LambderSessionCrypto } from "./session/LambderSessionCrypto.js";
export { LambderApiRefusal, refuse, LAMBDER_REFUSAL_CODES } from "./shared/wire/LambderApiRefusal.js";
export type { LambderRefusalMessage } from "./shared/wire/LambderApiRefusal.js";
// The outcome assertions a test over the mock app narrows with; the same two
// `lambder/testing` exports for a test over the real server.
export { assertApiSuccess, assertApiFailure } from "./shared/wire/LambderOutcomeAssertions.js";
export type { LambderExpectedFailure } from "./shared/wire/LambderOutcomeAssertions.js";
export type { LambderApiRequest } from "./api/LambderApiRequest.js";
export type { LambderApiAnswer } from "./api/LambderApiAnswer.js";
export type { LambderSessionRecord } from "./shared/contracts/LambderSessionStore.js";
// The return types of the two session members this entry hands out, so a
// consumer can name what signIn() and the sessionManager getter gave it
// without importing from a deep path the package does not publish.
export type { LambderCreatedSession } from "./session/LambderSessionManager.js";
export type { default as LambderSessionManager } from "./session/LambderSessionManager.js";
// The status union every refusal option names; browser and mock code declares statuses too.
export type { LambderHttpStatusCode } from "./shared/wire/LambderHttpStatus.js";
