/**
 * The server's policy builders: the generic builders from `api/`, bound to
 * the render contexts a Lambda handler runs on.
 *
 * They live in `core/` rather than beside the engines because binding them is
 * the one thing about a guard or a rate-limit key that is the SERVER's, and
 * having them in `api/` was the last reason that layer imported from `core/`
 * at all. The mock runtime binds the same builders to its own call contexts,
 * in its own layer, which is why the builders themselves are generic.
 */
import type { LambderRenderContext, LambderSessionRenderContext } from "./LambderContext.js";
import { type LambderGuardBuilder } from "../api/LambderApiGuards.js";
import { type LambderRateLimitKeyBuilder } from "../api/LambderApiRateLimits.js";
/** Builder for the server's guards: the handler sees the render context (session-typed when `session: true`). */
export declare const lambderGuard: LambderGuardBuilder<LambderRenderContext, LambderSessionRenderContext<any, any>>;
/** Builder for the server's rate-limit keys: the handler sees the render context. */
export declare const lambderRateLimitKey: LambderRateLimitKeyBuilder<LambderRenderContext>;
