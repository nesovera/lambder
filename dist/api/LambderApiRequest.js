import { COMPRESSED_PAYLOAD_GZ_FIELD, COMPRESSED_PAYLOAD_BR_FIELD, COMPRESSED_PAYLOAD_BYTES_FIELD, } from "../shared/wire/LambderRequestPayload.js";
import { base64ToBytes } from "../shared/util/LambderBase64.js";
import cookieParser from "cookie";
import { restoreText, LambderCompressionError, LAMBDER_RESTORE_FAILURES } from "../shared/wire/LambderCompressionCodec.js";
/**
 * Cookie header pairs (`name=value`) as every value per name, in header
 * order. Parsed pair by pair, because a whole-header parse keeps only the
 * first value of a name the browser holds at two scopes, and the session
 * controller weighs every copy. The map has no prototype: a cookie named
 * `__proto__` or `constructor` must land as its own key rather than resolve
 * to Object.prototype, or one planted cookie would 500 every request. Every
 * adapter builds its request's cookies through this one function.
 */
export const cookieValuesByName = (pairs) => {
    const cookies = Object.create(null);
    for (const pair of pairs) {
        for (const [name, value] of Object.entries(cookieParser.parse(pair))) {
            if (value !== undefined)
                (cookies[name] ??= []).push(value);
        }
    }
    return cookies;
};
/** Request headers under lowercased names, so a lookup never depends on how the gateway spelled them. */
export const lowercaseHeaderNames = (headers) => {
    // Prototype-free like the cookie map: a header named `__proto__` must
    // land as a key rather than reach Object.prototype's setter and vanish.
    const lowered = Object.create(null);
    for (const [key, value] of Object.entries(headers ?? {})) {
        if (value !== undefined)
            lowered[key.toLowerCase()] = value;
    }
    return lowered;
};
/**
 * Whether a POST's Content-Type makes it an API call: application/json,
 * which a browser sends cross-origin only after a CORS preflight. A form
 * (text/plain, urlencoded, multipart) needs none, so any website could post
 * one and, read as an API call, call a public login and plant the
 * attacker's session cookies in a visitor's browser. Every Lambder caller
 * sends application/json; the server and the mock's HTTP-shaped adapters
 * read the same rule here.
 */
export const isApiCallContentType = (lowercasedHeaders) => (lowercasedHeaders["content-type"] ?? "").split(";")[0].trim().toLowerCase() === "application/json";
/**
 * Reads the posted envelope into a request. Null when the body carries no
 * apiName, which is how the server tells an API call from a route with a
 * JSON body. Everything is taken as posted: a malformed idempotencyKey or
 * guardInputs value is the engines' to refuse, with the client-facing
 * message they already give.
 */
export const readApiEnvelope = (post, info) => {
    if (!post || typeof post.apiName !== "string" || !post.apiName)
        return null;
    const hasGzip = post[COMPRESSED_PAYLOAD_GZ_FIELD] !== undefined;
    const hasBrotli = post[COMPRESSED_PAYLOAD_BR_FIELD] !== undefined;
    const guardInputs = post.guardInputs;
    return {
        apiName: post.apiName,
        version: typeof post.version === "string" ? post.version : null,
        signature: typeof post.signature === "string" ? post.signature : null,
        token: typeof post.token === "string" ? post.token : "",
        siteHost: typeof post.siteHost === "string" ? post.siteHost : "",
        payload: post.payload,
        compressedPayload: hasGzip || hasBrotli
            ? { gzip: post[COMPRESSED_PAYLOAD_GZ_FIELD], brotli: post[COMPRESSED_PAYLOAD_BR_FIELD], declaredBytes: post[COMPRESSED_PAYLOAD_BYTES_FIELD] }
            : null,
        // Arrays are refused: an array answers for its own properties, so a
        // guard named "length" would receive a number the client never sent.
        // Same reasoning as reading the map with hasOwnProperty.
        guardInputs: guardInputs !== null && typeof guardInputs === "object" && !Array.isArray(guardInputs) ? guardInputs : undefined,
        idempotencyKey: post.idempotencyKey,
        headers: info.headers,
        cookies: info.cookies,
        ip: info.ip,
        host: info.host,
        ...(info.signal ? { signal: info.signal } : {}),
    };
};
/**
 * Restores a payload the caller sent compressed (`payloadGz` or `payloadBr`,
 * beside `payloadBytes`) onto request.payload, so every later stage
 * (rate-limit key slices, guards, input validation, the handler) reads an
 * ordinary payload. The field names the encoding; a request carrying both is
 * refused. A plain payload passes through untouched.
 *
 * Failures return a message instead of throwing: a malformed body is a
 * client error, not a crash. The declared byte length both bounds and
 * verifies the decompression, so an over-large or tampered body is refused
 * rather than expanded. Runs on Node (zlib) and in a browser
 * (DecompressionStream) under the same bound.
 */
export const restoreCompressedPayload = async (request, maxPayloadBytes) => {
    const fields = request.compressedPayload;
    if (!fields)
        return { ok: true };
    const hasGzip = fields.gzip !== undefined;
    const hasBrotli = fields.brotli !== undefined;
    if (hasGzip && hasBrotli) {
        return { ok: false, message: `Request carries both ${COMPRESSED_PAYLOAD_GZ_FIELD} and ${COMPRESSED_PAYLOAD_BR_FIELD}; send one.` };
    }
    const fieldName = hasGzip ? COMPRESSED_PAYLOAD_GZ_FIELD : COMPRESSED_PAYLOAD_BR_FIELD;
    const encoding = hasGzip ? "gzip" : "br";
    const compressed = hasGzip ? fields.gzip : fields.brotli;
    if (typeof compressed !== "string") {
        return { ok: false, message: `Request ${fieldName} must be a base64 string.` };
    }
    const declaredBytes = fields.declaredBytes;
    if (typeof declaredBytes !== "number" || !Number.isSafeInteger(declaredBytes) || declaredBytes <= 0) {
        return { ok: false, message: `Request ${COMPRESSED_PAYLOAD_BYTES_FIELD} must be the payload's byte length.` };
    }
    if (declaredBytes > maxPayloadBytes) {
        return { ok: false, message: `Request payload of ${declaredBytes} bytes exceeds the ${maxPayloadBytes} byte limit.` };
    }
    // The bound and the exact-length verification are the codec's, the same
    // ones a stored record gets; only the wording of the refusal is ours.
    let json;
    try {
        json = await restoreText(base64ToBytes(compressed), encoding, { declaredBytes });
    }
    catch (err) {
        const reason = err instanceof LambderCompressionError ? err.reason : null;
        return { ok: false, message: reason === LAMBDER_RESTORE_FAILURES.lengthMismatch
                ? "Compressed request payload does not match its declared length."
                : "Compressed request payload could not be decompressed." };
    }
    let payload;
    try {
        payload = JSON.parse(json);
    }
    catch {
        return { ok: false, message: "Compressed request payload is not valid JSON." };
    }
    request.payload = payload;
    request.compressedPayload = null;
    return { ok: true };
};
