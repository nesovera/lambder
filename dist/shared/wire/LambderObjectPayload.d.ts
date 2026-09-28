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
export declare const isObjectPayload: (value: unknown) => value is object;
/** What a value that is not an object payload is, for an error message: its kind, never the value itself. */
export declare const describePayloadKind: (value: unknown) => string;
