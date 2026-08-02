import type { LambderRenderContext } from "./LambderContext.js";
import { LambderResponse, type HttpStatusCode, type LambderHeadersInput } from "./LambderResponse.js";
import { LambderSafeHtml } from "./LambderHtml.js";
import { type LambderTemplateData } from "./LambderTemplatingEngine.js";
export type LambderResponseOptions = {
    statusCode?: HttpStatusCode;
    headers?: LambderHeadersInput;
    /** Shorthand for the Cache-Control header. */
    cacheControl?: string;
    /** "auto" (default): gzip when compressible/large enough. true: force. false: never. */
    compress?: boolean | "auto";
    /** "auto" (default): ETag on GET/HEAD 200 when globally enabled. true: force. false: never. */
    etag?: boolean | "auto";
};
export type LambderApiResponseConfig = {
    versionExpired?: boolean;
    sessionExpired?: boolean;
    notAuthorized?: boolean;
    message?: any;
    errorMessage?: any;
    logList?: any[];
};
export type LambderApiResponse<T> = LambderApiResponseConfig & {
    apiVersion?: string | null;
    payload?: T | null;
};
export type LambderRawResponseInit = {
    statusCode: HttpStatusCode;
    headers?: LambderHeadersInput;
    /** Legacy alias for headers (API Gateway naming). */
    multiValueHeaders?: Record<string, string[]>;
    body: string | Buffer | null;
    /** True when body is already a base64-encoded string. */
    isBase64Encoded?: boolean;
    compress?: boolean | "auto";
    etag?: boolean | "auto";
};
export default class LambderResponseBuilder<TResponse = any> {
    protected publicPath: string;
    protected apiVersion: string | null;
    protected ctx?: LambderRenderContext;
    constructor({ publicPath, apiVersion, ctx }: {
        publicPath: string;
        apiVersion?: string | null;
        ctx?: LambderRenderContext;
    });
    private buildResponse;
    private resolvePublicFilePath;
    addHeader(key: string, value: string): void;
    setHeader(key: string, value: string | string[]): void;
    logToApiResponse(input: any): void;
    raw(init: LambderRawResponseInit): LambderResponse;
    json(data: Record<string, any>, options?: LambderResponseOptions): LambderResponse;
    text(data: string, options?: LambderResponseOptions): LambderResponse;
    xml(data: string | LambderSafeHtml, options?: LambderResponseOptions): LambderResponse;
    html(data: string | LambderSafeHtml, options?: LambderResponseOptions): LambderResponse;
    status(statusCode: HttpStatusCode, body?: string, options?: LambderResponseOptions): LambderResponse;
    status404(data: string, options?: LambderResponseOptions): LambderResponse;
    redirect(url: string, statusCode?: HttpStatusCode, options?: LambderResponseOptions): LambderResponse;
    versionExpired(options?: LambderResponseOptions): LambderResponse;
    fileBase64(fileBase64: string, mimeType: string, options?: LambderResponseOptions): LambderResponse;
    file(filePath: string, options?: LambderResponseOptions & {
        fallback?: string;
    }): Promise<LambderResponse>;
    /**
     * Render an HTML file under publicPath through LambderTemplatingEngine
     * (comment-based slots/conditionals) and return it as an HTML response.
     * The compiled template is cached across warm invocations; a missing file
     * throws (it is a server-side configuration error, not a client 404).
     * Set htmlVirtualSlots to expose "title"/"head" slots on marker-less files.
     */
    templateFile(filePath: string, data?: LambderTemplateData, options?: LambderResponseOptions & {
        htmlVirtualSlots?: boolean;
    }): Promise<LambderResponse>;
    api(payload: TResponse | null, { versionExpired, sessionExpired, notAuthorized, message, errorMessage, logList, }?: LambderApiResponseConfig, options?: LambderResponseOptions): LambderResponse;
    /** Same as api() but forces gzip compression of the response body. */
    apiBinary(payload: TResponse | null, config?: LambderApiResponseConfig, options?: LambderResponseOptions): LambderResponse;
}
