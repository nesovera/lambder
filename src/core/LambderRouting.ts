import { match as pathToRegexpMatch } from "path-to-regexp";
import type { LambderRenderContext } from "./LambderContext.js";

type Path = `/${string}`;

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
export type PathParamsOf<T extends string> =
    string extends T ? Record<string, string>
    : T extends `${string}(${string}` ? Record<string, string>
    : [PathParamNames<T>] extends [never] ? Record<string, string>
    : { [K in PathParamNames<T>]: string };

// ---------------------------------------------------------------------------
// Route conditions
// ---------------------------------------------------------------------------
export type ConditionFunction = (ctx: LambderRenderContext) => boolean;

/** Structured route matcher: all provided fields must match. */
export type LambderRouteMatcher = {
    path?: Path | RegExp;
    host?: string | RegExp;
    /** One or more HTTP methods; HEAD requests also match GET routes. */
    method?: string | string[];
    condition?: ConditionFunction;
};

export type RouteCondition = Path | RegExp | ConditionFunction | LambderRouteMatcher;

/** Returns matched path params, or false when the route doesn't match. */
export type CompiledMatcher = (ctx: LambderRenderContext) => false | Record<string, string>;

const compilePathMatcher = (path: Path | RegExp): (requestPath: string) => false | Record<string, string> => {
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

/** Compile a route condition once at registration time. */
export const compileRouteMatcher = (condition: RouteCondition): CompiledMatcher => {
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
        if(methods){
            let requestMethod = ctx.method.toUpperCase();
            if(requestMethod === "HEAD" && !methods.has("HEAD")) requestMethod = "GET";
            if(!methods.has(requestMethod)) return false;
        }
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
