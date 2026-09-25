import { LAMBDER_RESPONSE_BRAND } from "../shared/util/LambderResponseBrand.js";
import { bytesToBase64 } from "../shared/util/LambderBase64.js";
import { getCrypto } from "../shared/util/LambderNodeModules.js";
import { compressText } from "../shared/wire/LambderCompressionCodec.js";
import { getAnswerHeader, setAnswerHeader, addAnswerHeader } from "../shared/wire/LambderAnswerHeaders.js";
const normalizeHeaders = (headers) => Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
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
    [LAMBDER_RESPONSE_BRAND] = true;
    statusCode;
    headers;
    body;
    isBodyBase64;
    compress;
    etag;
    constructor(init) {
        this.statusCode = init.statusCode;
        this.headers = normalizeHeaders(init.headers);
        this.body = init.body ?? null;
        this.isBodyBase64 = init.isBodyBase64 ?? false;
        this.compress = init.compress ?? "auto";
        this.etag = init.etag ?? "auto";
    }
    /**
     * A copy with its own header lists, for a request to write into. A
     * handler may answer with an object it keeps between requests (a
     * module-level 404), and everything downstream adds headers (cookies,
     * CORS, Vary, Content-Encoding, ETag), which would carry one caller's
     * Set-Cookie to the next. The body is shared: nothing writes into it.
     */
    copy() {
        return new LambderResponse({
            statusCode: this.statusCode,
            headers: this.headers,
            body: this.body,
            isBodyBase64: this.isBodyBase64,
            compress: this.compress,
            etag: this.etag,
        });
    }
    // The header methods delegate to the core's header helpers, so an answer
    // and a response share one implementation of the case-insensitive lookup,
    // replace and append rules and can never disagree about what they mean.
    getHeader(key) {
        return getAnswerHeader(this.headers, key);
    }
    setHeader(key, value) {
        setAnswerHeader(this.headers, key, value);
        return this;
    }
    addHeader(key, value) {
        addAnswerHeader(this.headers, key, value);
        return this;
    }
}
/**
 * A handler's response as a core answer: what the API pipeline stores,
 * replays and hands back. A Buffer body travels base64-encoded and marked
 * as such, so the idempotency engine never caches it and finalization
 * passes it through untouched; the compress and etag flags ride along so
 * nothing a handler asked for is lost on the way through the core.
 */
export const answerFromResponse = (response) => {
    const binary = Buffer.isBuffer(response.body);
    return {
        statusCode: response.statusCode,
        headers: normalizeHeaders(response.headers),
        body: response.body === null ? "" : binary ? bytesToBase64(response.body) : String(response.body),
        isBodyBase64: response.isBodyBase64 || binary,
        compress: response.compress,
        etag: response.etag,
    };
};
/**
 * An answer's status as the response model spells statuses.
 *
 * LambderHttpStatusCode is an authoring surface: it lets `res.status(...)`
 * offer the codes an app writes and catch a typo. An answer is plain data
 * that has already left that surface (a persisted replay, a mock's answer),
 * so a code outside the union is no reason to refuse a request the app has
 * already answered. A named function rather than a bare cast at the call
 * site, so the widening is visible to a reader.
 */
const httpStatusOfAnswer = (statusCode) => statusCode;
/** A core answer as the response hooks, CORS and finalization work on. */
export const responseFromAnswer = (answer) => new LambderResponse({
    statusCode: httpStatusOfAnswer(answer.statusCode),
    headers: answer.headers,
    body: answer.body,
    isBodyBase64: answer.isBodyBase64 ?? false,
    compress: answer.compress ?? "auto",
    etag: answer.etag ?? "auto",
});
const mimeOf = (contentType) => (contentType?.split(";")[0] ?? "").trim().toLowerCase();
/** A content type whose body is text: sent as text when it is valid UTF-8 and not compressed. */
const isTextContentType = (contentType) => {
    const mime = mimeOf(contentType);
    if (mime.startsWith("text/"))
        return true;
    if (mime.endsWith("+json") || mime.endsWith("+xml"))
        return true;
    return [
        "application/json",
        "application/javascript",
        "application/x-javascript",
        "application/xml",
        "application/lambder-json-stream",
    ].includes(mime);
};
const isCompressibleContentType = (contentType) => isTextContentType(contentType) || mimeOf(contentType) === "application/wasm";
/** Strict, and keeping a byte-order mark, so a body that decodes is exactly its bytes as text. */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** The bytes as text when they are valid UTF-8, or null. */
const utf8TextOf = (bytes) => {
    try {
        return strictUtf8.decode(bytes);
    }
    catch {
        return null;
    }
};
const acceptsEncoding = (acceptEncoding, encoding) => {
    if (!acceptEncoding)
        return false;
    return acceptEncoding.split(",").some((part) => {
        const [token, ...params] = part.trim().split(";");
        const name = (token ?? "").trim().toLowerCase();
        if (name !== encoding && name !== "*")
            return false;
        const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
        return !q || Number(q.slice(2)) > 0;
    });
};
/**
 * Brotli first: every browser that accepts it produces smaller bodies than
 * gzip at comparable speed on quality 5, typically 15-25% on markup and
 * prose and substantially more on the repetitive record lists API responses
 * tend to be. That is bandwidth saved and, because the ~6MB cap applies to
 * the encoded bytes, headroom gained. Clients that do not offer `br` fall
 * through to gzip.
 */
export const DEFAULT_RESPONSE_COMPRESSION_SETTINGS = {
    minBytes: 860,
    encodings: ["br", "gzip"],
    quality: 5,
};
export const DEFAULT_FINALIZE_OPTIONS = {
    compression: { v1: null, v2: DEFAULT_RESPONSE_COMPRESSION_SETTINGS },
    etag: true,
    maxResponseBytes: 5_500_000,
};
/**
 * The headers a 304 leaves behind: they describe a body, and a 304 carries
 * none. Everything else goes with it.
 *
 * A keep-list of cache headers would make revalidation the one exit where the
 * call's headers do not reach the client: a cacheable GET that slides a
 * session cookie would stop refreshing it once the browser held the ETag, and
 * a cross-origin revalidation would lose Access-Control-Allow-Origin, so the
 * browser would refuse the 304 it asked for.
 */
const HEADERS_DROPPED_ON_NOT_MODIFIED = ["content-type", "content-length", "content-encoding"];
/** The hash an ETag is made from, or null where Node's crypto is not available. */
const bodyHashOf = async (body) => {
    const crypto = await getCrypto();
    if (!crypto)
        return null;
    return crypto.createHash("sha256").update(body).digest("hex").slice(0, 32);
};
/** Cache-Control directives that offer a copy to shared caches, or describe that shared copy. */
const SHARED_CACHE_DIRECTIVES = ["public", "s-maxage", "immutable"];
/** Cache-Control directives that already keep a whole answer out of shared caches. */
const PRIVATE_CACHE_DIRECTIVES = ["private", "no-store"];
/**
 * The headers with their Cache-Control made `private` when the answer sets a
 * cookie. A cookie is one visitor's, and a shared cache (a CDN, a proxy)
 * that stores an answer with its Set-Cookie hands that cookie to everyone it
 * serves the copy to: a hook that issues a guest session, or a session read
 * that slides the cookies, would otherwise send a visitor's session out on a
 * content-hashed asset marked `public, max-age=31536000, immutable`. So
 * `public` gives way to `private`, and `s-maxage` and `immutable` go with
 * it: the first speaks only to shared caches, and the second promises a
 * representation every visitor shares, which an answer carrying one
 * visitor's cookie is not. The visitor's own cache keeps max-age. An answer
 * that already says `private` or `no-store`, or says nothing about caching,
 * is left as it is. Never mutates what it was given.
 */
const privateWhenSettingCookies = (headers) => {
    const cacheControl = getAnswerHeader(headers, "cache-control");
    if (!cacheControl?.length || !getAnswerHeader(headers, "set-cookie")?.length)
        return headers;
    const directives = cacheControl.flatMap((value) => value.split(",")).map((directive) => directive.trim()).filter(Boolean);
    const nameOf = (directive) => (directive.split("=")[0] ?? "").trim().toLowerCase();
    if (directives.some((directive) => PRIVATE_CACHE_DIRECTIVES.includes(nameOf(directive))))
        return headers;
    const privateHeaders = { ...headers };
    setAnswerHeader(privateHeaders, "Cache-Control", ["private", ...directives.filter((directive) => !SHARED_CACHE_DIRECTIVES.includes(nameOf(directive)))].join(", "));
    return privateHeaders;
};
/**
 * Emit the format-specific Lambda response shape. Exported because the
 * last-resort crash path has to emit without finalizing (finalization may be
 * what failed) and must still get the shape right, so the v1/v2 split lives
 * in this one place. Being the one exit every answer leaves through (each of
 * finalization's, the 304 included, and the crash path's), it is also where
 * an answer that sets a cookie is made private (privateWhenSettingCookies).
 */
export const emitResponse = (format, statusCode, headers, body, isBase64Encoded) => {
    const sentHeaders = privateWhenSettingCookies(headers);
    if (format === "v2") {
        // Payload v2 has no multiValueHeaders: multi-values are comma-joined,
        // except Set-Cookie which uses the dedicated cookies array.
        const singleHeaders = {};
        const cookies = [];
        for (const [key, values] of Object.entries(sentHeaders)) {
            if (key.toLowerCase() === "set-cookie")
                cookies.push(...values);
            else
                singleHeaders[key] = values.join(", ");
        }
        return { statusCode, headers: singleHeaders, cookies, body, isBase64Encoded };
    }
    return { statusCode, multiValueHeaders: sentHeaders, body, isBase64Encoded };
};
/**
 * Convert an intermediate LambderResponse into the final Lambda response:
 * compression negotiation (Accept-Encoding), ETag + If-None-Match 304, base64
 * encoding, HEAD body stripping, and Lambda payload size guard. Emits the v1
 * (REST API) or v2 (HTTP API / Function URL) response shape.
 *
 * Text goes out as text and only bytes as base64: a REST API decodes base64
 * only for its binaryMediaTypes, so a stylesheet sent as base64 would reach
 * the browser as base64. The ETag is settled before anything is compressed, so
 * a revalidation that ends in a 304 compresses nothing.
 */
export const finalizeResponse = async (
// ctx.header rather than ctx.headers: the context already carries the
// case-insensitive lookup, and taking the raw map would need a second
// implementation of it here.
ctx, response, options, format = "v1") => {
    const method = (ctx?.method ?? "GET").toUpperCase();
    if (response.body === null) {
        return emitResponse(format, response.statusCode, response.headers, "", false);
    }
    const etagEnabled = response.etag === true || (response.etag === "auto" &&
        options.etag &&
        response.statusCode === 200 &&
        (method === "GET" || method === "HEAD"));
    /** Tags the response, and answers the 304 when the client already holds this representation. */
    const notModifiedFor = async (hashed, encoding) => {
        if (!etagEnabled)
            return null;
        const hash = await bodyHashOf(hashed);
        if (hash === null)
            return null;
        // One tag per representation: the compressed bytes are not the identity ones.
        const etagValue = encoding ? `"${hash}-${encoding}"` : `"${hash}"`;
        response.setHeader("ETag", etagValue);
        const ifNoneMatch = ctx?.header("if-none-match");
        if (!ifNoneMatch || !ifNoneMatch.split(",").map((s) => s.trim()).includes(etagValue))
            return null;
        const notModifiedHeaders = {};
        for (const [key, values] of Object.entries(response.headers)) {
            if (!HEADERS_DROPPED_ON_NOT_MODIFIED.includes(key.toLowerCase()))
                notModifiedHeaders[key] = values;
        }
        return emitResponse(format, 304, notModifiedHeaders, "", false);
    };
    let outBody;
    let isBase64 = false;
    if (response.isBodyBase64) {
        // Pre-encoded binary content: passes through untouched (no compression).
        outBody = String(response.body);
        isBase64 = true;
        const notModified = await notModifiedFor(outBody, null);
        if (notModified)
            return notModified;
    }
    else {
        const identity = Buffer.isBuffer(response.body)
            ? response.body
            : Buffer.from(String(response.body), "utf8");
        const contentType = response.getHeader("Content-Type")?.[0];
        const alreadyEncoded = !!response.getHeader("Content-Encoding");
        const formatCompression = options.compression[format];
        const eligibleForCompression = !alreadyEncoded && (response.compress === true ||
            (response.compress === "auto" &&
                formatCompression !== null &&
                identity.length >= formatCompression.minBytes &&
                isCompressibleContentType(contentType)));
        // compress: true forces compression even with it off, so the
        // settings fall back to the defaults rather than being absent.
        const settings = formatCompression ?? DEFAULT_RESPONSE_COMPRESSION_SETTINGS;
        let encoding = null;
        if (eligibleForCompression) {
            // Vary even when this client didn't accept an encoding, to keep caches correct.
            response.addHeader("Vary", "Accept-Encoding");
            const acceptEncoding = ctx?.header("accept-encoding");
            encoding = settings.encodings.find((candidate) => acceptsEncoding(acceptEncoding, candidate)) ?? null;
        }
        const notModified = await notModifiedFor(identity, encoding);
        if (notModified)
            return notModified;
        if (encoding) {
            // The same codec, quality and TEXT mode a stored record gets.
            outBody = bytesToBase64(await compressText(identity, encoding, settings.quality));
            isBase64 = true;
            response.setHeader("Content-Encoding", encoding);
        }
        else {
            const text = alreadyEncoded
                ? null
                : Buffer.isBuffer(response.body)
                    ? (isTextContentType(contentType) ? utf8TextOf(identity) : null)
                    : String(response.body);
            if (text !== null) {
                outBody = text;
            }
            else {
                outBody = bytesToBase64(identity);
                isBase64 = true;
            }
        }
    }
    if (method === "HEAD") {
        return emitResponse(format, response.statusCode, response.headers, "", false);
    }
    // What Lambda weighs is bytes. A base64 body is ASCII, so its length is
    // its byte count; a UTF-8 one is not, and counting UTF-16 code units would
    // under-report a non-ASCII body by up to 3x, passing a body Lambda then
    // refuses with an opaque payload-size error and no envelope.
    const outBytes = isBase64 ? outBody.length : Buffer.byteLength(outBody, "utf8");
    if (outBytes > options.maxResponseBytes) {
        throw new Error(`Lambder: final response body is ${outBytes} bytes which exceeds the configured ` +
            `maxResponseBytes (${options.maxResponseBytes}). Lambda caps proxy responses at ~6MB. ` +
            `Consider pagination or enabling compression.`);
    }
    return emitResponse(format, response.statusCode, response.headers, outBody, isBase64);
};
