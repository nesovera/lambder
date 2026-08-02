import type { LambderRenderContext } from "./LambderContext.js";
export type HttpStatusCode = 100 | 101 | 200 | 201 | 202 | 203 | 204 | 206 | 300 | 301 | 302 | 303 | 304 | 307 | 308 | 400 | 401 | 402 | 403 | 404 | 405 | 406 | 408 | 409 | 410 | 412 | 413 | 415 | 416 | 418 | 422 | 428 | 429 | 431 | 451 | 500 | 501 | 502 | 503 | 504;
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
export type LambderHttpEventFormat = "v1" | "v2";
export declare const normalizeHeaders: (headers?: LambderHeadersInput) => Record<string, string[]>;
export type LambderResponseInit = {
    statusCode: HttpStatusCode;
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
    statusCode: HttpStatusCode;
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
export declare const isCompressibleContentType: (contentType: string | undefined) => boolean;
export declare const acceptsEncoding: (acceptEncoding: string | undefined | null, encoding: string) => boolean;
export type LambderFinalizeOptions = {
    compression: false | {
        minBytes: number;
    };
    etag: boolean;
    /** Guard against Lambda's ~6MB response cap with a clear error. */
    maxResponseBytes: number;
};
export declare const DEFAULT_FINALIZE_OPTIONS: LambderFinalizeOptions;
/**
 * Convert an intermediate LambderResponse into the final Lambda response:
 * gzip negotiation (Accept-Encoding), ETag + If-None-Match 304, base64
 * encoding, HEAD body stripping, and Lambda payload size guard. Emits the v1
 * (REST API) or v2 (HTTP API / Function URL) response shape.
 */
export declare const finalizeResponse: (ctx: Pick<LambderRenderContext, "method" | "headers"> | null, response: LambderResponse, options: LambderFinalizeOptions, format?: LambderHttpEventFormat) => Promise<LambderHttpResponse>;
