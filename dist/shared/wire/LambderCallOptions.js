/**
 * The per-call options, the contract-driven typing of a call's arguments, and
 * the runtime merge of guard inputs, shared by the browser caller
 * (LambderCaller) and the server-side invoke caller (LambderInvokeCaller).
 * Both speak the same envelope to the same kind of contract, so what an API
 * demands of its caller (a guardInput-mode guard's value, say) is decided
 * here once and the two cannot drift. Pure types and one dependency-free
 * function, so the browser entry resolves it.
 */
/**
 * Provider values underneath, per-call values on top; undefined when neither
 * side supplied any. Synchronous so a call without a provider still issues
 * its request in the same tick it was made.
 */
export const mergeGuardInputs = (provided, perCall) => provided !== undefined || perCall !== undefined ? { ...provided, ...perCall } : undefined;
