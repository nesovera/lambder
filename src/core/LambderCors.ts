import type { LambderRenderContext } from "./LambderContext.js";
import type { LambderResponse } from "./LambderResponse.js";

export type LambderCorsConfig = {
    /** "*" (default), an allowlist, or a per-request predicate. With credentials, the origin is echoed (never "*"). */
    origins?: "*" | string[] | ((origin: string, ctx: LambderRenderContext) => boolean);
    credentials?: boolean;
    methods?: string[];
    allowHeaders?: string[];
    maxAge?: number;
};

/** Mutate the response with the CORS headers the config allows for this request. */
export const applyCorsHeaders = (
    config: LambderCorsConfig | null,
    ctx: LambderRenderContext,
    response: LambderResponse,
    isPreflight: boolean,
): void => {
    if(!config) return;
    const origin = ctx.header("origin") ?? "";
    const origins = config.origins ?? "*";

    let allowOrigin: string | null = null;
    if(origins === "*"){
        allowOrigin = config.credentials ? (origin || null) : "*";
    }else if(Array.isArray(origins)){
        allowOrigin = origin && origins.includes(origin) ? origin : null;
    }else{
        allowOrigin = origin && origins(origin, ctx) ? origin : null;
    }
    if(!allowOrigin) return;

    response.setHeader("Access-Control-Allow-Origin", allowOrigin);
    if(allowOrigin !== "*") response.addHeader("Vary", "Origin");
    if(config.credentials) response.setHeader("Access-Control-Allow-Credentials", "true");
    if(isPreflight){
        response.setHeader("Access-Control-Allow-Methods", (config.methods ?? ["GET", "POST", "OPTIONS"]).join(","));
        response.setHeader("Access-Control-Allow-Headers", (config.allowHeaders ?? ["Origin", "X-Requested-With", "Content-Type", "Accept"]).join(", "));
        if(config.maxAge !== undefined) response.setHeader("Access-Control-Max-Age", String(config.maxAge));
    }
};
