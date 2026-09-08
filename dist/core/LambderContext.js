import cookieParser from "cookie";
import { COMPRESSED_PAYLOAD_FIELD, COMPRESSED_PAYLOAD_BYTES_FIELD, } from "../shared/LambderRequestPayload.js";
import { restoreBoundedText, LambderCompressionError, LAMBDER_RESTORE_FAILURES, } from "../shared/LambderCompressionCodec.js";
/** True for API Gateway HTTP API / Lambda Function URL (payload v2) events. */
export const isV2HttpEvent = (event) => !!event && typeof event === "object"
    && event.version === "2.0"
    && !!event.requestContext?.http;
export const createContext = (event, lambdaContext, apiPath) => {
    // Normalize the two API Gateway payload formats into one shape.
    const eventFormat = isV2HttpEvent(event) ? "v2" : "v1";
    let host;
    let path;
    let method;
    let get;
    let cookiePairs;
    let sourceIp;
    const headers = event.headers ?? {};
    if (isV2HttpEvent(event)) {
        host = headers.host || event.requestContext.domainName || "";
        path = event.rawPath;
        // Named stages (non-$default) are included in rawPath; v1 strips them.
        const stage = event.requestContext.stage;
        if (stage && stage !== "$default" && (path === `/${stage}` || path.startsWith(`/${stage}/`))) {
            path = path.slice(stage.length + 1) || "/";
        }
        method = event.requestContext.http.method;
        get = {};
        for (const [key, value] of new URLSearchParams(event.rawQueryString ?? "").entries()) {
            get[key] = value;
        }
        // v2 delivers the Cookie header pre-split into name=value pairs.
        cookiePairs = event.cookies ?? [];
        sourceIp = event.requestContext.http.sourceIp || "";
    }
    else {
        host = headers.Host || headers.host || "";
        path = event.path;
        method = event.httpMethod;
        get = event.queryStringParameters || {};
        cookiePairs = (headers.Cookie || headers.cookie || "").split(";");
        sourceIp = event.requestContext?.identity?.sourceIp || "";
    }
    // Parsed pair by pair so a name that arrived more than once keeps every
    // value; a whole-header parse keeps only the first.
    const cookieList = {};
    for (const pair of cookiePairs) {
        for (const [name, value] of Object.entries(cookieParser.parse(pair))) {
            if (value !== undefined)
                (cookieList[name] ??= []).push(value);
        }
    }
    const cookie = Object.fromEntries(Object.entries(cookieList).map(([name, values]) => [name, values[0]]));
    const lowercasedHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined)
            lowercasedHeaders[key.toLowerCase()] = value;
    }
    const header = (name) => lowercasedHeaders[name.toLowerCase()];
    const forwardedFor = lowercasedHeaders["x-forwarded-for"];
    const ip = lowercasedHeaders["cf-connecting-ip"]
        || (forwardedFor ? (forwardedFor.split(",")[0] ?? "").trim() : "")
        || sourceIp
        || "";
    // Decode body: keep the raw string, then parse as JSON with urlencoded fallback.
    let rawBody = "";
    let post = {};
    try {
        rawBody = event.isBase64Encoded
            ? (event.body ? Buffer.from(event.body, "base64").toString() : "")
            : (event.body || "");
        try {
            post = JSON.parse(rawBody || "{}") || {};
        }
        catch (e) {
            const params = new URLSearchParams(rawBody);
            post = {};
            for (const [key, value] of params.entries()) {
                post[key] = value;
            }
        }
    }
    catch (e) { }
    const isApiCall = !!(method === "POST" && apiPath && path === apiPath && post.apiName);
    const apiName = isApiCall ? post.apiName : null;
    const apiPayload = isApiCall ? post.payload : null;
    const requestVersion = isApiCall ? (post.version ?? null) : null;
    return {
        host, path, pathParams: {}, method,
        get, post, cookie, cookieList, event,
        session: null,
        apiName, apiPayload,
        guardData: {},
        headers, rawBody, ip, header,
        lambdaContext,
        _otherInternal: {
            isApiCall, requestVersion, eventFormat,
            setHeaderFnAccumulator: [],
            addHeaderFnAccumulator: [],
            logToApiResponseAccumulator: [],
        }
    };
};
/**
 * Restores a request payload the caller sent gzipped (`payloadGz` +
 * `payloadBytes`) onto ctx.post.payload and ctx.apiPayload, so every later
 * stage (rate-limit key slices, guards, input validation, the handler) reads
 * an ordinary payload and needs no awareness of the wire format. A request
 * that sent a plain payload passes through untouched.
 *
 * Every failure answers with a message instead of throwing: a malformed body
 * is a client error, not a crash. The declared byte length both bounds the
 * decompression and verifies it, so an over-large or tampered body is
 * refused rather than expanded.
 */
export const restoreCompressedApiPayload = async (ctx, maxPayloadBytes) => {
    const post = ctx.post;
    const compressed = post[COMPRESSED_PAYLOAD_FIELD];
    if (compressed === undefined)
        return { ok: true };
    if (typeof compressed !== "string") {
        return { ok: false, message: `Request ${COMPRESSED_PAYLOAD_FIELD} must be a base64 string.` };
    }
    const declaredBytes = post[COMPRESSED_PAYLOAD_BYTES_FIELD];
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
        json = await restoreBoundedText(Buffer.from(compressed, "base64"), declaredBytes, "gzip");
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
    delete post[COMPRESSED_PAYLOAD_FIELD];
    delete post[COMPRESSED_PAYLOAD_BYTES_FIELD];
    post.payload = payload;
    ctx.apiPayload = payload;
    return { ok: true };
};
