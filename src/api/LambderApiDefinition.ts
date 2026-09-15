import type { z } from "zod";
import type { LambderApiMode } from "../shared/wire/LambderApiContract.js";
import type {
    LambderApiIdempotencyOption,
    LambderGuardsOptionValue,
    LambderRateLimitOptionValue,
} from "../shared/wire/LambderApiOptionValues.js";

/**
 * One endpoint's declaration as the pipeline runs it: what the server's
 * addApi/addSessionApi options carry, minus the handler, in a shape the mock
 * runtime can restate from a type-only contract. The schemas are optional
 * because the mock has none; when input is present, validation runs and the
 * handler sees the parsed payload. Output is read by nothing at request
 * time: it is part of the endpoint's signature (apiSignatureOf), which is
 * what a client's build is checked against.
 */
export type LambderApiDefinition = {
    name: string;
    mode: LambderApiMode;
    guards?: LambderGuardsOptionValue;
    rateLimit?: LambderRateLimitOptionValue;
    idempotency?: LambderApiIdempotencyOption;
    input?: z.ZodType;
    output?: z.ZodType;
};
