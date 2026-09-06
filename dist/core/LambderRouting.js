import { match as pathToRegexpMatch } from "path-to-regexp";
const compilePathMatcher = (path) => {
    if (typeof path === "string") {
        const matchFn = pathToRegexpMatch(path, { decode: decodeURIComponent });
        return (requestPath) => {
            const result = matchFn(requestPath);
            if (!result)
                return false;
            const params = {};
            for (const [key, value] of Object.entries(result.params ?? {})) {
                params[key] = Array.isArray(value) ? value.join("/") : String(value);
            }
            return params;
        };
    }
    return (requestPath) => {
        const matched = requestPath.match(path);
        if (!matched)
            return false;
        if (matched.groups)
            return { ...matched.groups };
        const params = {};
        matched.forEach((value, index) => {
            if (value !== undefined)
                params[String(index)] = value;
        });
        return params;
    };
};
/** Compile a route condition once at registration time. */
export const compileRouteMatcher = (condition) => {
    if (typeof condition === "string" || condition instanceof RegExp) {
        const pathMatcher = compilePathMatcher(condition);
        return (ctx) => pathMatcher(ctx.path);
    }
    if (typeof condition === "function") {
        return (ctx) => condition(ctx) ? {} : false;
    }
    const matcher = condition;
    const pathMatcher = matcher.path !== undefined ? compilePathMatcher(matcher.path) : null;
    const methods = matcher.method !== undefined
        ? new Set((Array.isArray(matcher.method) ? matcher.method : [matcher.method]).map((m) => m.toUpperCase()))
        : null;
    return (ctx) => {
        if (methods) {
            let requestMethod = ctx.method.toUpperCase();
            if (requestMethod === "HEAD" && !methods.has("HEAD"))
                requestMethod = "GET";
            if (!methods.has(requestMethod))
                return false;
        }
        if (matcher.host !== undefined) {
            if (typeof matcher.host === "string") {
                if (ctx.host.toLowerCase() !== matcher.host.toLowerCase())
                    return false;
            }
            else if (!matcher.host.test(ctx.host)) {
                return false;
            }
        }
        if (matcher.condition && !matcher.condition(ctx))
            return false;
        if (pathMatcher)
            return pathMatcher(ctx.path);
        return {};
    };
};
