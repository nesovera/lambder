import { serializeCookie, serializeClearCookie } from "../shared/wire/LambderCookie.js";
import { LambderResponse } from "./LambderResponse.js";
import { buildApiEnvelope } from "../api/LambderApiEnvelope.js";
import { LambderApiOutputValidationError } from "../api/LambderApiOutputValidationError.js";
export default class LambderResponseBuilder {
    files;
    apiVersion;
    ctx;
    /** The output schema of the API this builder answers, which every success payload is parsed through; null outside an API handler. */
    apiOutput;
    constructor({ files, apiVersion, ctx, apiOutput }) {
        this.files = files ?? null;
        this.apiVersion = apiVersion ?? null;
        this.ctx = ctx;
        this.apiOutput = apiOutput ?? null;
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
    /** Appends a response header; applied onto the response once the handler has one, in call order. */
    addHeader(key, value) {
        if (!this.ctx)
            throw new Error("Lambder: res.addHeader needs the request context, and this response builder was created without one.");
        this.ctx.responseHeaders.add(key, value);
    }
    ;
    /** Replaces a response header; applied onto the response once the handler has one, in call order. */
    setHeader(key, value) {
        if (!this.ctx)
            throw new Error("Lambder: res.setHeader needs the request context, and this response builder was created without one.");
        this.ctx.responseHeaders.set(key, value);
    }
    ;
    /**
     * Adds a Set-Cookie header. A function-form `domain` is resolved against
     * the request hostname. Defaults: Path=/, SameSite=Lax, Secure, not
     * HttpOnly, browser-session lifetime.
     */
    setCookie(name, value, options) {
        if (!this.ctx)
            throw new Error("Lambder: res.setCookie needs the request context, and this response builder was created without one.");
        this.addHeader("Set-Cookie", serializeCookie(name, value, options, this.ctx.host));
    }
    ;
    /**
     * Adds a Set-Cookie header that deletes the cookie. Pass the same
     * `domain` and `path` the cookie was set with: a cookie's identity is
     * (name, domain, path), and a deletion under a different scope targets a
     * different cookie and deletes nothing.
     */
    clearCookie(name, options) {
        if (!this.ctx)
            throw new Error("Lambder: res.clearCookie needs the request context, and this response builder was created without one.");
        this.addHeader("Set-Cookie", serializeClearCookie(name, options, this.ctx.host));
    }
    ;
    logToApiResponse(input) {
        if (!this.ctx)
            throw new Error("Lambder: res.logToApiResponse needs the request context, and this response builder was created without one.");
        this.ctx.logList.push(input);
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
    api(payload, config = {}, options) {
        // The envelope is the core's (one writer for both the server and the
        // mock runtime); the logList channel is what this request accumulated
        // unless the config names its own.
        const envelope = buildApiEnvelope(this.apiVersion, this.declaredPayload(payload), { ...config, logList: config.logList || this.ctx?.logList });
        return this.json(envelope, options);
    }
    ;
    /**
     * A payload as the API's output schema declares it. The type system
     * accepts a value that carries more than the schema (a row read straight
     * from a table is assignable to a narrower object type), and without this
     * the extra fields, a password hash included, would reach the client.
     * zod strips what the schema does not declare, fills its defaults and
     * applies its transforms, so the wire and the idempotency store only see
     * the declared shape. A refusal's payload beside an errorMessage or a
     * flag is parsed the same way; only null passes as it is. Only an API
     * handler's own resolver holds the schema: a hook, a validation handler
     * or an error handler answers in shapes of its own, a cached answer in
     * its wire form, and is sent as given.
     *
     * The payload is the schema's input form (what a handler writes before
     * the transforms), so a transform runs exactly once. A payload the schema
     * rejects is a handler breaking its contract, answered as a crash rather
     * than sent (LambderApiOutputValidationError, which an idempotency key
     * records as its answer, since the handler has already run).
     *
     * The parse is synchronous, so an output schema cannot be async: zod
     * throws from a synchronous parse that meets an async refinement or
     * transform, and a transform may throw of its own accord. Either throw
     * becomes the same LambderApiOutputValidationError, carrying what was
     * thrown as its cause. Left to escape as it is, it would read as the
     * handler crashing before its answer: the idempotency engine would
     * release the key's claim and every retry would run the operation again.
     */
    declaredPayload(payload) {
        if (!this.apiOutput || payload === null)
            return payload;
        const apiName = this.ctx?.apiName ?? "?";
        let parsed;
        try {
            parsed = this.apiOutput.safeParse(payload);
        }
        catch (thrown) {
            throw new LambderApiOutputValidationError(apiName, { thrown });
        }
        if (parsed.success)
            return parsed.data;
        throw new LambderApiOutputValidationError(apiName, { zodError: parsed.error });
    }
    apiBinary(payload, config = {}, options) {
        return this.api(payload, config, { ...options, compress: true });
    }
    ;
}
;
