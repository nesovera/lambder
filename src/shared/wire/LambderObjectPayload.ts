/**
 * Whether a value is what an API answers with or a refusal carries as data:
 * an array, or an object that goes through JSON as an object. A Date or a
 * class with a toJSON of its own is written as whatever toJSON returns (a
 * string, for a Date), so it does not count.
 *
 * The rule is what makes `caller.api()` truthy exactly on success: an
 * answer is never null, false, 0 or "", so a falsy result can only mean the
 * call failed. The server checks a handler's parsed output with it, and a
 * reader checks what it received, so a body no Lambder handler wrote (a
 * hand-built one, a proxy's) cannot pass for a success.
 */
export const isObjectPayload = (value: unknown): value is object =>
    Array.isArray(value)
    || (value !== null && typeof value === "object" && typeof (value as { toJSON?: unknown }).toJSON !== "function");

/** What a value that is not an object payload is, for an error message: its kind, never the value itself. */
export const describePayloadKind = (value: unknown): string => {
    if(value === null) return "null";
    if(value === undefined) return "nothing";
    if(typeof value === "object") return "an object that JSON writes as something else (a Date, or a class with a toJSON of its own)";
    return `a ${typeof value}`;
};
