/**
 * Whether a value survives JSON unchanged, and so can be written into a
 * generated module as the data it is: strings, finite numbers, booleans,
 * null, and arrays and plain objects of them. Anything else (a function, a
 * class instance such as a zod schema, a symbol, a bigint, NaN, undefined
 * inside a container) is code or a shape JSON would silently rewrite, and
 * the caller is told where it sits.
 */
export declare const assertPlainData: (value: unknown, subject: string) => void;
