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
 *
 * Beside the test app, the store conformance suites: the rules each store
 * interface promises the engines, for an app to run against a store it
 * writes itself.
 */
export { lambderTestApp } from "./testing/LambderTestApp.js";
export { assertApiSuccess, assertApiFailure, assertApiRefusal } from "./shared/wire/LambderOutcomeAssertions.js";
// The rules each store interface promises, as cases an app registers with its
// own runner's `it` and `expect` to hold a store it writes over its own
// database to the same rules Lambder's memory and DynamoDB stores meet.
export { lambderSessionStoreConformance } from "./testing/lambderSessionStoreConformance.js";
export { lambderIdempotencyStoreConformance } from "./testing/lambderIdempotencyStoreConformance.js";
export { lambderRateLimiterConformance } from "./testing/lambderRateLimiterConformance.js";
export { lambderOneShotSecretStoreConformance } from "./testing/lambderOneShotSecretStoreConformance.js";
// What a test reaches for beside the test app: the stores to inspect or to
// hand it, a file source over fixtures, the refusal codes to assert on, and
// the types of what a visitor and its session hand back.
export { LambderMemorySessionStore } from "./stores/LambderMemorySessionStore.js";
export { LambderMemoryRateLimiter } from "./stores/LambderMemoryRateLimiter.js";
export { LambderMemoryIdempotencyStore } from "./stores/LambderMemoryIdempotencyStore.js";
export { LambderMemoryOneShotSecretStore } from "./stores/LambderMemoryOneShotSecretStore.js";
export { LambderMemoryCache } from "./stores/LambderMemoryCache.js";
export { LambderMemoryUploadBucket } from "./stores/LambderMemoryUploadBucket.js";
export { LambderLocalFileSource } from "./stores/LambderLocalFileSource.js";
export { LambderCookieJar } from "./shared/transport/LambderCookieJar.js";
export { LAMBDER_REFUSAL_CODES } from "./shared/wire/LambderApiRefusal.js";
