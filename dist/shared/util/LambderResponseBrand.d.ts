/**
 * Marks an object as a response without anyone having to import the class to
 * ask. Layers that must recognise one but must not depend on core at runtime
 * (the guards engine, which runs in the browser too) test for this key.
 * Symbol.for keeps it true across realms and across duplicate copies of the
 * package. Defined here, in shared, so the class that carries the brand and
 * the engine that checks for it import the one constant: a hand-typed copy
 * of the symbol's name would keep compiling after a rename while the runtime
 * check silently stopped matching.
 */
export declare const LAMBDER_RESPONSE_BRAND: unique symbol;
/**
 * Whether a value carries the response brand. Tested by brand rather than by
 * `instanceof`, so a browser-side engine stays free of a runtime dependency
 * on core and keeps working across realms and duplicate copies of the
 * package.
 */
export declare const isLambderResponseLike: (value: unknown) => value is {
    readonly [LAMBDER_RESPONSE_BRAND]: true;
};
