import type { LambderRenderContext } from "./LambderContext.js";
type Path = `/${string}`;
type CutAt<S extends string, D extends string> = S extends `${infer Head}${D}${string}` ? Head : S;
type ParamNameFrom<S extends string> = CutAt<CutAt<CutAt<CutAt<CutAt<CutAt<CutAt<S, "/">, ".">, "(">, "?">, "+">, "*">, "-">;
type PathParamNames<T extends string> = T extends `${string}:${infer Rest}` ? (ParamNameFrom<Rest> extends "" ? never : ParamNameFrom<Rest>) | PathParamNames<Rest> : never;
export type PathParamsOf<T extends string> = string extends T ? Record<string, string> : T extends `${string}(${string}` ? Record<string, string> : [PathParamNames<T>] extends [never] ? Record<string, string> : {
    [K in PathParamNames<T>]: string;
};
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
/** Compile a route condition once at registration time. */
export declare const compileRouteMatcher: (condition: RouteCondition) => CompiledMatcher;
export {};
