import type { LambderRenderContext } from "./LambderContext.js";
import type { LambderFiles } from "./LambderFiles.js";
import { LambderResponse, type LambderHeadersInput } from "./LambderResponse.js";
import type { LambderHttpStatusCode } from "../shared/wire/LambderHttpStatus.js";
import { LambderSafeHtml } from "../shared/LambderHtml.js";
import type { LambderTemplateData } from "./LambderTemplatingEngine.js";
// The API envelope types live with the contract (shared/, browser-safe) so
// the caller and MSW never have to import this server-side module for them.
import type { LambderApiRefusalConfig } from "../shared/wire/LambderApiContract.js";
import { plainRefusalEnvelope } from "../api/LambderApiEnvelope.js";

export type { LambderApiEnvelopeBody, LambderApiRefusalConfig } from "../shared/wire/LambderApiContract.js";

export type LambderResponseOptions = {
    statusCode?: LambderHttpStatusCode;
    headers?: LambderHeadersInput;
    /** Shorthand for the Cache-Control header. */
    cacheControl?: string;
    /** "auto" (default): gzip when compressible/large enough. true: force. false: never. */
    compress?: boolean | "auto";
    /** "auto" (default): ETag on GET/HEAD 200 when globally enabled. true: force. false: never. */
    etag?: boolean | "auto";
};

export type LambderRawResponseInit = {
    statusCode: LambderHttpStatusCode;
    headers?: LambderHeadersInput;
    body: string | Buffer | null;
    /** True when body is already a base64-encoded string. */
    isBase64Encoded?: boolean;
    compress?: boolean | "auto";
    etag?: boolean | "auto";
};

/**
 * Builds the responses of routes, hooks and error handlers. An API handler
 * never holds one: it returns its output or refuses, and writes headers and
 * cookies through its context (LambderResponseTools).
 */
export default class LambderResponseBuilder {
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
        statusCode: LambderHttpStatusCode,
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
        if(!this.files) throw new Error(`Lambder: ${method} requires the files option at creation (e.g. files: new LambderLocalFileSource({ root }))`);
        return this.files;
    }

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

    status(statusCode: LambderHttpStatusCode, body?: string, options?: LambderResponseOptions): LambderResponse {
        return this.buildResponse(statusCode, "text/html; charset=utf-8", body ?? "", options);
    };

    status404(data: string, options?: LambderResponseOptions): LambderResponse {
        return this.buildResponse(404, "text/html; charset=utf-8", data, options);
    };

    /**
     * A redirect to `url`, which may be a path or a whole URL. A path stays on
     * this origin: a leading run of slashes and backslashes collapses to one
     * slash, since `//evil.example` is a protocol-relative URL and a browser
     * reads `/\evil.example` as the same thing, so a path built from a
     * decoded ctx.path cannot send the visitor to another host. Another host
     * is named with its scheme. What a URL may not carry as it is (control
     * characters, a space, a backslash, anything outside ASCII) is
     * percent-encoded for every caller: a browser drops a TAB or line break
     * inside a Location, so `/<TAB>/evil.example` would otherwise be that
     * host, and a line break would end the header. `%` is left alone, so an
     * encoded URL stays as it was written.
     */
    redirect(url: string, statusCode: LambderHttpStatusCode = 302, options?: LambderResponseOptions): LambderResponse {
        const response = this.buildResponse(statusCode, null, null, options);
        const target = /^[a-z][a-z0-9+.-]*:/iu.test(url) ? url : url.replace(/^[/\\]+/u, "/");
        // Everything outside printable ASCII (`!` to `~`), and the backslash.
        response.setHeader("Location", target.replace(/[^!-~]|\\/gu, (character) => encodeURIComponent(character)));
        return response;
    };

    versionExpired(options?: LambderResponseOptions): LambderResponse {
        return this.apiRefusal({ versionExpired: true }, options);
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

    /**
     * An API call answered from outside its handler: what a hook, a fallback,
     * the input validation handler or the global error handler answers with.
     * It is always a refusal (a refusal message, or one of the versionExpired,
     * sessionExpired and notAuthorized flags) with a null payload, so a
     * caller's success is only ever the handler's parsed output. Its message
     * carries a framework code or none, and no data, since it answers outside
     * any one endpoint's declared refusals. The logList channel is what the
     * request accumulated unless the config names its own.
     */
    apiRefusal(config: LambderApiRefusalConfig, options?: LambderResponseOptions): LambderResponse {
        return this.json(plainRefusalEnvelope(this.apiVersion, config, "res.apiRefusal()", this.ctx?.logList) as Record<string, any>, options);
    };

};
