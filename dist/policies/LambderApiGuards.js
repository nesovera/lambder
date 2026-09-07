export function lambderGuard(guard) { return guard; }
/** Normalize the three guards-option forms into ordered { name, param } entries. */
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
 * Validate a preflight input slice (an apiInput slice of the raw payload, or
 * a guardInput value from the raw guardInputs map). Runs before the API's
 * own validation; a failure throws the response `onInvalid` decides, the
 * same one regular input validation answers. Shared with the rate-limit
 * engine's apiInput-keyed policies.
 */
export const parsePreflightSlice = async (input, value, ctx, resolver, onInvalid) => {
    const parsed = input.safeParse(value);
    if (!parsed.success)
        throw await onInvalid(ctx, resolver, parsed.error);
    return parsed.data;
};
/**
 * Runtime side of the guards subsystem: holds the defined guards, asserts
 * API registrations against them at startup, and executes an API's declared
 * guards during preflight. Composed into LambderApiPolicyEngine.
 */
export class LambderApiGuardsEngine {
    onInvalidInput;
    guards = {};
    constructor(onInvalidInput) {
        this.onInvalidInput = onInvalidInput;
    }
    addGuards(guards) {
        for (const [name, guardDef] of Object.entries(guards)) {
            if (this.guards[name])
                throw new Error(`Lambder: guard "${name}" is already defined.`);
            if (typeof guardDef?.handler !== "function")
                throw new Error(`Lambder: guard "${name}" has no handler function.`);
            if (guardDef.apiInput && guardDef.guardInput)
                throw new Error(`Lambder: guard "${name}" declares both apiInput and guardInput; pick one.`);
            this.guards[name] = guardDef;
        }
    }
    /** Startup validation of one API registration's guards option. */
    assertRegistration(apiName, mode, guardsOption) {
        for (const { name } of toGuardEntries(guardsOption)) {
            const guardDef = this.guards[name];
            if (!guardDef) {
                throw new Error(`Lambder: API "${apiName}" references unknown guard "${name}". Declare it in the guards option at creation.`);
            }
            if (guardDef.session && mode !== "session") {
                throw new Error(`Lambder: API "${apiName}" uses guard "${name}" (session: true), which requires addSessionApi.`);
            }
        }
    }
    /** Run the API's guards in declared order. Refusals throw; outputs land on ctx.guardData. */
    async run(ctx, resolver, guardsOption) {
        for (const { name, param } of toGuardEntries(guardsOption)) {
            const guardDef = this.guards[name];
            if (!guardDef)
                throw new Error(`Lambder: guard "${name}" is not configured.`);
            const post = ctx.post;
            let payload;
            if (guardDef.apiInput) {
                payload = await parsePreflightSlice(guardDef.apiInput, post?.payload, ctx, resolver, this.onInvalidInput);
            }
            else if (guardDef.guardInput) {
                payload = await parsePreflightSlice(guardDef.guardInput, post?.guardInputs?.[name], ctx, resolver, this.onInvalidInput);
            }
            // A guard's return value becomes the handler's typed
            // ctx.guardData[name]; check-only guards return undefined.
            const output = await guardDef.handler(ctx, payload, resolver, param);
            if (output !== undefined) {
                ctx.guardData[name] = output;
            }
        }
    }
}
