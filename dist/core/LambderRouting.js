import { match as pathToRegexpMatch } from "path-to-regexp";
import { decodePathParam } from "./LambderRequestPath.js";
const compilePathMatcher = (path) => {
    if (typeof path === "string") {
        // ctx.path is already decoded, so decoding a param again would read a
        // literal "%41" as "A". decodePathParam only turns the two escapes
        // ctx.path keeps back into "/" and "%". The slash is the only delimiter:
        // a decoded path carries "#" and "?" as text ("/tags/C%23" is the tag
        // "C#"), and path-to-regexp's default would end a param at them.
        // Case-sensitive, as API Gateway routes and CloudFront behaviors are:
        // matched without case, `/ADMIN/users` would miss an authorizer on
        // `/admin/*` in front of the function and still reach "/admin/:x".
        const matchFn = pathToRegexpMatch(path, { decode: decodePathParam, delimiter: "/", sensitive: true });
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
    // A RegExp matches ctx.path as written, its kept %2F and %25 included;
    // what it captures is handed over turned back, as a string route's params are.
    return (requestPath) => {
        const matched = requestPath.match(path);
        if (!matched)
            return false;
        const params = {};
        if (matched.groups) {
            for (const [key, value] of Object.entries(matched.groups)) {
                if (value !== undefined)
                    params[key] = decodePathParam(value);
            }
            return params;
        }
        matched.forEach((value, index) => {
            if (value !== undefined)
                params[String(index)] = decodePathParam(value);
        });
        return params;
    };
};
/**
 * Whether a request method is one the slot accepts, with HEAD folded into GET
 * unless the list names HEAD itself: a HEAD is a GET whose body finalization
 * strips, so an app that narrowed a slot to ["GET"] did not mean to 404 it.
 *
 * A route matcher's `method`, servePublicFiles and serveIndexHtml all use
 * this rule, so neighbouring slots cannot disagree about what a method means.
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
