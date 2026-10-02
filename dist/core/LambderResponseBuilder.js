import { outcomeOfEnvelope } from "../shared/wire/LambderCallOutcome.js";
import { LambderResponse } from "./LambderResponse.js";
import { LambderSafeHtml } from "../shared/LambderHtml.js";
import { plainRefusalEnvelope } from "../api/LambderApiEnvelope.js";
/**
 * The body of a response a browser renders as markup: safe markup only. A
 * plain string is refused rather than sent, since nothing can tell markup an
 * author wrote from text a request supplied (`"No match at " + ctx.path`),
 * and the latter, sent as a page, runs as script. The tag escapes what it
 * interpolates, raw() is the one visible place where trusted markup passes as
 * it is, and text goes out as text.
 */
const markupBody = (method, tag, body) => {
    if (body instanceof LambderSafeHtml)
        return body.value;
    throw new TypeError(`Lambder: ${method} takes safe ${tag === "html" ? "HTML" : "XML"}, and was given ${body === null ? "null" : typeof body}. Build the body with ${tag}\`...\`, which ` +
        `escapes what it interpolates, mark markup you trust with raw(), or send plain text with res.text(body, { statusCode }).`);
};
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
    /** A plain-text body, sent as text: the place for a message, whatever status it goes out with (`{ statusCode }`). */
    text(data, options) {
        return this.buildResponse(200, "text/plain; charset=utf-8", data, options);
    }
    /** An XML document (a sitemap, a feed, SVG) built with xml`...` or marked safe with raw(). */
    xml(data, options) {
        return this.buildResponse(200, "application/xml; charset=utf-8", markupBody("res.xml", "xml", data), options);
    }
    ;
    /** An HTML page built with html`...` or marked safe with raw(). */
    html(data, options) {
        return this.buildResponse(200, "text/html; charset=utf-8", markupBody("res.html", "html", data), options);
    }
    ;
    /** An HTML response with any status code, its body built like res.html's; no body sends an empty one. */
    status(statusCode, body, options) {
        return this.buildResponse(statusCode, "text/html; charset=utf-8", body === undefined ? "" : markupBody("res.status", "html", body), options);
    }
    ;
    /** An HTML 404, its body built like res.html's. */
    status404(data, options) {
        return this.buildResponse(404, "text/html; charset=utf-8", markupBody("res.status404", "html", data), options);
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
        return this.apiRefusal({ versionExpired: true }, options);
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
            return this.text("File not found", { statusCode: 404, etag: false });
        return this.buildResponse(200, file.mimeType, file.body, options);
    }
    ;
    /**
     * Render an HTML file from the files source through
     * LambderTemplatingEngine (comment-based slots/conditionals) and return
     * it as an HTML response. The compiled template is cached on the
     * instance across warm invocations; a missing file throws (it is a
     * server-side configuration error, not a client 404), and so does a data
     * key the file has no slot or condition for, naming the file. TNames, when
     * given, is the file's slot and condition names, so a misspelled key is a
     * compile error. Set htmlVirtualSlots to expose "title"/"head" slots on
     * marker-less files.
     */
    async templateFile(filePath, data, options) {
        const template = await this.requireFiles("res.templateFile").template(filePath, { htmlVirtualSlots: options?.htmlVirtualSlots });
        let body;
        try {
            body = template.render(data);
        }
        catch (error) {
            // The engine knows its source, not the file it came from.
            throw new Error(`Lambder: res.templateFile(${JSON.stringify(filePath)}): ${error.message}`, { cause: error });
        }
        return this.buildResponse(200, "text/html; charset=utf-8", body, options);
    }
    ;
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
    apiRefusal(config, options) {
        const envelope = plainRefusalEnvelope(this.apiVersion, config, "res.apiRefusal()", this.ctx?.logList);
        const response = this.json(envelope, options);
        response.callOutcome = outcomeOfEnvelope(envelope, response.statusCode);
        return response;
    }
    ;
}
;
