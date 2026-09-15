import { LAMBDER_RESPONSE_BRAND } from "../shared/util/LambderResponseBrand.js";
import type { LambderCompressionOption, LambderCompressionSettingsBase, LambderEncoding } from "../shared/wire/LambderCompressionOption.js";
import type { LambderRenderContext, LambderHttpEventFormat } from "./LambderContext.js";
import type { LambderApiAnswer } from "../api/LambderApiAnswer.js";
import type { LambderHttpStatusCode } from "../shared/wire/LambderHttpStatus.js";
export type LambderHeadersInput = Record<string, string | string[]>;
/**
 * Final Lambda response: v1 (REST API) uses multiValueHeaders, v2 (HTTP API /
 * Function URLs) uses headers + cookies. Assignable to both official aws-lambda
 * result types (compile-time asserted below), so exporting getHandler() as an
 * APIGatewayProxyHandler / APIGatewayProxyHandlerV2 is type-safe.
 */
export type LambderHttpResponse = {
    statusCode: number;
    body: string;
    isBase64Encoded: boolean;
    /** API Gateway REST API (payload v1). */
    multiValueHeaders?: Record<string, string[]>;
    /** API Gateway HTTP API / Lambda Function URLs (payload v2). */
    headers?: Record<string, string>;
    cookies?: string[];
};
/** The constructor argument of LambderResponse; built through the resolver rather than by hand, so it is internal to this module. */
type LambderResponseInit = {
    statusCode: LambderHttpStatusCode;
    headers?: LambderHeadersInput;
    body?: string | Buffer | null;
    /** True when body is already a base64-encoded string (pre-encoded binary content). */
    isBodyBase64?: boolean;
    /** "auto": gzip when enabled + compressible + large enough. true: force (if client accepts). false: never. */
    compress?: boolean | "auto";
    /** "auto": ETag on GET/HEAD 200 when globally enabled. true: force. false: never. */
    etag?: boolean | "auto";
};
/**
 * Intermediate response object returned by all response builder methods and by
 * route/api handlers. Bodies stay uncompressed and un-encoded so hooks can
 * still transform them; a single finalize step at the end of render() applies
 * compression, ETag/304 handling and base64 encoding.
 *
 * Throwing a LambderResponse anywhere inside a handler or hook short-circuits
 * the request: the thrown response becomes the response.
 */
export declare class LambderResponse {
    readonly [LAMBDER_RESPONSE_BRAND]: true;
    statusCode: LambderHttpStatusCode;
    headers: Record<string, string[]>;
    body: string | Buffer | null;
    isBodyBase64: boolean;
    compress: boolean | "auto";
    etag: boolean | "auto";
    constructor(init: LambderResponseInit);
    getHeader(key: string): string[] | undefined;
    setHeader(key: string, value: string | string[]): this;
    addHeader(key: string, value: string): this;
}
/**
 * A handler's response as a core answer: what the API pipeline stores,
 * replays and hands back. A Buffer body travels base64-encoded and marked
 * as such, so the idempotency engine never caches it and finalization
 * passes it through untouched; the compress and etag flags ride along so
 * nothing a handler asked for is lost on the way through the core.
 */
export declare const answerFromResponse: (response: LambderResponse) => LambderApiAnswer;
/** A core answer as the response hooks, CORS and finalization work on. */
export declare const responseFromAnswer: (answer: LambderApiAnswer) => LambderResponse;
/** Response-side settings: the threshold plus what the wire can negotiate. */
export type LambderResponseCompressionSettings = LambderCompressionSettingsBase & {
    /** Preference order; the first the client accepts wins. */
    encodings: LambderEncoding[];
    /** Brotli quality 0-11, the same field the at-rest stores take. Kept low: this runs per request, and 11 is orders of magnitude slower. */
    quality: number;
};
/** The `compression` option at creation: `true` for the defaults, `false` for off, or overrides. */
export type LambderResponseCompressionOption = LambderCompressionOption<LambderResponseCompressionSettings>;
export type LambderFinalizeOptions = {
    /** Resolved settings, or null when compression is off: the same `Settings | null` contract the stores hold. */
    compression: LambderResponseCompressionSettings | null;
    etag: boolean;
    /** Guard against Lambda's ~6MB response cap with a clear error. */
    maxResponseBytes: number;
};
/**
 * Brotli first: every browser that accepts it produces smaller bodies than
 * gzip at comparable speed on quality 5, typically 15-25% on markup and
 * prose and substantially more on the repetitive record lists API responses
 * tend to be. That is bandwidth saved and, because the ~6MB cap applies to
 * the encoded bytes, headroom gained. Clients that do not offer `br` fall
 * through to gzip.
 */
export declare const DEFAULT_RESPONSE_COMPRESSION_SETTINGS: LambderResponseCompressionSettings;
export declare const DEFAULT_FINALIZE_OPTIONS: LambderFinalizeOptions;
/**
 * Emit the format-specific Lambda response shape. Exported because the
 * last-resort crash path has to emit without finalizing (finalization may be
 * what failed) and must still get the shape right; hand-writing it there left
 * the v1/v2 split in four places.
 */
export declare const emitResponse: (format: LambderHttpEventFormat, statusCode: number, headers: Record<string, string[]>, body: string, isBase64Encoded: boolean) => LambderHttpResponse;
/**
 * Convert an intermediate LambderResponse into the final Lambda response:
 * gzip negotiation (Accept-Encoding), ETag + If-None-Match 304, base64
 * encoding, HEAD body stripping, and Lambda payload size guard. Emits the v1
 * (REST API) or v2 (HTTP API / Function URL) response shape.
 */
export declare const finalizeResponse: (ctx: Pick<LambderRenderContext, "method" | "header"> | null, response: LambderResponse, options: LambderFinalizeOptions, format?: LambderHttpEventFormat) => Promise<LambderHttpResponse>;
export {};
