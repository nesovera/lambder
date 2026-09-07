import type { LambderRenderContext } from "./LambderContext.js";
import { type LambderCookieOptions, type LambderClearCookieOptions } from "./LambderCookie.js";
import type { LambderFiles } from "./LambderFiles.js";
import { LambderResponse, type HttpStatusCode, type LambderHeadersInput } from "./LambderResponse.js";
import { LambderSafeHtml } from "../shared/LambderHtml.js";
import type { LambderTemplateData } from "./LambderTemplatingEngine.js";
import type { LambderApiResponseConfig } from "../shared/LambderApiContract.js";
export type { LambderApiResponse, LambderApiResponseConfig } from "../shared/LambderApiContract.js";
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
export type LambderRawResponseInit = {
    statusCode: HttpStatusCode;
    headers?: LambderHeadersInput;
    body: string | Buffer | null;
    /** True when body is already a base64-encoded string. */
    isBase64Encoded?: boolean;
    compress?: boolean | "auto";
    etag?: boolean | "auto";
};
export default class LambderResponseBuilder<TResponse = any> {
    protected files: LambderFiles | null;
    protected apiVersion: string | null;
    protected ctx?: LambderRenderContext;
    constructor({ files, apiVersion, ctx }: {
        files?: LambderFiles | null;
        apiVersion?: string | null;
        ctx?: LambderRenderContext;
    });
    private buildResponse;
    /** The instance's file reader, which res.file and res.templateFile need. */
    private requireFiles;
    addHeader(key: string, value: string): void;
    setHeader(key: string, value: string | string[]): void;
    /**
     * Adds a Set-Cookie header. A function-form `domain` is resolved against
     * the request hostname. Defaults: Path=/, SameSite=Lax, Secure, not
     * HttpOnly, browser-session lifetime.
     */
    setCookie(name: string, value: string, options?: LambderCookieOptions): void;
    /**
     * Adds a Set-Cookie header that deletes the cookie. Pass the same
     * `domain` and `path` the cookie was set with: a cookie's identity is
     * (name, domain, path), and a deletion under a different scope targets a
     * different cookie and deletes nothing.
     */
    clearCookie(name: string, options?: LambderClearCookieOptions): void;
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
    /** A file from the files source as a response; 404 when there is none. */
    file(filePath: string, options?: LambderResponseOptions): Promise<LambderResponse>;
    /**
     * Render an HTML file from the files source through
     * LambderTemplatingEngine (comment-based slots/conditionals) and return
     * it as an HTML response. The compiled template is cached on the
     * instance across warm invocations; a missing file throws (it is a
     * server-side configuration error, not a client 404). Set
     * htmlVirtualSlots to expose "title"/"head" slots on marker-less files.
     */
    templateFile(filePath: string, data?: LambderTemplateData, options?: LambderResponseOptions & {
        htmlVirtualSlots?: boolean;
    }): Promise<LambderResponse>;
    api(payload: TResponse | null, { versionExpired, sessionExpired, notAuthorized, message, errorMessage, logList, }?: LambderApiResponseConfig, options?: LambderResponseOptions): LambderResponse;
    /** Same as api() but forces gzip compression of the response body. */
    apiBinary(payload: TResponse | null, config?: LambderApiResponseConfig, options?: LambderResponseOptions): LambderResponse;
}
