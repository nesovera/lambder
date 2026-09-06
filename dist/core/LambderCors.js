/** Mutate the response with the CORS headers the config allows for this request. */
export const applyCorsHeaders = (config, ctx, response, isPreflight) => {
    if (!config)
        return;
    const origin = ctx.header("origin") ?? "";
    const origins = config.origins ?? "*";
    let allowOrigin = null;
    if (origins === "*") {
        allowOrigin = config.credentials ? (origin || null) : "*";
    }
    else if (Array.isArray(origins)) {
        allowOrigin = origin && origins.includes(origin) ? origin : null;
    }
    else {
        allowOrigin = origin && origins(origin, ctx) ? origin : null;
    }
    if (!allowOrigin)
        return;
    response.setHeader("Access-Control-Allow-Origin", allowOrigin);
    if (allowOrigin !== "*")
        response.addHeader("Vary", "Origin");
    if (config.credentials)
        response.setHeader("Access-Control-Allow-Credentials", "true");
    if (isPreflight) {
        response.setHeader("Access-Control-Allow-Methods", (config.methods ?? ["GET", "POST", "OPTIONS"]).join(","));
        response.setHeader("Access-Control-Allow-Headers", (config.allowHeaders ?? ["Origin", "X-Requested-With", "Content-Type", "Accept"]).join(", "));
        if (config.maxAge !== undefined)
            response.setHeader("Access-Control-Max-Age", String(config.maxAge));
    }
};
