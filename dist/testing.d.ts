/**
 * Testing entry point (`import ... from "lambder/testing"`).
 *
 * A real Lambder app under test, in this process: the instance an app
 * already has, memory stores put under it in place, and simulated browsers
 * in front of it, each with a typed caller and a cookie jar of its own.
 * Server-only, like the root entry, and never part of a deployment by
 * construction: nothing else imports it.
 *
 * The sibling of `lambder/mock`, which serves a contract from mock handlers
 * for frontend work. This one runs the real handlers.
 */
export { lambderTestApp } from "./testing/LambderTestApp.js";
export type { LambderTestApp, LambderTestAppOptions, LambderTestedInstance } from "./testing/LambderTestApp.js";
export type { LambderTestVisitor, LambderTestVisitorOptions, LambderTestRequestInit } from "./testing/LambderTestVisitor.js";
export { assertApiSuccess, assertApiFailure } from "./shared/wire/LambderOutcomeAssertions.js";
export type { LambderExpectedFailure } from "./shared/wire/LambderOutcomeAssertions.js";
export { LambderMemorySessionStore } from "./stores/LambderMemorySessionStore.js";
export { LambderMemoryRateLimiter } from "./stores/LambderMemoryRateLimiter.js";
export { LambderMemoryIdempotencyStore } from "./stores/LambderMemoryIdempotencyStore.js";
export { LambderMemoryCache } from "./stores/LambderMemoryCache.js";
export { LambderLocalFileSource } from "./stores/LambderLocalFileSource.js";
export { LambderCookieJar } from "./shared/transport/LambderCookieJar.js";
export { LAMBDER_REFUSAL_CODES } from "./shared/wire/LambderApiRefusal.js";
export type { LambderLambdaHttpResult } from "./invoke/LambderLambdaEvent.js";
export type { LambderCreatedSession } from "./session/LambderSessionManager.js";
export type { LambderApiOutcome, LambderApiFailureReason } from "./shared/wire/LambderApiOutcome.js";
