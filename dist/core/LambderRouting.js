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
/**
 * Whether a request method is one the slot accepts, with HEAD folded into GET
 * unless the list names HEAD itself: a HEAD is a GET whose body finalization
 * strips, so an app that narrowed a slot to ["GET"] did not mean to 404 it.
 *
 * The three places that gate on a method (a route matcher's `method`,
 * servePublicFiles and serveIndexHtml) share this one rule, so neighbouring
 * slots cannot disagree about what a method means.
 */
export const allowsRequestMethod = (methods, requestMethod) => {
    const method = requestMethod.toUpperCase();
    if (methods.has(method))
        return true;
    return method === "HEAD" && methods.has("GET");
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
        if (methods && !allowsRequestMethod(methods, ctx.method))
            return false;
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
