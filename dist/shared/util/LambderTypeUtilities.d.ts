/**
 * The small type utilities more than one module needs.
 *
 * Nothing here is Lambder's own vocabulary: these are the shapes TypeScript
 * does not ship, written once because the alternative is the same three
 * lines in every module that wants them, drifting in name and in meaning.
 */
/**
 * A value a caller may hand back either synchronously or as a promise. Every
 * handler, hook and callback Lambder takes is declared over this: an app
 * writes the synchronous form when it has nothing to await, and the framework
 * awaits either.
 */
export type MaybePromise<T> = T | Promise<T>;
/**
 * A declaration map with AT LEAST ONE entry: the union, over every declarable
 * name, of "this one required and the rest optional".
 *
 * An all-optional map is inhabited by `{}`, which would let `guards: {}`
 * satisfy requireSessionApiGuards / requirePublicApiGuards at the type level
 * while declaring no guard at all: the option is present, so the required-field
 * check passes, and it normalizes to zero entries, so nothing runs. Requiring
 * the chosen key also rejects `{ theGuard: undefined }`, which an optional
 * property accepts and which would otherwise reach the guard's handler with an
 * undefined param.
 *
 * Option-neutral, and the rate-limit option's map form is built with the same
 * type: the two had drifted, and `rateLimit: {}` compiled while `guards: {}`
 * did not.
 */
export type LambderNonEmptyOptionMap<TMap> = {
    [K in keyof TMap]-?: Required<Pick<TMap, K>> & Omit<TMap, K>;
}[keyof TMap];
