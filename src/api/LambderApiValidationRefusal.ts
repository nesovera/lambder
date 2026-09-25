import type { z } from "zod";
import { LambderApiRefusal, isLambderApiRefusal } from "../shared/wire/LambderApiRefusal.js";

/**
 * A rejected input, thrown as a typed refusal rather than built as a
 * response. The API's own schema and every preflight slice (a guard's input,
 * a rate-limit key's fields) throw this when a value fails to parse, and the
 * pipeline renders it in one place: through the app's input validation
 * handler when set, otherwise as the standard 422 body. The engines never
 * build a response or see a resolver, which lets them run outside a Lambda.
 *
 * It is a LambderApiRefusal, so every catch that maps refusals handles it;
 * the brand routes it through the validation handler instead of the refusal
 * envelope.
 */
export class LambderApiValidationRefusal extends LambderApiRefusal {
    /** Brand for detection across duplicate lambder installs, like LambderApiRefusal's. */
    readonly isLambderApiValidationRefusal = true;
    readonly zodError: z.ZodError;

    constructor(zodError: z.ZodError){
        super("Input validation failed", { statusCode: 422 });
        this.name = "LambderApiValidationRefusal";
        this.zodError = zodError;
    }
}

/** Brand-based type guard (see LambderApiValidationRefusal.isLambderApiValidationRefusal). */
export const isLambderApiValidationRefusal = (err: unknown): err is LambderApiValidationRefusal =>
    isLambderApiRefusal(err) && (err as LambderApiValidationRefusal).isLambderApiValidationRefusal === true;

/**
 * Validate a preflight input slice (an apiInput slice of the raw payload, or
 * a guardInput value from the raw guardInputs map). Runs before the API's
 * own validation; a failure throws the same LambderApiValidationRefusal the
 * API's schema throws, so the pipeline answers every rejected input alike.
 * Shared by the guards and rate-limit engines, so it lives beside the error
 * it throws. Parsed asynchronously, so a slice with an async refinement (a
 * lookup, say) validates instead of making zod throw on every call.
 */
export const parsePreflightSlice = async (input: z.ZodType, value: unknown): Promise<unknown> => {
    const parsed = await input.safeParseAsync(value);
    if(!parsed.success) throw new LambderApiValidationRefusal(parsed.error);
    return parsed.data;
};
