import type { z } from "zod";
import type { LambderApiMode } from "../shared/wire/LambderApiContract.js";
import type { LambderApiIdempotencyOption, LambderGuardsOptionValue, LambderRateLimitOptionValue } from "../shared/wire/LambderApiOptionValues.js";
/**
 * One endpoint's declaration as the pipeline runs it: what the server's
 * addApi/addSessionApi options carry, minus the handler, in a shape the mock
 * runtime can restate from a type-only contract. The schema is optional
 * because the mock has none; when present, input validation runs and the
 * handler sees the parsed payload.
 */
export type LambderApiDefinition = {
    name: string;
    mode: LambderApiMode;
    guards?: LambderGuardsOptionValue;
    rateLimit?: LambderRateLimitOptionValue;
    idempotency?: LambderApiIdempotencyOption;
    input?: z.ZodType;
};
