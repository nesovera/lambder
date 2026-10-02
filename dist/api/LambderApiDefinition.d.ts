import type { z } from "zod";
import type { LambderEndpointRefusals } from "./LambderApiRefusals.js";
import type { LambderApiMode } from "../shared/wire/LambderApiContract.js";
import type { LambderApiIdempotencyOption, LambderGuardsOptionValue, LambderRateLimitOptionValue } from "../shared/wire/LambderApiOptionValues.js";
/**
 * One endpoint's declaration as the pipeline runs it: what the server's
 * defineApi options carry, minus the handler, in a shape the mock
 * runtime can restate from a type-only contract. The schemas are optional
 * because a mock may have none (its input schema is the generated table's,
 * an entry's own, or neither); when input is present, validation runs and the
 * handler sees the parsed payload. Output is part of the endpoint's
 * signature (apiSignatureOf), which is what a client's build is checked
 * against; the server also parses every output a handler returns through it
 * before it is sent.
 *
 * `refusals` is every code the endpoint may refuse with (its own option and
 * its guards'), resolved against the vocabulary, and whether every refusal
 * has to name one: what every refusal it answers with is checked against
 * (checkedRefusal); the codes are part of its signature. Undefined where the
 * codes are not known (a mock without generated options), which checks
 * nothing.
 */
export type LambderApiDefinition = {
    name: string;
    mode: LambderApiMode;
    guards?: LambderGuardsOptionValue;
    rateLimit?: LambderRateLimitOptionValue;
    idempotency?: LambderApiIdempotencyOption;
    input?: z.ZodType;
    output?: z.ZodType;
    refusals?: LambderEndpointRefusals;
};
