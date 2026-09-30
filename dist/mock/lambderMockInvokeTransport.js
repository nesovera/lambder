import { apiNameOfCallPath } from "../shared/wire/LambderApiNames.js";
import { DEFAULT_API_PATH } from "../shared/wire/LambderDefaultApiPath.js";
import { readApiEnvelope, cookieValuesByName, isApiCallContentType, lowercaseHeaderNames } from "../api/LambderApiRequest.js";
import { getAnswerHeader } from "../shared/wire/LambderAnswerHeaders.js";
import { base64ToText } from "../shared/util/LambderBase64.js";
import { normalizeClientIp } from "../shared/util/LambderClientIp.js";
/**
 * The mock app as the callee of a LambderInvokeCaller: the synthesized event
 * is read the way the callee's createContext would read it, and the answer
 * goes back as the Lambda response object the caller decodes. A server test
 * can then point its typed invoke caller at a mock of the function it
 * depends on, with the same registry a browser test uses.
 */
export const lambderMockInvokeTransport = (mockApp, options = {}) => async (event, { signal }) => {
    const apiPath = options.apiPath ?? DEFAULT_API_PATH;
    const rawBody = event.body ?? "";
    const body = event.isBase64Encoded ? base64ToText(rawBody) : rawBody;
    let post = {};
    try {
        post = JSON.parse(body || "{}") ?? {};
    }
    catch {
        post = {};
    }
    const headers = lowercaseHeaderNames(event.headers);
    const cookies = cookieValuesByName(event.cookies ?? []);
    // A JSON POST to `{apiPath}/{group}/{action}` is a call, as the server's
    // createContext reads it; anything else (another method or type, a path
    // outside apiPath) is no API call on the server either, and a mock
    // serves no routes. The address is the one the synthesized event carries
    // in sourceIp, as createContext reads it; no forwarding header is trusted
    // here either, so a per-IP limit keys the same address under both adapters.
    const apiName = event.requestContext?.http?.method === "POST" && isApiCallContentType(headers)
        ? apiNameOfCallPath(apiPath, event.rawPath ?? "")
        : null;
    const request = apiName !== null && readApiEnvelope(post, {
        headers, cookies,
        ip: normalizeClientIp(event.requestContext?.http?.sourceIp ?? ""),
        host: headers.host || event.requestContext?.domainName || "lambder-invoke",
        ...(signal ? { signal } : {}),
    }, apiName);
    if (!request) {
        return { functionError: null, result: { statusCode: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Not found.", isBase64Encoded: false } };
    }
    const answer = await mockApp.handleRequest(request);
    const singleHeaders = {};
    for (const [key, values] of Object.entries(answer.headers)) {
        if (key.toLowerCase() !== "set-cookie")
            singleHeaders[key] = values.join(", ");
    }
    return {
        functionError: null,
        result: {
            statusCode: answer.statusCode,
            headers: singleHeaders,
            cookies: getAnswerHeader(answer.headers, "Set-Cookie") ?? [],
            body: answer.body,
            isBase64Encoded: answer.isBodyBase64 ?? false,
        },
    };
};
