import mimeTypeResolver from "mime-types";
import { getFS, getPath } from "./node-polyfills.js";
import { LambderResponse } from "./LambderResponse.js";
import { LambderTemplatingEngine } from "./LambderTemplatingEngine.js";
// Compiled templates survive across requests (builder instances are per-request).
const templateFileCache = new Map();
export default class LambderResponseBuilder {
    publicPath;
    apiVersion;
    ctx;
    constructor({ publicPath, apiVersion, ctx }) {
        this.publicPath = publicPath;
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
    async resolvePublicFilePath(filePath) {
        const fs = await getFS();
        const path = await getPath();
        if (!fs || !path)
            return null;
        const publicPath = path.resolve(this.publicPath);
        const normalizedFilePath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
        const absolutePath = path.resolve(publicPath, normalizedFilePath);
        if (absolutePath !== publicPath && !absolutePath.startsWith(publicPath + path.sep))
            return null;
        try {
            const stat = await fs.promises.stat(absolutePath);
            return stat.isFile() ? absolutePath : null;
        }
        catch {
            return null;
        }
    }
    ;
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
            headers: init.headers ?? init.multiValueHeaders,
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
    async file(filePath, options) {
        let resolvedPath = await this.resolvePublicFilePath(filePath);
        let effectivePath = filePath;
        if (!resolvedPath && options?.fallback) {
            resolvedPath = await this.resolvePublicFilePath(options.fallback);
            effectivePath = options.fallback;
        }
        if (!resolvedPath) {
            return this.status404("File not found", { etag: false });
        }
        const fs = await getFS();
        if (!fs)
            return this.status404("File not found", { etag: false });
        const body = await fs.promises.readFile(resolvedPath);
        const mimeType = mimeTypeResolver.lookup(effectivePath) || "application/octet-stream";
        return this.buildResponse(200, mimeType, body, options);
    }
    ;
    /**
     * Render an HTML file under publicPath through LambderTemplatingEngine
     * (comment-based slots/conditionals) and return it as an HTML response.
     * The compiled template is cached across warm invocations; a missing file
     * throws (it is a server-side configuration error, not a client 404).
     * Set htmlVirtualSlots to expose "title"/"head" slots on marker-less files.
     */
    async templateFile(filePath, data, options) {
        const resolvedPath = await this.resolvePublicFilePath(filePath);
        if (!resolvedPath)
            throw new Error(`templateFile: file not found under publicPath: ${filePath}`);
        const cacheKey = `${resolvedPath}|${options?.htmlVirtualSlots ? "v" : ""}`;
        let template = templateFileCache.get(cacheKey);
        if (!template) {
            template = await LambderTemplatingEngine.fromFile(resolvedPath, { htmlVirtualSlots: options?.htmlVirtualSlots });
            templateFileCache.set(cacheKey, template);
        }
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
