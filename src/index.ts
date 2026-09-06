import Lambder from './Lambder.js';

export default Lambder;
export { default as LambderCaller } from "./LambderCaller.js";
export type { LambderApiOutcome, LambderApiFailureReason, LambderCallOptions } from "./LambderCaller.js";

// Typed API refusals (isomorphic: shared code may throw them from anywhere)
export { LambderApiError, isLambderApiError } from "./LambderApiError.js";
export type { LambderApiErrorOptions } from "./LambderApiError.js";
export { default as LambderResponseBuilder } from "./LambderResponseBuilder.js";
export { default as LambderResolver } from "./LambderResolver.js";
export { default as LambderSessionManager } from "./LambderSessionManager.js";
export { default as LambderSessionController } from "./LambderSessionController.js";
export { default as LambderMSW } from "./LambderMSW.js";
export type { LambderMswModule } from "./LambderMSW.js";

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
} from "./LambderResponse.js";

// Type-safe templating (tagged templates with auto-escaping)
export { html, xml, raw, jsonScript, escapeHtml, renderHtmlValue, LambderSafeHtml, type LambderHtmlValue } from "./LambderHtml.js";

// Comment-based HTML templating engine (build-pipeline-safe slots and conditionals, standalone)
export { LambderTemplatingEngine } from "./LambderTemplatingEngine.js";
export type { LambderTemplateData, LambderTemplatingEngineOptions } from "./LambderTemplatingEngine.js";
export type {
    LambderResponseOptions,
    LambderApiResponse,
    LambderApiResponseConfig,
    LambderRawResponseInit,
} from "./LambderResponseBuilder.js";

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
} from "./Lambder.js";

// Public file serving
export { LambderPublicFilesHandler } from "./LambderPublicFiles.js";
export type { LambderPublicFilesOptions } from "./LambderPublicFiles.js";

// Session types
export type { LambderSessionCookieOptions } from "./LambderSessionController.js";
export type { LambderSessionContext, LambderSessionDataRefreshConfig } from "./LambderSessionManager.js";
export { LambderSessionDataRefreshError } from "./LambderSessionManager.js";

// DynamoDB-backed compressed cache (standalone, server-only)
export { LambderDdbCache } from "./LambderDdbCache.js";
export type {
    LambderDdbCacheOptions,
    LambderDdbCacheSetOptions,
    LambderDdbCacheGetOrSetOptions,
} from "./LambderDdbCache.js";

// DynamoDB-backed fixed-window rate limiter (standalone, server-only)
export { LambderDdbRateLimiter } from "./LambderDdbRateLimiter.js";
export type {
    LambderDdbRateLimiterOptions,
    LambderRateLimitPolicy,
    LambderRateLimitExceededMap,
    LambderRateLimitResult,
} from "./LambderDdbRateLimiter.js";

// DynamoDB-backed idempotency records (standalone, server-only)
export { LambderDdbIdempotency } from "./LambderDdbIdempotency.js";
export type {
    LambderDdbIdempotencyOptions,
    LambderIdempotencyBeginResult,
} from "./LambderDdbIdempotency.js";

// Declarative per-API policies (rate limits, guards, idempotency)
export type {
    LambderApiGuardFunction,
    LambderRateLimitPer,
    LambderApiRateLimitPolicyConfig,
    LambderApiRateLimitsConfig,
    LambderApiIdempotencyConfig,
    LambderApiRegistrationOptions,
    LambderPublicRateLimitNames,
} from "./LambderApiPolicies.js";

// Typed translations (standalone, isomorphic)
export { createLambderI18n } from "./LambderI18n.js";
export type {
    LambderLanguageMeta,
    LambderI18nConfig,
    LambderI18nInstance,
    LambderI18nTranslator,
    LambderI18nExtractParams,
    LambderI18nCodes,
    LambderI18nKeys,
    LambderI18nTranslatorFor,
} from "./LambderI18n.js";

// Type-safe API contract utilities
export {
    type ApiContractShape,
} from "./LambderApiContract.js";

// Context types and utilities
export type { LambderRenderContext, LambderSessionRenderContext, LambderHttpEvent } from "./LambderContext.js";
export { createContext, isV2HttpEvent } from "./LambderContext.js";
