/**
 * The small type utilities more than one module needs.
 *
 * Nothing here is Lambder's own vocabulary: these are shapes TypeScript does
 * not ship, written once so they cannot drift in name or meaning across the
 * modules that use them.
 */

/**
 * A value a caller may hand back either synchronously or as a promise. Every
 * handler, hook and callback Lambder takes is declared over this: an app
 * writes the synchronous form when it has nothing to await, and the framework
 * awaits either.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * T with every object and array readonly, all the way down: what an API
 * handler's returned answer is checked against.
 *
 * An answer is a return value, and TypeScript widens the literals of a
 * return value whose expected type is still generic (`{ kind: "a" }` reads
 * as `{ kind: string }`), where a call argument keeps them. The handler's
 * return is therefore its own `const` type parameter, which keeps literals;
 * `const` also makes array literals readonly, which a schema's mutable arrays
 * would refuse, so the bound is this readonly view of the output. Nothing
 * writes to an answer (it is parsed and sent), so readonly costs nothing.
 * Functions and Dates pass through whole. Eight levels deep and no further,
 * because an output may be recursive (`z.json()`), and past that depth the
 * type is left as it is.
 */
export type LambderReadonlyDeep<T, TDepth extends unknown[] = []> =
    TDepth["length"] extends 8 ? T
    : T extends (...args: never[]) => unknown ? T
    : T extends Date ? T
    : T extends object ? { readonly [K in keyof T]: LambderReadonlyDeep<T[K], [...TDepth, unknown]> }
    : T;

/**
 * A declaration map with AT LEAST ONE entry: the union, over every declarable
 * name, of "this one required and the rest optional".
 *
 * An all-optional map is inhabited by `{}`, which would let `guards: {}`
 * satisfy requireSessionApiGuards / requirePublicApiGuards at the type level
 * while declaring no guard: the option is present, so the required-field
 * check passes, and it normalizes to zero entries, so nothing runs. Requiring
 * the chosen key also rejects `{ theGuard: undefined }`, which an optional
 * property accepts and which would reach the guard's handler with an
 * undefined param.
 *
 * Option-neutral: the rate-limit option's map form uses it too, so
 * `rateLimit: {}` and `guards: {}` are refused alike.
 */
export type LambderNonEmptyOptionMap<TMap> = {
    [K in keyof TMap]-?: Required<Pick<TMap, K>> & Omit<TMap, K>
}[keyof TMap];

/**
 * Rejects a key the options type does not have, which `const TOptions` would
 * otherwise wave through: inferring a generic from an object literal switches
 * excess-property checking off for the whole literal, so
 * `requireSessionApiGuard` (no trailing "s") or `maxResponseByte` would
 * compile, be dropped in silence, and leave the app on the default. That is
 * worst for the two require*ApiGuards flags, which exist to make a missing
 * authorization declaration a compile error. Mapping every surplus key to
 * `never` puts the error back on the key itself.
 */
export type LambderNoExtraKeys<TOptions, TShape> = TOptions & Record<Exclude<keyof TOptions, keyof TShape>, never>;
