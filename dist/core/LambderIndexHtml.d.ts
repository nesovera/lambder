import { type LambderRenderContext } from "./LambderContext.js";
import type LambderResolver from "./LambderResolver.js";
import type { LambderResponse } from "./LambderResponse.js";
import type { LambderFallbackHandler } from "./LambderCreateOptions.js";
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
export declare class LambderIndexHtmlHandler {
    private handler;
    private options;
    private methods;
    constructor(handler: LambderFallbackHandler | null, options: LambderIndexHtmlOptions);
    /** Serve the shell, or return null to fall through. */
    handle(ctx: LambderRenderContext, resolver: LambderResolver): Promise<LambderResponse | null>;
}
