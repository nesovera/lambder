import { match as pathToRegexpMatch } from "path-to-regexp";
import type { LambderRenderContext } from "./LambderContext.js";

/** A route path as an app writes it: absolute, so a matcher and the index-HTML layer agree on the shape. */
export type LambderRoutePath = `/${string}`;

// ---------------------------------------------------------------------------
// Typed path params: infer `:param` names from string patterns.
// Patterns containing regex groups fall back to Record<string, string>.
// ---------------------------------------------------------------------------
type CutAt<S extends string, D extends string> = S extends `${infer Head}${D}${string}` ? Head : S;
type ParamNameFrom<S extends string> =
    CutAt<CutAt<CutAt<CutAt<CutAt<CutAt<CutAt<S, "/">, ".">, "(">, "?">, "+">, "*">, "-">;
type PathParamNames<T extends string> =
    T extends `${string}:${infer Rest}`
        ? (ParamNameFrom<Rest> extends "" ? never : ParamNameFrom<Rest>) | PathParamNames<Rest>
        : never;
export type LambderPathParamsOf<T extends string> =
    string extends T ? Record<string, string>
    : T extends `${string}(${string}` ? Record<string, string>
    : [PathParamNames<T>] extends [never] ? Record<string, string>
    : { [K in PathParamNames<T>]: string };

// ---------------------------------------------------------------------------
// Route conditions
// ---------------------------------------------------------------------------
export type LambderRouteConditionFn = (ctx: LambderRenderContext) => boolean;

/** Structured route matcher: all provided fields must match. */
export type LambderRouteMatcher = {
    path?: LambderRoutePath | RegExp;
    host?: string | RegExp;
    /** One or more HTTP methods; HEAD requests also match GET routes. */
    method?: string | string[];
    condition?: LambderRouteConditionFn;
};

export type LambderRouteCondition = LambderRoutePath | RegExp | LambderRouteConditionFn | LambderRouteMatcher;

/** Returns matched path params, or false when the route doesn't match. */
export type CompiledMatcher = (ctx: LambderRenderContext) => false | Record<string, string>;

const compilePathMatcher = (path: LambderRoutePath | RegExp): (requestPath: string) => false | Record<string, string> => {
    if(typeof path === "string"){
        const matchFn = pathToRegexpMatch(path, { decode: decodeURIComponent });
        return (requestPath: string) => {
            const result = matchFn(requestPath);
            if(!result) return false;
            const params: Record<string, string> = {};
            for(const [key, value] of Object.entries(result.params ?? {})){
                params[key] = Array.isArray(value) ? value.join("/") : String(value);
            }
            return params;
        };
    }
    return (requestPath: string) => {
        const matched = requestPath.match(path);
        if(!matched) return false;
        if(matched.groups) return { ...matched.groups };
        const params: Record<string, string> = {};
        matched.forEach((value, index) => {
            if(value !== undefined) params[String(index)] = value;
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
export const allowsRequestMethod = (methods: ReadonlySet<string>, requestMethod: string): boolean => {
    const method = requestMethod.toUpperCase();
    if(methods.has(method)) return true;
    return method === "HEAD" && methods.has("GET");
};

/** Compile a route condition once at registration time. */
export const compileRouteMatcher = (condition: LambderRouteCondition): CompiledMatcher => {
    if(typeof condition === "string" || condition instanceof RegExp){
        const pathMatcher = compilePathMatcher(condition);
        return (ctx) => pathMatcher(ctx.path);
    }
    if(typeof condition === "function"){
        return (ctx) => condition(ctx) ? {} : false;
    }

    const matcher = condition;
    const pathMatcher = matcher.path !== undefined ? compilePathMatcher(matcher.path) : null;
    const methods = matcher.method !== undefined
        ? new Set((Array.isArray(matcher.method) ? matcher.method : [matcher.method]).map((m) => m.toUpperCase()))
        : null;
    return (ctx) => {
        if(methods && !allowsRequestMethod(methods, ctx.method)) return false;
        if(matcher.host !== undefined){
            if(typeof matcher.host === "string"){
                if(ctx.host.toLowerCase() !== matcher.host.toLowerCase()) return false;
            }else if(!matcher.host.test(ctx.host)){
                return false;
            }
        }
        if(matcher.condition && !matcher.condition(ctx)) return false;
        if(pathMatcher) return pathMatcher(ctx.path);
        return {};
    };
};
