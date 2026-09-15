import { LambderApiRefusal, isLambderApiRefusal } from "../shared/wire/LambderApiRefusal.js";
/**
 * A rejected input, thrown as a typed refusal rather than built as a
 * response. The API's own schema and every preflight slice (a guard's input,
 * a rate-limit key's fields) throw this when a value fails to parse, and the
 * pipeline renders it in one place: through the app's input validation
 * handler when it set one, otherwise as the standard 422 body. The engines
 * therefore never build a response and never see a resolver, which is what
 * lets them run outside a Lambda.
 *
 * A LambderApiRefusal, so every catch that maps refusals already handles it;
 * the brand tells the pipeline to route it through the validation handler
 * instead of the refusal envelope.
 */
export class LambderApiValidationRefusal extends LambderApiRefusal {
    /** Brand for detection across duplicate lambder installs, like LambderApiRefusal's. */
    isLambderApiValidationRefusal = true;
    zodError;
    constructor(zodError) {
        super("Input validation failed", { statusCode: 422 });
        this.name = "LambderApiValidationRefusal";
        this.zodError = zodError;
    }
}
/** Brand-based type guard (see LambderApiValidationRefusal.isLambderApiValidationRefusal). */
export const isLambderApiValidationRefusal = (err) => isLambderApiRefusal(err) && err.isLambderApiValidationRefusal === true;
/**
 * Validate a preflight input slice (an apiInput slice of the raw payload, or
 * a guardInput value from the raw guardInputs map). Runs before the API's
 * own validation; a failure throws the same LambderApiValidationRefusal the
 * API's schema throws, so the pipeline answers every rejected input alike.
 * Shared by the guards engine and the rate-limit engine, and living here
 * beside the error it throws rather than in one of the two.
 */
export const parsePreflightSlice = (input, value) => {
    const parsed = input.safeParse(value);
    if (!parsed.success)
        throw new LambderApiValidationRefusal(parsed.error);
    return parsed.data;
};
