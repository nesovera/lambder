import { parsePreflightSlice } from "./LambderApiValidationRefusal.js";
import { LAMBDER_RESPONSE_BRAND, isLambderResponseLike } from "../shared/util/LambderResponseBrand.js";
/**
 * A guard builder bound to a pair of context types. The server's
 * lambderGuard() is this bound to the render contexts; the mock runtime
 * binds it to its own handler contexts, so mock guards are the same shape
 * as server guards and run through the same engine.
 */
export const lambderGuardBuilder = () => ((guard) => guard);
/** Normalize the three guards-option forms into ordered { name, param } entries. Internal to the engine: nothing outside it reads a guards option. */
const toGuardEntries = (value) => {
    if (value === undefined)
        return [];
    if (typeof value === "string")
        return [{ name: value, param: undefined }];
    if (Array.isArray(value))
        return value.map((name) => ({ name: String(name), param: undefined }));
    // Object form: insertion order, params passed verbatim (paramless guards
    // are declared with `true` and their handlers take no param argument).
    return Object.entries(value).map(([name, param]) => ({ name, param }));
};
/**
 * One guard's input out of the map the client posted. The map is client
 * data, so it is read as data: a guard named for something Object.prototype
 * carries ("toString", "constructor") must come back absent when the client
 * sent nothing, not as the inherited function. Guard names are deliberately
 * unrestricted, which is what makes this the read's problem rather than the
 * name's.
 */
const readGuardInput = (guardInputs, name) => guardInputs !== undefined && Object.prototype.hasOwnProperty.call(guardInputs, name) ? guardInputs[name] : undefined;
/**
 * Runtime side of the guards subsystem: holds the defined guards, asserts
 * API registrations against them at startup, and executes an API's declared
 * guards during preflight. Composed into LambderApiPolicyEngine. Reads the
 * request and writes the call context, so it runs unchanged under the
 * server and the mock runtime.
 */
export class LambderApiGuardsEngine {
    // A Map, not an object: a plain object answers for "toString" and
    // "constructor" through its prototype, so an API declaring one of those as
    // a guard name would pass the registration check that exists to catch
    // exactly that typo, and then fail on every request. It also refuses to
    // register a guard legitimately named one of them.
    guards = new Map();
    /** True once a guards map was configured. */
    get isConfigured() { return this.guards.size > 0; }
    /** Take the guards map given at creation; named like the other two engines' configure(). */
    configure(guards) {
        // One configuration per instance, the rule the rate-limit and
        // idempotency engines already hold to: a second map would silently
        // merge into the first, and which of two same-named guards ran would
        // depend on the order the calls happened to be made in.
        if (this.guards.size > 0)
            throw new Error("Lambder: guards were already configured.");
        // Declaring the option is always declaring a guard, the same rule an
        // API's own `guards: {}` is held to. Without this the engine stays
        // unconfigured and every API that declares a guard is told that no
        // guards option was given at all, which sends the reader to the wrong
        // line.
        if (Object.keys(guards).length === 0) {
            throw new Error("Lambder: the guards option was declared with no guards in it, which configures nothing. Name the guards APIs will declare, or leave the option off.");
        }
        for (const [name, guardDef] of Object.entries(guards)) {
            if (this.guards.has(name))
                throw new Error(`Lambder: guard "${name}" is already defined.`);
            if (typeof guardDef?.handler !== "function")
                throw new Error(`Lambder: guard "${name}" has no handler function.`);
            if (guardDef.apiInput && guardDef.guardInput)
                throw new Error(`Lambder: guard "${name}" declares both apiInput and guardInput; pick one.`);
            this.guards.set(name, guardDef);
        }
    }
    /** Startup validation of one API registration's guards option. */
    assertRegistration(apiName, mode, guardsOption) {
        const entries = toGuardEntries(guardsOption);
        // The runtime half of LambderNonEmptyGuardsMap. `guards: {}` and
        // `guards: []` are present-but-empty: they satisfy the require*ApiGuards
        // field check while running nothing, which is the one shape that turns a
        // mandatory authorization declaration back into an optional one. The type
        // rejects both; a plain-JS caller, a cast, or a spread that happened to
        // produce an empty object lands here instead.
        if (guardsOption !== undefined && entries.length === 0) {
            throw new Error(`Lambder: API "${apiName}" declares an empty guards option, which authorizes nothing. ` +
                `Name the guard that authorizes it, or omit the option entirely.`);
        }
        for (const { name } of entries) {
            const guardDef = this.guards.get(name);
            if (!guardDef) {
                throw new Error(`Lambder: API "${apiName}" references unknown guard "${name}". Declare it in the guards option at creation.`);
            }
            if (guardDef.session && mode !== "session") {
                throw new Error(`Lambder: API "${apiName}" uses guard "${name}" (session: true), which requires addSessionApi.`);
            }
        }
    }
    /**
     * Run the API's guards in declared order. Refusals throw; outputs land on
     * ctx.guardData. Each guard is recorded on the trace as it returns, so a
     * call that a later guard refused still reports the ones that passed.
     */
    async run(request, ctx, guardsOption, trace) {
        for (const { name, param } of toGuardEntries(guardsOption)) {
            const guardDef = this.guards.get(name);
            if (!guardDef)
                throw new Error(`Lambder: guard "${name}" is not configured. Declare it in the guards option at creation.`);
            // Recorded before anything this guard does can refuse, so the list
            // says which guards were reached and the one that said no is the
            // last name on it. Recording after the return named every guard
            // except the one someone reading the trace was looking for; doing
            // it after the slice parse below had the same effect for a guard
            // that refuses by rejecting its own input, which answers 422 and
            // is exactly the refusal a reader is trying to place.
            trace.guardsRun.push(name);
            let payload;
            if (guardDef.apiInput) {
                payload = parsePreflightSlice(guardDef.apiInput, request.payload);
            }
            else if (guardDef.guardInput) {
                payload = parsePreflightSlice(guardDef.guardInput, readGuardInput(request.guardInputs, name));
            }
            // A guard's return value becomes the handler's typed
            // ctx.guardData[name]; check-only guards return undefined.
            const output = await guardDef.handler(ctx, payload, param);
            if (isLambderResponseLike(output)) {
                throw new Error(`Lambder: guard "${name}" returned a LambderResponse. A guard authorizes, it does not answer: ` +
                    `say no with refuse() or by throwing a LambderApiRefusal. Returning a response denies nothing, ` +
                    `because the value would be attached to ctx.guardData and the call would continue.`);
            }
            if (output !== undefined) {
                ctx.guardData[name] = output;
            }
        }
    }
}
