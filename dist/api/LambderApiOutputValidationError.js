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
export class LambderApiOutputValidationError extends Error {
    apiName;
    /**
     * The schema's issues when it rejected the payload. Null when the parse
     * threw instead; what it threw is the `cause`.
     */
    zodError;
    /**
     * `failure` is how the parse ended: `{ zodError }` when the schema
     * rejected the payload, `{ thrown }` when parsing it threw.
     */
    constructor(apiName, failure) {
        let message;
        if ("zodError" in failure) {
            // Paths and messages only: an issue's message names the expected
            // type, and the values themselves stay out of a crash report.
            const issues = failure.zodError.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
            message = `Lambder: API "${apiName}" answered a payload its output schema does not accept, so it was not sent. ${issues}`;
        }
        else if (failure.thrown instanceof z.core.$ZodAsyncError) {
            message = `Lambder: API "${apiName}" has an async refinement or transform in its output schema, and an output schema cannot be async: `
                + "a payload is parsed synchronously on its way out. The payload was not sent.";
        }
        else {
            // The thrown error's own message stays in the cause: it is the
            // app's text and may carry the value the transform was given.
            message = `Lambder: API "${apiName}" answered a payload its output schema threw on while parsing it (a transform that threw, `
                + "or an async step a synchronous parse cannot run), so it was not sent. What the schema threw is the cause.";
        }
        super(message, { cause: "zodError" in failure ? failure.zodError : failure.thrown });
        this.name = "LambderApiOutputValidationError";
        this.apiName = apiName;
        this.zodError = "zodError" in failure ? failure.zodError : null;
    }
}
