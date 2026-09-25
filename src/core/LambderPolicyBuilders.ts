/**
 * The server's policy builders: the generic builders from `api/`, bound to
 * the render contexts a Lambda handler runs on.
 *
 * They live in `core/` rather than beside the engines because the binding is
 * the only server-specific part of a guard or a rate-limit key, and keeping it
 * here means `api/` never imports from `core/`. The mock runtime binds the
 * same generic builders to its own call contexts in its own layer.
 */

import type { LambderRenderContext, LambderSessionRenderContext } from "./LambderContext.js";
import { lambderGuardBuilder, type LambderGuardBuilder } from "../api/LambderApiGuards.js";
import { lambderRateLimitKeyBuilder, type LambderRateLimitKeyBuilder } from "../api/LambderApiRateLimits.js";

/** Builder for the server's guards: the handler sees the render context (session-typed when `session: true`). */
export const lambderGuard: LambderGuardBuilder<LambderRenderContext, LambderSessionRenderContext<any, any>> =
    lambderGuardBuilder<LambderRenderContext, LambderSessionRenderContext<any, any>>();

/** Builder for the server's rate-limit keys: the handler sees the render context. */
export const lambderRateLimitKey: LambderRateLimitKeyBuilder<LambderRenderContext> =
    lambderRateLimitKeyBuilder<LambderRenderContext>();

/**
 * The same two builders bound to one app's session data, which is what
 * initLambder<SessionData>() hands out beside create(): a guard's
 * `ctx.session.data` and `ctx.sessionController` are SessionData where the standalone
 * lambderGuard() leaves them `any`. The server's counterpart of the mock's
 * `guard` and `rateLimitKey`.
 */
export const policyBuildersFor = <TSessionData>() => ({
    /** Builds a guard whose handler sees this app's session type. */
    guard: lambderGuardBuilder<LambderRenderContext<any, Record<string, string>, {}, TSessionData>, LambderSessionRenderContext<any, TSessionData>>(),
    /** Builds a rate-limit key whose handler sees this app's session type; the counterpart of `guard`. */
    rateLimitKey: lambderRateLimitKeyBuilder<LambderRenderContext<any, Record<string, string>, {}, TSessionData>>(),
});
