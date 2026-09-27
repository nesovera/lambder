import { LambderResponse } from "./LambderResponse.js";
import { buildApiEnvelope } from "../api/LambderApiEnvelope.js";
/**
 * Builds the responses of routes, hooks and error handlers. An API handler
 * never holds one: it returns its output or refuses, and writes headers and
 * cookies through its context (LambderResponseTools).
 */
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
            throw new Error(`Lambder: ${method} requires the files option at creation (e.g. files: new LambderLocalFileSource({ root }))`);
        return this.files;
    }
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
    redirect(url, statusCode = 302, options) {
        const response = this.buildResponse(statusCode, null, null, options);
        const target = /^[a-z][a-z0-9+.-]*:/iu.test(url) ? url : url.replace(/^[/\\]+/u, "/");
        // Everything outside printable ASCII (`!` to `~`), and the backslash.
        response.setHeader("Location", target.replace(/[^!-~]|\\/gu, (character) => encodeURIComponent(character)));
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
    /**
     * An API envelope written by hand: what a hook, an input validation
     * handler or a global error handler answers an API call with (a refusal
     * flag, an errorMessage, a crash). The payload goes out as given; an API
     * handler's own output is parsed through its schema by the instance
     * instead. The logList channel is what the request accumulated unless the
     * config names its own.
     */
    api(payload, config = {}, options) {
        const envelope = buildApiEnvelope(this.apiVersion, payload, { ...config, logList: config.logList || this.ctx?.logList });
        return this.json(envelope, options);
    }
    ;
}
;
