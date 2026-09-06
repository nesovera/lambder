import Lambder from './core/Lambder.js';

export default Lambder;
export { default as LambderCaller } from "./client/LambderCaller.js";
export type { LambderApiOutcome, LambderApiFailureReason, LambderCallOptions, LambderIdempotencyKeyScope } from "./client/LambderCaller.js";

// Typed API refusals (isomorphic: shared code may throw them from anywhere)
export { LambderApiError, isLambderApiError, refuse } from "./shared/LambderApiError.js";
export type { LambderApiErrorOptions, LambderRefusalMessage, LambderRefuseOptions } from "./shared/LambderApiError.js";
export { default as LambderResponseBuilder } from "./core/LambderResponseBuilder.js";
export { default as LambderResolver } from "./core/LambderResolver.js";
export { default as LambderSessionManager } from "./session/LambderSessionManager.js";
export { default as LambderSessionController } from "./session/LambderSessionController.js";

// Response model
export {
    LambderResponse,
    finalizeResponse,
    acceptsEncoding,
    type HttpStatusCode,
    type LambderHttpResponse,
    type LambderHttpEventFormat,
    type LambderHeadersInput,
    type LambderFinalizeOptions,
} from "./core/LambderResponse.js";

// Type-safe templating (tagged templates with auto-escaping)
export { html, xml, raw, jsonScript, escapeHtml, renderHtmlValue, LambderSafeHtml, type LambderHtmlValue } from "./shared/LambderHtml.js";

// Comment-based HTML templating engine (build-pipeline-safe slots and conditionals, standalone)
export { LambderTemplatingEngine } from "./core/LambderTemplatingEngine.js";
export type { LambderTemplateData, LambderTemplatingEngineOptions } from "./core/LambderTemplatingEngine.js";
export type {
    LambderResponseOptions,
    LambderRawResponseInit,
} from "./core/LambderResponseBuilder.js";

// Routing / configuration types
export type {
    LambderRouteMatcher,
    LambderCorsConfig,
    LambderConstructorOptions,
    ConditionFunction,
    RouteCondition,
    PathParamsOf,
    LambderActionTools,
    LambderHandler,
    LambderIndexHtmlOptions,
    LambderApp,
} from "./core/Lambder.js";

// Public file serving
export { LambderPublicFilesHandler } from "./core/LambderPublicFiles.js";
export type { LambderPublicFilesOptions } from "./core/LambderPublicFiles.js";

// Session types
export type { LambderSessionCookieOptions } from "./session/LambderSessionController.js";
export type { LambderSessionContext, LambderCreatedSession, LambderSessionDataRefreshConfig } from "./session/LambderSessionManager.js";
export { LambderSessionDataRefreshError, LambderSessionReadError } from "./session/LambderSessionManager.js";

// DynamoDB-backed compressed cache (standalone, server-only)
export { LambderDdbCache } from "./stores/LambderDdbCache.js";
export type {
    LambderDdbCacheOptions,
    LambderDdbCacheSetOptions,
    LambderDdbCacheGetOrSetOptions,
} from "./stores/LambderDdbCache.js";

// DynamoDB-backed fixed-window rate limiter (standalone, server-only)
export { LambderDdbRateLimiter } from "./stores/LambderDdbRateLimiter.js";
export type {
    LambderDdbRateLimiterOptions,
    LambderRateLimitPolicy,
    LambderRateLimitExceededMap,
    LambderRateLimitResult,
} from "./stores/LambderDdbRateLimiter.js";

// DynamoDB-backed idempotency records (standalone, server-only)
export { LambderDdbIdempotency } from "./stores/LambderDdbIdempotency.js";
export type {
    LambderDdbIdempotencyOptions,
    LambderIdempotencyBeginResult,
    LambderIdempotencyDoneRecord,
} from "./stores/LambderDdbIdempotency.js";

// Declarative per-API policies: guards
export { lambderGuard } from "./policies/LambderApiGuards.js";
export type {
    LambderApiGuard,
    LambderGuardMeta,
    LambderGuardMetaMap,
    LambderAllowedGuardNames,
    LambderParamlessGuardNames,
    LambderGuardsOption,
    LambderGuardsOptionValue,
    LambderGuardDataOf,
    LambderGuardInputsOf,
} from "./policies/LambderApiGuards.js";

// Declarative per-API policies: rate limits
export { lambderRateLimitKey } from "./policies/LambderApiRateLimits.js";
export type {
    LambderRateLimitKeyFn,
    LambderRateLimitPer,
    LambderApiRateLimitPolicyConfig,
    LambderApiRateLimitsConfig,
    LambderAllowedPolicyNames,
} from "./policies/LambderApiRateLimits.js";

// Declarative per-API policies: idempotency
export type { LambderApiIdempotencyConfig } from "./policies/LambderApiIdempotency.js";

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

// Type-safe API contract utilities and the wire envelope
export {
    type ApiContractShape,
    type LambderApiResponse,
    type LambderApiResponseConfig,
} from "./shared/LambderApiContract.js";

// Context types and utilities
export type { LambderRenderContext, LambderSessionRenderContext, LambderHttpEvent } from "./core/LambderContext.js";
export { createContext, isV2HttpEvent } from "./core/LambderContext.js";
