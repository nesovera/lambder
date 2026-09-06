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
    LambderIdempotencyKeyScope,
} from "./client/LambderCaller.js";

// Typed API refusals (isomorphic: shared code may throw them from anywhere;
// in the browser they are plain Errors).
export { LambderApiError, isLambderApiError, refuse } from "./shared/LambderApiError.js";
export type { LambderApiErrorOptions, LambderRefusalMessage, LambderRefuseOptions } from "./shared/LambderApiError.js";

// The API contract and wire envelope both sides speak.
export type { ApiContractShape, LambderApiResponse, LambderApiResponseConfig } from "./shared/LambderApiContract.js";

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
