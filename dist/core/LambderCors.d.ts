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
export declare const applyCorsHeaders: (config: LambderCorsConfig | null, ctx: LambderRenderContext, response: LambderResponse, isPreflight: boolean) => void;
