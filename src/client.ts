/**
 * Browser entry point (`import ... from "lambder/client"`).
 *
 * Everything reachable from here is browser-safe: no AWS SDK, no Node
 * built-ins, no server pipeline. Frontends and isomorphic shared packages
 * import from this entry so their bundles can never pick up server code;
 * the root entry (`"lambder"`) is the server surface.
 */

// The typed API caller, and how it reaches the server.
export { default as LambderCaller } from "./client/LambderCaller.js";
export { DEFAULT_SESSION_TOKEN_COOKIE_KEY, DEFAULT_SESSION_CSRF_COOKIE_KEY } from "./shared/wire/LambderSessionCookieNames.js";
export { lambderFetchTransport } from "./client/lambderFetchTransport.js";
export { buildTransportEnvelope, LambderTransportFailure, isLambderTransportFailure } from "./shared/transport/LambderApiTransport.js";
export { lambderCookieJarTransport } from "./shared/transport/lambderCookieJarTransport.js";
export type { LambderApiTransport, LambderApiTransportRequest, LambderTransportFailureReason } from "./shared/transport/LambderApiTransport.js";
export { LambderCookieJar, parseSetCookie } from "./shared/transport/LambderCookieJar.js";
export type { LambderStoredCookie } from "./shared/transport/LambderCookieJar.js";
export { resolveApiOutcome } from "./shared/wire/LambderApiOutcome.js";
// The per-endpoint signature map a build ships with, how a caller reads it, and the reload-loop window.
export { apiNameKeyOf, lookupApiSignature, readApiSignature, API_SIGNATURE_HEX_LENGTH } from "./shared/wire/LambderApiSignature.js";
export type { LambderApiSignatureMap } from "./shared/wire/LambderApiSignature.js";
export { RELOAD_LOOP_WINDOW_MS } from "./client/LambderReloadLoopBreaker.js";
export { compareDottedVersions, isDottedVersion } from "./shared/wire/LambderVersionOrder.js";
// resolveApiOutcome's own return type and the arms of the outcome union, so a
// consumer reading an answer or narrowing a failure can name what it holds.
export type {
    LambderApiAnswerOutcome,
    LambderApiSuccessOutcome,
    LambderApiCallFailure,
    LambderApiValidationFailure,
    LambderApiEnvelopeFailure,
    LambderApiHttpAnswer,
} from "./shared/wire/LambderApiOutcome.js";
export type {
    LambderApiOutcome,
    LambderApiFailureReason,
    LambderValidationError,
    LambderCallOptions,
    LambderCallerOptions,
    LambderGuardInputsProvider,
    LambderProvidedGuardInputs,
    LambderIdempotencyKeyScope,
    LambderLogListHandler,
} from "./client/LambderCaller.js";

// Typed API refusals (isomorphic: shared code may throw them from anywhere;
// in the browser they are plain Errors).
export { LambderApiRefusal, isLambderApiRefusal, refuse, LAMBDER_REFUSAL_CODES } from "./shared/wire/LambderApiRefusal.js";
export type { LambderApiRefusalOptions, LambderRefusalMessage, LambderAppRefusalMessage, LambderRefusalCode, LambderRefuseOptions } from "./shared/wire/LambderApiRefusal.js";

// The API contract and wire envelope both sides speak, and the helpers that read a contract type.
export type {
    LambderApiContractShape,
    LambderApiMode,
    LambderApiEnvelopeBody,
    LambderApiResponseConfig,
    LambderGuardNamesIn,
    LambderContractMode,
    LambderContractKeysWithMode,
    LambderContractGuardsOf,
    LambderContractGuardNames,
    LambderContractGuardInputsOf,
    LambderContractGuardInput,
    LambderContractGuardInputNames,
    LambderContractRateLimitOf,
    LambderContractIdempotencyOf,
} from "./shared/wire/LambderApiContract.js";

// A crash described for a caller allowed to see it (the envelope's `crash` field; pure, no Node built-ins).
export { describeCrash, errorFromCrashDetail } from "./shared/wire/LambderCrashDetail.js";
export type { LambderCrashDetail, LambderCrashCause } from "./shared/wire/LambderCrashDetail.js";

// Request payload compression (browser-safe: gzip via CompressionStream, no Node built-ins).
export {
    compressPayloadGzip,
    isRequestCompressionAvailable,
    COMPRESSED_PAYLOAD_GZ_FIELD,
    COMPRESSED_PAYLOAD_BR_FIELD,
    COMPRESSED_PAYLOAD_BYTES_FIELD,
    DEFAULT_REQUEST_COMPRESSION_SETTINGS,
} from "./shared/wire/LambderRequestPayload.js";
export type {
    LambderCompressedGzipPayload,
    LambderCompressedBrotliPayload,
    LambderRequestCompressionOption,
    LambderRequestCompressionSettings,
} from "./shared/wire/LambderRequestPayload.js";

// The compression option vocabulary every Lambder surface shares (pure: no zlib).
export { resolveCompressionOption } from "./shared/wire/LambderCompressionOption.js";
export type { LambderCompressionOption, LambderCompressionSettingsBase } from "./shared/wire/LambderCompressionOption.js";

// Type-safe templating (tagged templates with auto-escaping)
export { html, xml, raw, jsonScript, escapeHtml, renderHtmlValue, LambderSafeHtml, type LambderHtmlValue } from "./shared/LambderHtml.js";

// Typed translations (standalone, isomorphic)
export { createLambderI18n } from "./shared/LambderI18n.js";
export type {
    LambderLanguageMeta,
    LambderI18nConfig,
    LambderI18nInstance,
    LambderI18nTranslator,
    LambderI18nExtractParams,
    LambderI18nCodes,
    LambderI18nKeys,
    LambderI18nTranslatorFor,
} from "./shared/LambderI18n.js";
// The status union every refusal option names; browser and mock code declares statuses too.
export type { LambderHttpStatusCode } from "./shared/wire/LambderHttpStatus.js";
