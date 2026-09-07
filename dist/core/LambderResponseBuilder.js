import { LambderResponse } from "./LambderResponse.js";
export default class LambderResponseBuilder {
    files;
    apiVersion;
    ctx;
    constructor({ files, apiVersion, ctx }) {
        this.files = files ?? null;
        this.apiVersion = apiVersion ?? null;
        this.ctx = ctx;
    }
    ;
    buildResponse(statusCode, contentType, body, options, defaults) {
        const response = new LambderResponse({
            statusCode: options?.statusCode ?? statusCode,
            headers: contentType ? { "Content-Type": contentType } : {},
            body,
            compress: options?.compress ?? defaults?.compress ?? "auto",
            etag: options?.etag ?? defaults?.etag ?? "auto",
        });
        if (options?.headers) {
            for (const [key, value] of Object.entries(options.headers))
                response.setHeader(key, value);
        }
        if (options?.cacheControl)
            response.setHeader("Cache-Control", options.cacheControl);
        return response;
    }
    /** The instance's file reader, which res.file and res.templateFile need. */
    requireFiles(method) {
        if (!this.files)
            throw new Error(`${method} requires the files option at creation (e.g. files: new LambderLocalFileSource({ root }))`);
        return this.files;
    }
    addHeader(key, value) {
        if (!this.ctx)
            throw new Error(".addHeader function is not available within this hook");
        this.ctx._otherInternal.addHeaderFnAccumulator.push({ key, value });
    }
    ;
    setHeader(key, value) {
        if (!this.ctx)
            throw new Error(".setHeader function is not available within this hook");
        this.ctx._otherInternal.addHeaderFnAccumulator = this.ctx._otherInternal.addHeaderFnAccumulator
            .filter((header) => header.key !== key);
        this.ctx._otherInternal.setHeaderFnAccumulator.push({ key, value });
    }
    ;
    logToApiResponse(input) {
        if (!this.ctx)
            throw new Error(".logToApiResponse function is not available within this hook");
        this.ctx._otherInternal.logToApiResponseAccumulator.push(input);
    }
    ;
    raw(init) {
        return new LambderResponse({
            statusCode: init.statusCode,
            headers: init.headers,
            body: init.body,
            isBodyBase64: init.isBase64Encoded ?? false,
            compress: init.compress ?? (init.isBase64Encoded ? false : "auto"),
            etag: init.etag ?? "auto",
        });
    }
    ;
    json(data, options) {
        return this.buildResponse(200, "application/json; charset=utf-8", JSON.stringify(data), options);
    }
    text(data, options) {
        return this.buildResponse(200, "text/plain; charset=utf-8", data, options);
    }
    xml(data, options) {
        return this.buildResponse(200, "application/xml; charset=utf-8", String(data), options);
    }
    ;
    html(data, options) {
        return this.buildResponse(200, "text/html; charset=utf-8", String(data), options);
    }
    ;
    status(statusCode, body, options) {
        return this.buildResponse(statusCode, "text/html; charset=utf-8", body ?? "", options);
    }
    ;
    status404(data, options) {
        return this.buildResponse(404, "text/html; charset=utf-8", data, options);
    }
    ;
    redirect(url, statusCode = 302, options) {
        const response = this.buildResponse(statusCode, null, null, options);
        response.setHeader("Location", url);
        return response;
    }
    ;
    versionExpired(options) {
        return this.api(null, { versionExpired: true }, options);
    }
    ;
    fileBase64(fileBase64, mimeType, options) {
        const response = new LambderResponse({
            statusCode: options?.statusCode ?? 200,
            headers: { "Content-Type": mimeType || "application/octet-stream" },
            body: fileBase64,
            isBodyBase64: true,
            compress: false,
            etag: options?.etag ?? "auto",
        });
        if (options?.headers) {
            for (const [key, value] of Object.entries(options.headers))
                response.setHeader(key, value);
        }
        if (options?.cacheControl)
            response.setHeader("Cache-Control", options.cacheControl);
        return response;
    }
    ;
    /** A file from the files source as a response; 404 when there is none. */
    async file(filePath, options) {
        const file = await this.requireFiles("res.file").read(filePath);
        if (!file)
            return this.status404("File not found", { etag: false });
        return this.buildResponse(200, file.mimeType, file.body, options);
    }
    ;
    /**
     * Render an HTML file from the files source through
     * LambderTemplatingEngine (comment-based slots/conditionals) and return
     * it as an HTML response. The compiled template is cached on the
     * instance across warm invocations; a missing file throws (it is a
     * server-side configuration error, not a client 404). Set
     * htmlVirtualSlots to expose "title"/"head" slots on marker-less files.
     */
    async templateFile(filePath, data, options) {
        const template = await this.requireFiles("res.templateFile").template(filePath, { htmlVirtualSlots: options?.htmlVirtualSlots });
        return this.buildResponse(200, "text/html; charset=utf-8", template.render(data), options);
    }
    ;
    api(payload, { versionExpired, sessionExpired, notAuthorized, message, errorMessage, logList, } = {}, options) {
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
    }
    ;
    /** Same as api() but forces gzip compression of the response body. */
    apiBinary(payload, config = {}, options) {
        return this.api(payload, config, { ...options, compress: true });
    }
    ;
}
;
