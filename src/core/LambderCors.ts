import type { LambderRenderContext } from "./LambderContext.js";
import type { LambderResponse } from "./LambderResponse.js";

export type LambderCorsConfig = {
    /** "*" (default), an allowlist, or a per-request predicate, asked once per request; one that throws counts as refused. An allowed origin is echoed back. */
    origins?: "*" | string[] | ((origin: string, ctx: LambderRenderContext) => boolean);
    /**
     * Let an allowed origin make credentialed calls (cookies). Needs an
     * allowlist or a predicate in `origins`: credentials for any origin would
     * let every website read a signed-in user's answers, so create() refuses
     * the pair.
     */
    credentials?: boolean;
    methods?: string[];
    allowHeaders?: string[];
    /**
     * Response headers a cross-origin browser caller may read. Default:
     * ["Retry-After"], so rate-limit refusals stay readable (it is not on the
     * CORS safelist, and a hidden header reads as null, not as an error).
     */
    exposeHeaders?: string[];
    maxAge?: number;
};

/**
 * The Access-Control-Allow-Origin this request earns: "*", the echoed origin,
 * or null for a refused or absent one.
 *
 * Settled once per request, before anything can crash, and handed to every
 * answer the request ends in: the crash path then applies a verdict already
 * reached and runs no app code of its own. A predicate that throws counts as
 * refused and is logged. `new URL(origin)` throws on the `Origin: null` a
 * sandboxed frame or a cross-origin redirect sends, and a CORS header is no
 * reason to fail the request it decorates.
 */
export const allowedCorsOriginOf = (config: LambderCorsConfig, ctx: LambderRenderContext): string | null => {
    const origins = config.origins ?? "*";
    if(origins === "*") return "*";
    const origin = ctx.header("origin");
    if(!origin) return null;
    if(Array.isArray(origins)) return origins.includes(origin) ? origin : null;
    try {
        return origins(origin, ctx) ? origin : null;
    } catch(predicateErr){
        console.error("Lambder: cors.origins threw; the origin was refused.", predicateErr);
        return null;
    }
};

/** Mutate the response with the CORS headers the config allows, for the origin verdict allowedCorsOriginOf settled for this request. */
export const applyCorsHeaders = (
    config: LambderCorsConfig | null,
    allowedOrigin: string | null,
    response: LambderResponse,
    isPreflight: boolean,
): void => {
    if(!config) return;
    // Under an allowlist or a predicate the answer depends on Origin even when
    // this one was refused: a cache must not serve the answer to a refused or
    // absent Origin to an allowed one, which would read it as a CORS failure.
    if((config.origins ?? "*") !== "*") response.addHeader("Vary", "Origin");
    if(!allowedOrigin) return;

    response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    if(config.credentials) response.setHeader("Access-Control-Allow-Credentials", "true");
    if(isPreflight){
        response.setHeader("Access-Control-Allow-Methods", (config.methods ?? ["GET", "POST", "OPTIONS"]).join(","));
        response.setHeader("Access-Control-Allow-Headers", (config.allowHeaders ?? ["Origin", "X-Requested-With", "Content-Type", "Accept"]).join(", "));
        if(config.maxAge !== undefined) response.setHeader("Access-Control-Max-Age", String(config.maxAge));
    }else{
        const exposeHeaders = config.exposeHeaders ?? ["Retry-After"];
        if(exposeHeaders.length) response.setHeader("Access-Control-Expose-Headers", exposeHeaders.join(", "));
    }
};
