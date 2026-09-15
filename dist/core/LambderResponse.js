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
    // The three header methods are the core's own header helpers over this
    // response's map: the case-insensitive lookup, the replace-under-any-casing
    // and the append-under-the-existing-casing rules are one implementation,
    // not a copy per class, so an answer and a response can never disagree
    // about what setting a header means.
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
 * LambderHttpStatusCode is an authoring surface: it exists so `res.status(...)`
 * offers the codes an app writes and catches the typo'd one. An answer is
 * plain data that already left that surface (a replay the idempotency store
 * persisted, a mock's answer, a third adapter's), so its status is a number
 * and a code outside the union is not a reason to refuse a request the app
 * has already answered. Stated once here rather than as a bare cast at the
 * call site, so the widening is a decision a reader can see.
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
const isCompressibleContentType = (contentType) => {
    if (!contentType)
        return false;
    const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
    if (mime.startsWith("text/"))
        return true;
    if (mime.endsWith("+json") || mime.endsWith("+xml"))
        return true;
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
    compression: DEFAULT_RESPONSE_COMPRESSION_SETTINGS,
    etag: true,
    maxResponseBytes: 5_500_000,
};
/**
 * The headers a 304 leaves behind: they describe a body, and a 304 carries
 * none. Everything else goes with it.
 *
 * A keep-list of cache headers instead of this drop-list would quietly make a
 * revalidation the one exit of the request where the call's headers do not
 * belong to the call: a cacheable GET that also slides a session cookie would
 * stop refreshing it the moment the browser held the ETag, and a cross-origin
 * revalidation would lose Access-Control-Allow-Origin, so the browser would
 * refuse the 304 it had asked for.
 */
const HEADERS_DROPPED_ON_NOT_MODIFIED = ["content-type", "content-length", "content-encoding"];
/**
 * Emit the format-specific Lambda response shape. Exported because the
 * last-resort crash path has to emit without finalizing (finalization may be
 * what failed) and must still get the shape right; hand-writing it there left
 * the v1/v2 split in four places.
 */
export const emitResponse = (format, statusCode, headers, body, isBase64Encoded) => {
    if (format === "v2") {
        // Payload v2 has no multiValueHeaders: multi-values are comma-joined,
        // except Set-Cookie which uses the dedicated cookies array.
        const singleHeaders = {};
        const cookies = [];
        for (const [key, values] of Object.entries(headers)) {
            if (key.toLowerCase() === "set-cookie")
                cookies.push(...values);
            else
                singleHeaders[key] = values.join(", ");
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
// ctx.header rather than ctx.headers: the context already carries the
// case-insensitive lookup, and taking the raw map meant a second
// implementation of it lived here for the two headers this reads.
ctx, response, options, format = "v1") => {
    const method = (ctx?.method ?? "GET").toUpperCase();
    if (response.body === null) {
        return emitResponse(format, response.statusCode, response.headers, "", false);
    }
    let outBody;
    let isBase64 = false;
    if (response.isBodyBase64) {
        // Pre-encoded binary content: passes through untouched (no compression).
        outBody = String(response.body);
        isBase64 = true;
    }
    else {
        let bodyBuffer = Buffer.isBuffer(response.body)
            ? response.body
            : Buffer.from(String(response.body), "utf8");
        const contentType = response.getHeader("Content-Type")?.[0];
        const alreadyEncoded = !!response.getHeader("Content-Encoding");
        const eligibleForCompression = !alreadyEncoded && (response.compress === true ||
            (response.compress === "auto" &&
                options.compression !== null &&
                bodyBuffer.length >= options.compression.minBytes &&
                isCompressibleContentType(contentType)));
        if (eligibleForCompression) {
            // Vary even when this client didn't accept an encoding, to keep caches correct.
            response.addHeader("Vary", "Accept-Encoding");
            // compress: true forces compression even with it globally off, so
            // the settings fall back to the defaults rather than being absent.
            const settings = options.compression ?? DEFAULT_RESPONSE_COMPRESSION_SETTINGS;
            const acceptEncoding = ctx?.header("accept-encoding");
            const encoding = settings.encodings.find((candidate) => acceptsEncoding(acceptEncoding, candidate));
            if (encoding) {
                // The same codec, quality and TEXT mode a stored record gets.
                bodyBuffer = await compressText(bodyBuffer, encoding, settings.quality);
                response.setHeader("Content-Encoding", encoding);
            }
        }
        if (Buffer.isBuffer(response.body) || response.getHeader("Content-Encoding")) {
            outBody = bytesToBase64(bodyBuffer);
            isBase64 = true;
        }
        else {
            outBody = bodyBuffer.toString("utf8");
        }
    }
    const etagEnabled = response.etag === true || (response.etag === "auto" &&
        options.etag &&
        response.statusCode === 200 &&
        (method === "GET" || method === "HEAD"));
    if (etagEnabled) {
        const crypto = await getCrypto();
        if (crypto) {
            const etagValue = `"${crypto.createHash("sha256").update(outBody).digest("hex").slice(0, 32)}"`;
            response.setHeader("ETag", etagValue);
            const ifNoneMatch = ctx?.header("if-none-match");
            if (ifNoneMatch && ifNoneMatch.split(",").map((s) => s.trim()).includes(etagValue)) {
                const notModifiedHeaders = {};
                for (const [key, values] of Object.entries(response.headers)) {
                    if (!HEADERS_DROPPED_ON_NOT_MODIFIED.includes(key.toLowerCase()))
                        notModifiedHeaders[key] = values;
                }
                return emitResponse(format, 304, notModifiedHeaders, "", false);
            }
        }
    }
    if (method === "HEAD") {
        return emitResponse(format, response.statusCode, response.headers, "", false);
    }
    // What Lambda weighs is bytes. A base64 body is ASCII, so its length is
    // its byte count; a plain UTF-8 one is not, and counting its UTF-16 code
    // units under-reported a non-ASCII response by up to 3x, which is the one
    // way this guard could pass a body Lambda then refuses with an opaque
    // payload-size error and no envelope.
    const outBytes = isBase64 ? outBody.length : Buffer.byteLength(outBody, "utf8");
    if (outBytes > options.maxResponseBytes) {
        throw new Error(`Lambder: final response body is ${outBytes} bytes which exceeds the configured ` +
            `maxResponseBytes (${options.maxResponseBytes}). Lambda caps proxy responses at ~6MB. ` +
            `Consider pagination or enabling compression.`);
    }
    return emitResponse(format, response.statusCode, response.headers, outBody, isBase64);
};
