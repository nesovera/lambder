/**
 * An answer's headers: the case-insensitive read, replace and append every
 * layer uses on a plain header map, and the accumulator that records what a
 * call wrote so it can be applied onto whichever answer the call ends up
 * with.
 *
 * One implementation, at the bottom of the stack, because every layer above
 * it needs the same one: LambderResponse's own header methods are these three
 * functions, and a second copy had already drifted from them.
 */
/** The header's values under a case-insensitive lookup, or undefined. */
export const getAnswerHeader = (headers, name) => {
    const lower = name.toLowerCase();
    for (const [key, values] of Object.entries(headers)) {
        if (key.toLowerCase() === lower)
            return values;
    }
    return undefined;
};
/** Replaces the header under any casing of its name. */
export const setAnswerHeader = (headers, name, value) => {
    const lower = name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === lower)
            delete headers[key];
    }
    headers[name] = Array.isArray(value) ? [...value] : [value];
};
/** Appends a value to the header, under the casing it already has if any. */
export const addAnswerHeader = (headers, name, value) => {
    const lower = name.toLowerCase();
    const existing = Object.keys(headers).find((key) => key.toLowerCase() === lower);
    if (existing)
        headers[existing].push(value);
    else
        headers[name] = [value];
};
/**
 * Response headers written while a call runs (`res.setHeader`, `res.addHeader`,
 * the session controller's Set-Cookie), applied onto the answer once the
 * call has one. Recorded as operations in call order rather than as a map,
 * so `set` replaces what the answer itself carries (a Content-Type, say) and
 * `add` appends to it, exactly as the two would if called on the answer
 * directly.
 *
 * These headers belong to the CALL, not to the response that first carried
 * them: on the server an afterRender hook may answer with a different
 * response than the handler produced, and a session cookie written during the
 * call has to travel across to it. So applying never forgets the operations,
 * and applying the same ones twice is a no-op: `set` writes the same value
 * again, and `add` skips a value the header already carries. The one thing
 * that costs is two `add` calls of the identical value under one name, which
 * collapse to one; duplicate identical header values carry no meaning in
 * HTTP, so nothing observable is lost.
 */
export class LambderAnswerHeaders {
    operations = [];
    set(key, value) {
        this.operations.push({ op: "set", key, value });
    }
    add(key, value) {
        this.operations.push({ op: "add", key, value });
    }
    /**
     * How many operations have been recorded. Also a mark: reading it before
     * a step and passing it back as `fromIndex` applies only what that step
     * wrote.
     */
    get size() { return this.operations.length; }
    /**
     * Applies the recorded operations, in order, onto anything that reads and
     * writes headers: a LambderResponse, or a header map through applyInto.
     * One definition of what an operation does, so the two targets cannot
     * drift apart.
     */
    applyTo(target, fromIndex = 0) {
        for (const operation of this.operations.slice(fromIndex)) {
            if (operation.op === "set") {
                target.setHeader(operation.key, operation.value);
            }
            else if (!target.getHeader(operation.key)?.includes(operation.value)) {
                target.addHeader(operation.key, operation.value);
            }
        }
    }
    /** The same, onto an answer's plain header map. */
    applyInto(headers, fromIndex = 0) {
        this.applyTo({
            getHeader: (key) => getAnswerHeader(headers, key),
            setHeader: (key, value) => setAnswerHeader(headers, key, value),
            addHeader: (key, value) => addAnswerHeader(headers, key, value),
        }, fromIndex);
    }
}
