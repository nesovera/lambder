/**
 * Browser entry point (`import ... from "lambder/client"`).
 *
 * Everything reachable from here is browser-safe: no AWS SDK, no Node
 * built-ins, no server pipeline. Frontends and isomorphic shared packages
 * import from this entry so their bundles can never pick up server code;
 * the root entry (`"lambder"`) is the server surface.
 */

// The typed API caller.
export { default as LambderCaller } from "./client/LambderCaller.js";
export type {
    LambderApiOutcome,
    LambderApiFailureReason,
    LambderCallOptions,
    LambderCallerOptions,
    LambderGuardInputsProvider,
    LambderProvidedGuardInputs,
    LambderIdempotencyKeyScope,
} from "./client/LambderCaller.js";

// Typed API refusals (isomorphic: shared code may throw them from anywhere;
// in the browser they are plain Errors).
export { LambderApiError, isLambderApiError, refuse, LAMBDER_REFUSAL_CODES } from "./shared/LambderApiError.js";
export type { LambderApiErrorOptions, LambderRefusalMessage, LambderRefusalCode, LambderRefuseOptions } from "./shared/LambderApiError.js";

// The API contract and wire envelope both sides speak.
export type { ApiContractShape, LambderApiResponse, LambderApiResponseConfig } from "./shared/LambderApiContract.js";

// Request payload compression (browser-safe: gzip via CompressionStream, no Node built-ins).
export {
    compressPayloadJson,
    decompressPayloadJson,
    isRequestCompressionAvailable,
    COMPRESSED_PAYLOAD_FIELD,
    COMPRESSED_PAYLOAD_BYTES_FIELD,
    DEFAULT_REQUEST_COMPRESSION_SETTINGS,
} from "./shared/LambderRequestPayload.js";
export type {
    LambderCompressedPayload,
    LambderRequestCompressionOption,
    LambderRequestCompressionSettings,
} from "./shared/LambderRequestPayload.js";

// The compression option vocabulary every Lambder surface shares (pure: no zlib).
export { resolveCompressionOption } from "./shared/LambderCompressionOption.js";
export type { LambderCompressionOption, LambderCompressionSettingsBase } from "./shared/LambderCompressionOption.js";

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
