/**
 * Browser entry point (`import ... from "lambder/client"`).
 *
 * Everything reachable from here is browser-safe: no AWS SDK, no Node
 * built-ins, no server pipeline. Frontends and isomorphic shared packages
 * import from this entry so their bundles can never pick up server code;
 * the root entry (`"lambder"`) is the server surface.
 */
export { default as LambderCaller } from "./client/LambderCaller.js";
export { DEFAULT_SESSION_TOKEN_COOKIE_KEY, DEFAULT_SESSION_CSRF_COOKIE_KEY } from "./shared/wire/LambderSessionCookieNames.js";
export { lambderFetchTransport } from "./client/lambderFetchTransport.js";
export { buildTransportEnvelope, LambderTransportFailure, isLambderTransportFailure } from "./shared/transport/LambderApiTransport.js";
export { lambderCookieJarTransport } from "./shared/transport/lambderCookieJarTransport.js";
export type { LambderApiTransport, LambderApiTransportRequest, LambderTransportFailureReason } from "./shared/transport/LambderApiTransport.js";
export { LambderCookieJar, parseSetCookie } from "./shared/transport/LambderCookieJar.js";
export type { LambderStoredCookie } from "./shared/transport/LambderCookieJar.js";
export { resolveApiOutcome } from "./shared/wire/LambderApiOutcome.js";
export { apiNameKeyOf, lookupApiSignature, readApiSignature, API_SIGNATURE_HEX_LENGTH, extensibleEnum } from "./shared/wire/LambderApiSignature.js";
export type { LambderApiSignatureMap } from "./shared/wire/LambderApiSignature.js";
export { RELOAD_LOOP_WINDOW_MS } from "./client/LambderReloadLoopBreaker.js";
export { compareDottedVersions, isDottedVersion } from "./shared/wire/LambderVersionOrder.js";
export type { LambderApiAnswerOutcome, LambderApiSuccessOutcome, LambderApiCallFailure, LambderApiValidationFailure, LambderApiEnvelopeFailure, LambderApiHttpAnswer, } from "./shared/wire/LambderApiOutcome.js";
export type { LambderApiOutcome, LambderApiFailureReason, LambderValidationError, LambderCallOptions, LambderCallerOptions, LambderGuardInputsProvider, LambderProvidedGuardInputs, LambderIdempotencyKeyScope, LambderLogListHandler, } from "./client/LambderCaller.js";
export { LambderApiRefusal, isLambderApiRefusal, refuse, LAMBDER_REFUSAL_CODES } from "./shared/wire/LambderApiRefusal.js";
export type { LambderApiRefusalOptions, LambderRefusalMessage, LambderAppRefusalMessage, LambderRefusalCode, LambderRefuseOptions } from "./shared/wire/LambderApiRefusal.js";
export type { LambderApiContractShape, LambderApiMode, LambderApiEnvelopeBody, LambderApiResponseConfig, LambderGuardNamesIn, LambderContractMode, LambderContractKeysWithMode, LambderContractGuardsOf, LambderContractGuardNames, LambderContractGuardInputsOf, LambderContractGuardInput, LambderContractGuardInputNames, LambderContractRateLimitOf, LambderContractIdempotencyOf, } from "./shared/wire/LambderApiContract.js";
export { describeCrash, errorFromCrashDetail } from "./shared/wire/LambderCrashDetail.js";
export type { LambderCrashDetail, LambderCrashCause } from "./shared/wire/LambderCrashDetail.js";
export { compressPayloadGzip, isRequestCompressionAvailable, COMPRESSED_PAYLOAD_GZ_FIELD, COMPRESSED_PAYLOAD_BR_FIELD, COMPRESSED_PAYLOAD_BYTES_FIELD, DEFAULT_REQUEST_COMPRESSION_SETTINGS, } from "./shared/wire/LambderRequestPayload.js";
export type { LambderCompressedGzipPayload, LambderCompressedBrotliPayload, LambderRequestCompressionOption, LambderRequestCompressionSettings, } from "./shared/wire/LambderRequestPayload.js";
export { resolveCompressionOption } from "./shared/wire/LambderCompressionOption.js";
export type { LambderCompressionOption, LambderCompressionSettingsBase } from "./shared/wire/LambderCompressionOption.js";
export { html, xml, raw, jsonScript, escapeHtml, renderHtmlValue, LambderSafeHtml, type LambderHtmlValue } from "./shared/LambderHtml.js";
export { createLambderI18n } from "./shared/LambderI18n.js";
export type { LambderLanguageMeta, LambderI18nConfig, LambderI18nInstance, LambderI18nTranslator, LambderI18nExtractParams, LambderI18nDictionaryLoader, LambderI18nCodes, LambderI18nKeys, LambderI18nTranslatorFor, } from "./shared/LambderI18n.js";
export type { LambderHttpStatusCode } from "./shared/wire/LambderHttpStatus.js";
