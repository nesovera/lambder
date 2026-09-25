import type { LambderRenderContext } from "./LambderContext.js";
/** A route path as an app writes it: absolute, so a matcher and the index-HTML layer agree on the shape. */
export type LambderRoutePath = `/${string}`;
type CutAt<S extends string, D extends string> = S extends `${infer Head}${D}${string}` ? Head : S;
type ParamNameFrom<S extends string> = CutAt<CutAt<CutAt<CutAt<CutAt<CutAt<CutAt<S, "/">, ".">, "(">, "?">, "+">, "*">, "-">;
type PathParamNames<T extends string> = T extends `${string}:${infer Rest}` ? (ParamNameFrom<Rest> extends "" ? never : ParamNameFrom<Rest>) | PathParamNames<Rest> : never;
export type LambderPathParamsOf<T extends string> = string extends T ? Record<string, string> : T extends `${string}(${string}` ? Record<string, string> : [PathParamNames<T>] extends [never] ? Record<string, string> : {
    [K in PathParamNames<T>]: string;
};
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
/**
 * Whether a request method is one the slot accepts, with HEAD folded into GET
 * unless the list names HEAD itself: a HEAD is a GET whose body finalization
 * strips, so an app that narrowed a slot to ["GET"] did not mean to 404 it.
 *
 * A route matcher's `method`, servePublicFiles and serveIndexHtml all use
 * this rule, so neighbouring slots cannot disagree about what a method means.
 */
export declare const allowsRequestMethod: (methods: ReadonlySet<string>, requestMethod: string) => boolean;
/** Compile a route condition once at registration time. */
export declare const compileRouteMatcher: (condition: LambderRouteCondition) => CompiledMatcher;
export {};
