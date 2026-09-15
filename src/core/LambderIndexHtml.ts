import { isV2HttpEvent, type LambderRenderContext } from "./LambderContext.js";
import type LambderResolver from "./LambderResolver.js";
import type { LambderResponse } from "./LambderResponse.js";
import type { LambderFallbackHandler } from "./LambderCreateOptions.js";
import { allowsRequestMethod } from "./LambderRouting.js";

/*
 * The app-shell layer of the fallback chain: what serveIndexHtml registers.
 *
 * Its own module beside LambderPublicFiles, which is the layer before it: the
 * two are the same kind of thing (a terminal handler with its own per-
 * registration options), and the index-HTML one lived inside the class as a
 * method plus a config field plus two file-local helpers.
 */

export type LambderIndexHtmlOptions = {
    /** Methods that reach the index handler. Default: ["GET", "HEAD"]; a list that names GET and not HEAD accepts HEAD too, as a route matcher's `method` does. */
    methods?: string[];
    /**
     * Skip paths whose last segment contains a dot, treating them as missing
     * assets rather than app routes. Default: false, because real files have already
     * been served by servePublicFiles at this point, and plenty of app routes
     * carry dots (JWTs, coordinates, domain names, version numbers). Turn it
     * on to get 404s instead of a 200 shell for missing-asset requests.
     */
    skipFilePaths?: boolean;
    /** 301-redirect trailing-slash paths to the canonical no-slash URL. Default: false. */
    redirectTrailingSlash?: boolean;
    /** Shell served by the default handler. Default: "index.html". */
    indexFile?: string | ((ctx: LambderRenderContext) => string);
    /** Compression override, like servePublicFiles: "auto" (default), true/false, or (ctx) => boolean | "auto". */
    compress?: boolean | "auto" | ((ctx: LambderRenderContext) => boolean | "auto");
};

/**
 * Serves the app shell for page requests that nothing else handled,
 * registered via lambder.serveIndexHtml(). Runs after servePublicFiles in the
 * fallback chain, so real files are already gone and everything left is an
 * app route. A request the gates exclude (a method that is not configured, a
 * dotted path under skipFilePaths) falls through to the route fallback.
 */
export class LambderIndexHtmlHandler {
    private handler: LambderFallbackHandler | null;
    private options: LambderIndexHtmlOptions;
    private methods: ReadonlySet<string>;

    constructor(handler: LambderFallbackHandler | null, options: LambderIndexHtmlOptions){
        this.handler = handler;
        this.options = options;
        this.methods = new Set((options.methods ?? ["GET", "HEAD"]).map((method) => method.toUpperCase()));
    }

    /** Serve the shell, or return null to fall through. */
    async handle(ctx: LambderRenderContext, resolver: LambderResolver): Promise<LambderResponse | null> {
        const { handler, options } = this;

        if(!allowsRequestMethod(this.methods, ctx.method)) return null;

        if((options.skipFilePaths ?? false) && (ctx.path.split("/").pop() ?? "").includes(".")) return null;

        if(options.redirectTrailingSlash && ctx.path.length > 1 && ctx.path.endsWith("/")){
            const target = sameOriginRedirectTarget(ctx.path);
            if(target !== null) return resolver.redirect(target + buildQueryString(ctx), 301);
        }

        const response = handler
            ? await handler(ctx, resolver)
            : await resolver.templateFile(
                typeof options.indexFile === "function" ? options.indexFile(ctx) : (options.indexFile ?? "index.html"),
                {},
                { cacheControl: "no-cache" },
            );
        if(options.compress !== undefined){
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
const sameOriginRedirectTarget = (path: string): string | null => {
    const target = path.replace(/^[/\\]+/, "/").replace(/[/\\]+$/, "") || "/";
    if(target.startsWith("//") || target.startsWith("/\\")) return null;
    return target;
};

/**
 * Rebuild the query string from the API Gateway event for redirects.
 *
 * From the raw event rather than from ctx.get, which has flattened repeated
 * keys to one value each and lost the order they arrived in; a redirect has
 * to hand back the query it was given.
 */
const buildQueryString = (ctx: LambderRenderContext): string => {
    if(isV2HttpEvent(ctx.event)){
        return ctx.event.rawQueryString ? `?${ctx.event.rawQueryString}` : "";
    }
    const multi = ctx.event.multiValueQueryStringParameters;
    const single = ctx.event.queryStringParameters;
    const params = new URLSearchParams();
    if(multi){
        for(const [key, values] of Object.entries(multi)){
            for(const value of values ?? []) params.append(key, value);
        }
    }else if(single){
        for(const [key, value] of Object.entries(single)){
            if(value !== undefined) params.append(key, value);
        }
    }
    const queryString = params.toString();
    return queryString ? `?${queryString}` : "";
};
