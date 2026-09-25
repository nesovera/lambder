import { parsePreflightSlice } from "./LambderApiValidationRefusal.js";
import { LAMBDER_RESPONSE_BRAND, isLambderResponseLike } from "../shared/util/LambderResponseBrand.js";
/**
 * A guard builder bound to a pair of context types. The server's
 * lambderGuard() is this bound to the render contexts; the mock runtime
 * binds it to its own handler contexts, so mock guards are the same shape
 * as server guards and run through the same engine.
 */
export const lambderGuardBuilder = () => ((guard) => guard);
/** Normalize the three guards-option forms into ordered { name, param } entries. Read by the engine, and by the signature digest for the names alone. */
export const toGuardEntries = (value) => {
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
 * data, so a guard named for something Object.prototype carries
 * ("toString", "constructor") must read as absent when the client sent
 * nothing, not as the inherited function. Guard names are deliberately
 * unrestricted, so the read has to handle this.
 */
const readGuardInput = (guardInputs, name) => guardInputs !== undefined && Object.prototype.hasOwnProperty.call(guardInputs, name) ? guardInputs[name] : undefined;
/**
 * Runtime side of the guards subsystem: holds the defined guards, asserts
 * API registrations against them at startup, and executes an API's declared
 * guards during preflight. Held by LambderApiPipeline. Reads the
 * request and writes the call context, so it runs unchanged under the
 * server and the mock runtime.
 */
export class LambderApiGuardsEngine {
    // A Map, not an object: a plain object answers for "toString" and
    // "constructor" through its prototype, so an API declaring one of those as
    // a guard name would pass the registration check meant to catch exactly
    // that typo and then fail on every request. It would also refuse to
    // register a guard legitimately named one of them.
    guards = new Map();
    /** True once a guards map was configured. */
    get isConfigured() { return this.guards.size > 0; }
    /** Take the guards map given at creation; named like the other two engines' configure(). */
    configure(guards) {
        // One configuration per instance, as in the rate-limit and idempotency
        // engines: a second map would silently merge into the first, and which
        // of two same-named guards ran would depend on call order.
        if (this.guards.size > 0)
            throw new Error("Lambder: guards were already configured.");
        // Declaring the option always declares a guard, the rule an API's own
        // `guards: {}` is held to. Otherwise the engine stays unconfigured and
        // every API declaring a guard is told no guards option was given,
        // which sends the reader to the wrong line.
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
            const runAt = guardDef.runAt;
            if (runAt !== undefined && runAt !== "beforeInputValidation" && runAt !== "afterInputValidation") {
                throw new Error(`Lambder: guard "${name}" has runAt "${String(runAt)}"; use "beforeInputValidation" (default) or "afterInputValidation".`);
            }
            this.guards.set(name, guardDef);
        }
    }
    /** Startup validation of one API registration's guards option. */
    assertRegistration(apiName, mode, guardsOption) {
        const entries = toGuardEntries(guardsOption);
        // The runtime half of LambderNonEmptyOptionMap on the guards option.
        // `guards: {}` and `guards: []` would satisfy the require*ApiGuards
        // field check while running nothing, turning a mandatory authorization
        // declaration into an optional one. The type rejects both; a plain-JS
        // caller, a cast, or a spread that produced an empty object lands here.
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
     * Run the API's guards that run at `runAt` (see LambderGuardRunAt) in
     * declared order. Refusals throw; outputs land on ctx.guardData; the
     * trace names every guard reached.
     */
    async run(request, ctx, guardsOption, trace, runAt) {
        for (const { name, param } of toGuardEntries(guardsOption)) {
            const guardDef = this.guards.get(name);
            if (!guardDef)
                throw new Error(`Lambder: guard "${name}" is not configured. Declare it in the guards option at creation.`);
            if ((guardDef.runAt ?? "beforeInputValidation") !== runAt)
                continue;
            // Recorded before anything this guard does can refuse, including
            // the slice parse below (a guard that rejects its own input answers
            // 422), so the guard that said no is the last name on the list.
            trace.guardsRun.push(name);
            let payload;
            if (guardDef.apiInput) {
                payload = await parsePreflightSlice(guardDef.apiInput, request.payload);
            }
            else if (guardDef.guardInput) {
                payload = await parsePreflightSlice(guardDef.guardInput, readGuardInput(request.guardInputs, name));
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
