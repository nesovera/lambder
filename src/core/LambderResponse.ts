import { getZlib, getCrypto } from "../shared/node-polyfills.js";
import type { APIGatewayProxyResult, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { LambderRenderContext } from "./LambderContext.js";

export type HttpStatusCode =
    | 100 | 101
    | 200 | 201 | 202 | 203 | 204 | 206
    | 300 | 301 | 302 | 303 | 304 | 307 | 308
    | 400 | 401 | 402 | 403 | 404 | 405 | 406 | 408 | 409 | 410 | 412 | 413 | 415 | 416 | 418 | 422 | 428 | 429 | 431 | 451
    | 500 | 501 | 502 | 503 | 504;

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

// Compile-time guarantees against the official aws-lambda types.
type AssertAssignable<T extends true> = T;
type _AssertV1Result = AssertAssignable<LambderHttpResponse extends APIGatewayProxyResult ? true : false>;
type _AssertV2Result = AssertAssignable<LambderHttpResponse extends APIGatewayProxyStructuredResultV2 ? true : false>;

export type LambderHttpEventFormat = "v1" | "v2";

export const normalizeHeaders = (headers?: LambderHeadersInput): Record<string, string[]> =>
    Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));

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
export class LambderResponse {
    public statusCode: HttpStatusCode;
    public headers: Record<string, string[]>;
    public body: string | Buffer | null;
    public isBodyBase64: boolean;
    public compress: boolean | "auto";
    public etag: boolean | "auto";

    constructor(init: LambderResponseInit){
        this.statusCode = init.statusCode;
        this.headers = normalizeHeaders(init.headers);
        this.body = init.body ?? null;
        this.isBodyBase64 = init.isBodyBase64 ?? false;
        this.compress = init.compress ?? "auto";
        this.etag = init.etag ?? "auto";
    }

    getHeader(key: string): string[] | undefined {
        const lower = key.toLowerCase();
        for(const [k, v] of Object.entries(this.headers)){
            if(k.toLowerCase() === lower) return v;
        }
        return undefined;
    }

    setHeader(key: string, value: string | string[]): this {
        const lower = key.toLowerCase();
        for(const k of Object.keys(this.headers)){
            if(k.toLowerCase() === lower) delete this.headers[k];
        }
        this.headers[key] = Array.isArray(value) ? [...value] : [value];
        return this;
    }

    addHeader(key: string, value: string): this {
        const lower = key.toLowerCase();
        const existingKey = Object.keys(this.headers).find((k) => k.toLowerCase() === lower);
        if(existingKey){
            (this.headers[existingKey] as string[]).push(value);
        }else{
            this.headers[key] = [value];
        }
        return this;
    }
}

export const isCompressibleContentType = (contentType: string | undefined): boolean => {
    if(!contentType) return false;
    const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
    if(mime.startsWith("text/")) return true;
    if(mime.endsWith("+json") || mime.endsWith("+xml")) return true;
    return [
        "application/json",
        "application/javascript",
        "application/x-javascript",
        "application/xml",
        "application/wasm",
        "image/svg+xml",
        "application/lambder-json-stream",
    ].includes(mime);
};

export const acceptsEncoding = (acceptEncoding: string | undefined | null, encoding: string): boolean => {
    if(!acceptEncoding) return false;
    return acceptEncoding.split(",").some((part) => {
        const [token, ...params] = part.trim().split(";");
        const name = (token ?? "").trim().toLowerCase();
        if(name !== encoding && name !== "*") return false;
        const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
        return !q || Number(q.slice(2)) > 0;
    });
};

export type LambderFinalizeOptions = {
    compression: false | { minBytes: number };
    etag: boolean;
    /** Guard against Lambda's ~6MB response cap with a clear error. */
    maxResponseBytes: number;
};

export const DEFAULT_FINALIZE_OPTIONS: LambderFinalizeOptions = {
    compression: { minBytes: 860 },
    etag: true,
    maxResponseBytes: 5_500_000,
};

const getRequestHeader = (
    ctx: Pick<LambderRenderContext, "headers"> | null,
    name: string,
): string | undefined => {
    if(!ctx?.headers) return undefined;
    const lower = name.toLowerCase();
    for(const [k, v] of Object.entries(ctx.headers)){
        if(k.toLowerCase() === lower) return v ?? undefined;
    }
    return undefined;
};

/** Emit the format-specific Lambda response shape. */
const emitResponse = (
    format: LambderHttpEventFormat,
    statusCode: number,
    headers: Record<string, string[]>,
    body: string,
    isBase64Encoded: boolean,
): LambderHttpResponse => {
    if(format === "v2"){
        // Payload v2 has no multiValueHeaders: multi-values are comma-joined,
        // except Set-Cookie which uses the dedicated cookies array.
        const singleHeaders: Record<string, string> = {};
        const cookies: string[] = [];
        for(const [key, values] of Object.entries(headers)){
            if(key.toLowerCase() === "set-cookie") cookies.push(...values);
            else singleHeaders[key] = values.join(", ");
        }
        return { statusCode, headers: singleHeaders, cookies, body, isBase64Encoded };
    }
    return { statusCode, multiValueHeaders: headers, body, isBase64Encoded };
};

/**
 * Convert an intermediate LambderResponse into the final Lambda response:
 * gzip negotiation (Accept-Encoding), ETag + If-None-Match 304, base64
 * encoding, HEAD body stripping, and Lambda payload size guard. Emits the v1
 * (REST API) or v2 (HTTP API / Function URL) response shape.
 */
export const finalizeResponse = async (
    ctx: Pick<LambderRenderContext, "method" | "headers"> | null,
    response: LambderResponse,
    options: LambderFinalizeOptions,
    format: LambderHttpEventFormat = "v1",
): Promise<LambderHttpResponse> => {
    const method = (ctx?.method ?? "GET").toUpperCase();

    if(response.body === null){
        return emitResponse(format, response.statusCode, response.headers, "", false);
    }

    let outBody: string;
    let isBase64 = false;

    if(response.isBodyBase64){
        // Pre-encoded binary content: passes through untouched (no compression).
        outBody = String(response.body);
        isBase64 = true;
    }else{
        let bodyBuffer = Buffer.isBuffer(response.body)
            ? response.body
            : Buffer.from(String(response.body), "utf8");

        const contentType = response.getHeader("Content-Type")?.[0];
        const alreadyEncoded = !!response.getHeader("Content-Encoding");
        const eligibleForCompression = !alreadyEncoded && (
            response.compress === true ||
            (
                response.compress === "auto" &&
                options.compression !== false &&
                bodyBuffer.length >= options.compression.minBytes &&
                isCompressibleContentType(contentType)
            )
        );
        if(eligibleForCompression){
            // Vary even when this client didn't accept an encoding, to keep caches correct.
            response.addHeader("Vary", "Accept-Encoding");
            if(acceptsEncoding(getRequestHeader(ctx, "accept-encoding"), "gzip")){
                const zlib = await getZlib();
                if(zlib){
                    bodyBuffer = zlib.gzipSync(bodyBuffer);
                    response.setHeader("Content-Encoding", "gzip");
                }
            }
        }

        if(Buffer.isBuffer(response.body) || response.getHeader("Content-Encoding")){
            outBody = bodyBuffer.toString("base64");
            isBase64 = true;
        }else{
            outBody = bodyBuffer.toString("utf8");
        }
    }

    const etagEnabled = response.etag === true || (
        response.etag === "auto" &&
        options.etag &&
        response.statusCode === 200 &&
        (method === "GET" || method === "HEAD")
    );
    if(etagEnabled){
        const crypto = await getCrypto();
        if(crypto){
            const etagValue = `"${crypto.createHash("sha256").update(outBody).digest("hex").slice(0, 32)}"`;
            response.setHeader("ETag", etagValue);
            const ifNoneMatch = getRequestHeader(ctx, "if-none-match");
            if(ifNoneMatch && ifNoneMatch.split(",").map((s) => s.trim()).includes(etagValue)){
                const preservedHeaders: Record<string, string[]> = {};
                for(const key of ["ETag", "Cache-Control", "Vary", "Expires", "Last-Modified"]){
                    const value = response.getHeader(key);
                    if(value) preservedHeaders[key] = value;
                }
                return emitResponse(format, 304, preservedHeaders, "", false);
            }
        }
    }

    if(method === "HEAD"){
        return emitResponse(format, response.statusCode, response.headers, "", false);
    }

    if(outBody.length > options.maxResponseBytes){
        throw new Error(
            `Lambder: final response body is ${outBody.length} bytes which exceeds the configured ` +
            `maxResponseBytes (${options.maxResponseBytes}). Lambda caps proxy responses at ~6MB. ` +
            `Consider pagination or enabling compression.`,
        );
    }

    return emitResponse(format, response.statusCode, response.headers, outBody, isBase64);
};
