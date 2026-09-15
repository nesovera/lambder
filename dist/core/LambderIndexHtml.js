import { isV2HttpEvent } from "./LambderContext.js";
import { allowsRequestMethod } from "./LambderRouting.js";
/**
 * Serves the app shell for page requests that nothing else handled,
 * registered via lambder.serveIndexHtml(). Runs after servePublicFiles in the
 * fallback chain, so real files are already gone and everything left is an
 * app route. A request the gates exclude (a method that is not configured, a
 * dotted path under skipFilePaths) falls through to the route fallback.
 */
export class LambderIndexHtmlHandler {
    handler;
    options;
    methods;
    constructor(handler, options) {
        this.handler = handler;
        this.options = options;
        this.methods = new Set((options.methods ?? ["GET", "HEAD"]).map((method) => method.toUpperCase()));
    }
    /** Serve the shell, or return null to fall through. */
    async handle(ctx, resolver) {
        const { handler, options } = this;
        if (!allowsRequestMethod(this.methods, ctx.method))
            return null;
        if ((options.skipFilePaths ?? false) && (ctx.path.split("/").pop() ?? "").includes("."))
            return null;
        if (options.redirectTrailingSlash && ctx.path.length > 1 && ctx.path.endsWith("/")) {
            const target = sameOriginRedirectTarget(ctx.path);
            if (target !== null)
                return resolver.redirect(target + buildQueryString(ctx), 301);
        }
        const response = handler
            ? await handler(ctx, resolver)
            : await resolver.templateFile(typeof options.indexFile === "function" ? options.indexFile(ctx) : (options.indexFile ?? "index.html"), {}, { cacheControl: "no-cache" });
        if (options.compress !== undefined) {
            response.compress = typeof options.compress === "function" ? options.compress(ctx) : options.compress;
        }
        return response;
    }
}
/**
 * The canonical no-trailing-slash form of a request path, as a Location that
 * cannot leave this origin, or null when no such form exists.
 *
 * `Location: //evil.example` is a protocol-relative URL, so a browser
 * navigates to that host; every browser normalizes backslashes into slashes
 * first, so `/\evil.example` is the same thing. This header is built from the
 * request path, which the caller writes, so redirectTrailingSlash was an open
 * redirect for anyone who asked for `GET //evil.example/`. The leading run of
 * slashes and backslashes collapses to the single slash a path may have, and
 * the result is then checked rather than assumed: the check is what the
 * header's safety rests on, and it costs one comparison.
 */
const sameOriginRedirectTarget = (path) => {
    const target = path.replace(/^[/\\]+/, "/").replace(/[/\\]+$/, "") || "/";
    if (target.startsWith("//") || target.startsWith("/\\"))
        return null;
    return target;
};
/**
 * Rebuild the query string from the API Gateway event for redirects.
 *
 * From the raw event rather than from ctx.get, which has flattened repeated
 * keys to one value each and lost the order they arrived in; a redirect has
 * to hand back the query it was given.
 */
const buildQueryString = (ctx) => {
    if (isV2HttpEvent(ctx.event)) {
        return ctx.event.rawQueryString ? `?${ctx.event.rawQueryString}` : "";
    }
    const multi = ctx.event.multiValueQueryStringParameters;
    const single = ctx.event.queryStringParameters;
    const params = new URLSearchParams();
    if (multi) {
        for (const [key, values] of Object.entries(multi)) {
            for (const value of values ?? [])
                params.append(key, value);
        }
    }
    else if (single) {
        for (const [key, value] of Object.entries(single)) {
            if (value !== undefined)
                params.append(key, value);
        }
    }
    const queryString = params.toString();
    return queryString ? `?${queryString}` : "";
};
