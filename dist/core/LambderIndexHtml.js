import { isV2HttpEvent } from "./LambderContext.js";
import { allowsRequestMethod } from "./LambderRouting.js";
import { encodePathForLocation } from "./LambderRequestPath.js";
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
                return resolver.redirect(encodePathForLocation(target) + buildQueryString(ctx), 301);
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
 * navigates to that host, and browsers normalize backslashes into slashes, so
 * `/\evil.example` is the same thing. The header is built from the request
 * path, which the caller writes, so without this `GET //evil.example/` would
 * make redirectTrailingSlash an open redirect. The leading run of slashes and
 * backslashes collapses to one slash, and the result is then checked rather
 * than assumed, since the header's safety rests on that check. The caller
 * then percent-encodes it (encodePathForLocation), so a TAB or line break,
 * which a browser drops, cannot make a second slash out of it.
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
 * From the raw event rather than ctx.get, which keeps one value per key and
 * loses their order; a redirect has to hand back the query it was given.
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
