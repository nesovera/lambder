import type { LambderApiAnswer } from "../api/LambderApiAnswer.js";
import { readApiEnvelope, cookieValuesByName, lowercaseHeaderNames, type LambderApiRequest } from "../api/LambderApiRequest.js";
import { getAnswerHeader } from "../shared/wire/LambderAnswerHeaders.js";
import { base64ToText } from "../shared/util/LambderBase64.js";
import { normalizeClientIp } from "../shared/util/LambderClientIp.js";

/**
 * The fields of an invoke's synthesized event this transport reads, declared
 * structurally rather than imported as APIGatewayProxyEventV2.
 *
 * `lambder/mock` is browser-safe, and its type graph is part of that claim: a
 * type-only import of the invoke caller pulled `aws-lambda` and
 * `@aws-sdk/client-lambda` into the .d.ts graph of the mock entry, so a
 * frontend compiling without `skipLibCheck` and without those @types got
 * errors from inside node_modules for a module it never loads. Every field a
 * real event carries is optional here and no field is required, so a real
 * event is assignable and the returned function still fits
 * LambderInvokeTransport wherever a caller expects one.
 */
export type LambderMockInvokeEvent = {
    body?: string | undefined;
    isBase64Encoded?: boolean | undefined;
    headers?: Record<string, string | undefined> | undefined;
    cookies?: string[] | undefined;
    requestContext?: { http?: { sourceIp?: string } | undefined; domainName?: string } | undefined;
};

/** What the callee answers with: the Lambda response object LambderInvokeCaller decodes. */
export type LambderMockInvokeResult = {
    functionError: string | null;
    result: {
        statusCode: number;
        headers: Record<string, string>;
        cookies?: string[];
        body: string;
        isBase64Encoded: boolean;
    };
};

/**
 * The mock app as the callee of a LambderInvokeCaller: the invoke's
 * synthesized event is read the way the callee's createContext would read
 * it, and the answer goes back as the Lambda response object the caller
 * decodes. So a server test can point its typed invoke caller at a mock of
 * the function it depends on, with the same registry a browser test uses.
 */
export const lambderMockInvokeTransport = (
    mockApp: { handleRequest(request: LambderApiRequest): Promise<LambderApiAnswer> },
): ((event: LambderMockInvokeEvent, options: { signal?: AbortSignal }) => Promise<LambderMockInvokeResult>) => async (event, { signal }) => {
    const rawBody = event.body ?? "";
    const body = event.isBase64Encoded ? base64ToText(rawBody) : rawBody;
    let post: Record<string, unknown> = {};
    try { post = JSON.parse(body || "{}") ?? {}; } catch { post = {}; }
    const headers = lowercaseHeaderNames(event.headers);
    const cookies = cookieValuesByName(event.cookies ?? []);
    // The address the synthesized event carries in sourceIp, as the server's
    // createContext reads it; no forwarding header is trusted here either,
    // so a per-IP limit keys the same address under both adapters.
    const request = readApiEnvelope(post, {
        headers, cookies,
        ip: normalizeClientIp(event.requestContext?.http?.sourceIp ?? ""),
        host: headers.host || event.requestContext?.domainName || "lambder-invoke",
        ...(signal ? { signal } : {}),
    });
    if(!request){
        return { functionError: null, result: { statusCode: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Not found.", isBase64Encoded: false } };
    }
    const answer = await mockApp.handleRequest(request);
    const singleHeaders: Record<string, string> = {};
    for(const [key, values] of Object.entries(answer.headers)){
        if(key.toLowerCase() !== "set-cookie") singleHeaders[key] = values.join(", ");
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
