/**
 * Whether a value survives JSON unchanged, and so can be written into a
 * generated module as the data it is: strings, finite numbers, booleans,
 * null, and arrays and plain objects of them. Anything else (a function, a
 * class instance such as a zod schema, a symbol, a bigint, NaN, undefined
 * inside a container) is code or a shape JSON would silently rewrite, and
 * the caller is told where it sits.
 */
export const assertPlainData = (value, subject) => {
    const offence = findNonPlain(value, "");
    if (offence === null)
        return;
    throw new Error(`Lambder: ${subject} must be plain data (strings, finite numbers, booleans, null, and arrays and plain objects of them) to be written as a value, but ${offence.path || "it"} is ${offence.kind}.`);
};
const findNonPlain = (value, path) => {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return null;
    if (typeof value === "number")
        return Number.isFinite(value) ? null : { path, kind: String(value) };
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            const offence = findNonPlain(value[index], `${path}[${index}]`);
            if (offence)
                return offence;
        }
        return null;
    }
    if (typeof value === "object") {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            return { path, kind: `an instance of ${value.constructor?.name || "a class"}` };
        }
        for (const [key, member] of Object.entries(value)) {
            const offence = findNonPlain(member, path ? `${path}.${key}` : key);
            if (offence)
                return offence;
        }
        return null;
    }
    return { path, kind: typeof value === "function" ? "a function" : `a ${typeof value}` };
};
