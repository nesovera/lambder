import { z } from "zod";
/**
 * A handler answered a payload its API's output schema could not turn into
 * the declared shape, so the payload was not sent and the call is answered
 * as a crash. Either the schema rejected the payload, or the parse threw: an
 * async refinement or transform (the output is parsed synchronously, so an
 * output schema cannot be async), or a transform that threw. The output
 * side's counterpart of LambderApiValidationRefusal, with the API it happened
 * in, for a crash reporter.
 *
 * Its own class because it is a crash after the fact: the handler ran to
 * its answer, whatever it wrote or charged along the way included. The
 * idempotency engine reads it that way and keeps the key's record, so a
 * retry is told the same thing instead of running the operation again.
 */
export declare class LambderApiOutputValidationError extends Error {
    readonly apiName: string;
    /**
     * The schema's issues when it rejected the payload. Null when the parse
     * threw instead; what it threw is the `cause`.
     */
    readonly zodError: z.ZodError | null;
    /**
     * `failure` is how the parse ended: `{ zodError }` when the schema
     * rejected the payload, `{ thrown }` when parsing it threw.
     */
    constructor(apiName: string, failure: {
        zodError: z.ZodError;
    } | {
        thrown: unknown;
    });
}
