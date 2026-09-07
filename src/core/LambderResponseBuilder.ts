import type { LambderRenderContext } from "./LambderContext.js";
import type { LambderFiles } from "./LambderFiles.js";
import { LambderResponse, type HttpStatusCode, type LambderHeadersInput } from "./LambderResponse.js";
import { LambderSafeHtml } from "../shared/LambderHtml.js";
import type { LambderTemplateData } from "./LambderTemplatingEngine.js";
// The API envelope types live with the contract (shared/, browser-safe) so
// the caller and MSW never have to import this server-side module for them.
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

    constructor(
        { files, apiVersion, ctx }:
        {
            files?: LambderFiles | null,
            apiVersion?: string | null,
            ctx?: LambderRenderContext,
        }
    ){
        this.files = files ?? null;
        this.apiVersion = apiVersion ?? null;
        this.ctx = ctx;
    };

    private buildResponse(
        statusCode: HttpStatusCode,
        contentType: string | null,
        body: string | Buffer | null,
        options?: LambderResponseOptions,
        defaults?: { compress?: boolean | "auto", etag?: boolean | "auto" },
    ): LambderResponse {
        const response = new LambderResponse({
            statusCode: options?.statusCode ?? statusCode,
            headers: contentType ? { "Content-Type": contentType } : {},
            body,
            compress: options?.compress ?? defaults?.compress ?? "auto",
            etag: options?.etag ?? defaults?.etag ?? "auto",
        });
        if(options?.headers){
            for(const [key, value] of Object.entries(options.headers)) response.setHeader(key, value);
        }
        if(options?.cacheControl) response.setHeader("Cache-Control", options.cacheControl);
        return response;
    }

    /** The instance's file reader, which res.file and res.templateFile need. */
    private requireFiles(method: string): LambderFiles {
        if(!this.files) throw new Error(`${method} requires the files option at creation (e.g. files: new LambderLocalFileSource({ root }))`);
        return this.files;
    }

    addHeader(key: string, value: string){
        if(!this.ctx) throw new Error(".addHeader function is not available within this hook");
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key, value });
    };

    setHeader(key: string, value: string | string[]){
        if(!this.ctx) throw new Error(".setHeader function is not available within this hook");
        this.ctx._otherInternal.addHeaderFnAccumulator = this.ctx._otherInternal.addHeaderFnAccumulator
            .filter((header) => header.key !== key);
        this.ctx._otherInternal.setHeaderFnAccumulator.push({ key, value });
    };

    logToApiResponse(input: any){
        if(!this.ctx) throw new Error(".logToApiResponse function is not available within this hook");
        this.ctx._otherInternal.logToApiResponseAccumulator.push(input);
    };

    raw(init: LambderRawResponseInit): LambderResponse {
        return new LambderResponse({
            statusCode: init.statusCode,
            headers: init.headers,
            body: init.body,
            isBodyBase64: init.isBase64Encoded ?? false,
            compress: init.compress ?? (init.isBase64Encoded ? false : "auto"),
            etag: init.etag ?? "auto",
        });
    };

    json(data: Record<string, any>, options?: LambderResponseOptions): LambderResponse {
        return this.buildResponse(200, "application/json; charset=utf-8", JSON.stringify(data), options);
    }

    text(data: string, options?: LambderResponseOptions): LambderResponse {
        return this.buildResponse(200, "text/plain; charset=utf-8", data, options);
    }

    xml(data: string | LambderSafeHtml, options?: LambderResponseOptions): LambderResponse {
        return this.buildResponse(200, "application/xml; charset=utf-8", String(data), options);
    };

    html(data: string | LambderSafeHtml, options?: LambderResponseOptions): LambderResponse {
        return this.buildResponse(200, "text/html; charset=utf-8", String(data), options);
    };

    status(statusCode: HttpStatusCode, body?: string, options?: LambderResponseOptions): LambderResponse {
        return this.buildResponse(statusCode, "text/html; charset=utf-8", body ?? "", options);
    };

    status404(data: string, options?: LambderResponseOptions): LambderResponse {
        return this.buildResponse(404, "text/html; charset=utf-8", data, options);
    };

    redirect(url: string, statusCode: HttpStatusCode = 302, options?: LambderResponseOptions): LambderResponse {
        const response = this.buildResponse(statusCode, null, null, options);
        response.setHeader("Location", url);
        return response;
    };

    versionExpired(options?: LambderResponseOptions): LambderResponse {
        return this.api(null, { versionExpired: true }, options);
    };

    fileBase64(fileBase64: string, mimeType: string, options?: LambderResponseOptions): LambderResponse {
        const response = new LambderResponse({
            statusCode: options?.statusCode ?? 200,
            headers: { "Content-Type": mimeType || "application/octet-stream" },
            body: fileBase64,
            isBodyBase64: true,
            compress: false,
            etag: options?.etag ?? "auto",
        });
        if(options?.headers){
            for(const [key, value] of Object.entries(options.headers)) response.setHeader(key, value);
        }
        if(options?.cacheControl) response.setHeader("Cache-Control", options.cacheControl);
        return response;
    };

    /** A file from the files source as a response; 404 when there is none. */
    async file(filePath: string, options?: LambderResponseOptions): Promise<LambderResponse> {
        const file = await this.requireFiles("res.file").read(filePath);
        if(!file) return this.status404("File not found", { etag: false });
        return this.buildResponse(200, file.mimeType, file.body, options);
    };

    /**
     * Render an HTML file from the files source through
     * LambderTemplatingEngine (comment-based slots/conditionals) and return
     * it as an HTML response. The compiled template is cached on the
     * instance across warm invocations; a missing file throws (it is a
     * server-side configuration error, not a client 404). Set
     * htmlVirtualSlots to expose "title"/"head" slots on marker-less files.
     */
    async templateFile(
        filePath: string,
        data?: LambderTemplateData,
        options?: LambderResponseOptions & { htmlVirtualSlots?: boolean },
    ): Promise<LambderResponse> {
        const template = await this.requireFiles("res.templateFile").template(filePath, { htmlVirtualSlots: options?.htmlVirtualSlots });
        return this.buildResponse(200, "text/html; charset=utf-8", template.render(data), options);
    };

    api(
        payload: TResponse | null,
        {
            versionExpired, sessionExpired, notAuthorized,
            message, errorMessage, logList,
        }: LambderApiResponseConfig = {},
        options?: LambderResponseOptions,
    ): LambderResponse {
        const finalLogList = logList || this.ctx?._otherInternal?.logToApiResponseAccumulator;
        return this.json({
            apiVersion: this.apiVersion,
            payload,
            ...(versionExpired ? { versionExpired } : {}),
            ...(sessionExpired ? { sessionExpired } : {}),
            ...(notAuthorized ? { notAuthorized } : {}),
            ...(message ? { message } : {}),
            ...(errorMessage ? { errorMessage } : {}),
            ...(finalLogList?.length ? { logList: finalLogList } : {}),
        }, options);
    };

    /** Same as api() but forces gzip compression of the response body. */
    apiBinary(
        payload: TResponse | null,
        config: LambderApiResponseConfig = {},
        options?: LambderResponseOptions,
    ): LambderResponse {
        return this.api(payload, config, { ...options, compress: true });
    };

};
