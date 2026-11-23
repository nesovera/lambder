/**
 * The server's policy builders: the generic builders from `api/`, bound to
 * the render contexts a Lambda handler runs on.
 *
 * They live in `core/` rather than beside the engines because the binding is
 * the only server-specific part of a guard or a rate-limit key, and keeping it
 * here means `api/` never imports from `core/`. The mock runtime binds the
 * same generic builders to its own call contexts in its own layer.
 */
import { lambderGuardBuilder } from "../api/LambderApiGuards.js";
import { lambderRateLimitKeyBuilder } from "../api/LambderApiRateLimits.js";
/** Builder for the server's guards: the handler sees the render context (session-typed when `session: true`). */
export const lambderGuard = lambderGuardBuilder();
/** Builder for the server's rate-limit keys: the handler sees the render context. */
export const lambderRateLimitKey = lambderRateLimitKeyBuilder();
/**
 * The same two builders bound to one app's session data and refusal
 * vocabulary, which is what initLambder<SessionData>() hands out beside
 * create(): a guard's `ctx.session.data` and `ctx.sessionController` are
 * SessionData where the standalone lambderGuard() leaves them `any`, and its
 * `ctx.refuse` is typed to the guard's refusals from the vocabulary
 * declareRefusals() gave (null: none declared, so a guard names no code),
 * and its `ctx.apiFacts` to the facts declareApiFacts() gave (never: none
 * declared, so the context's own untyped `apiFacts` stands).
 * The server's counterpart of the mock's `guard` and `rateLimitKey`.
 */
export const policyBuildersFor = (vocabulary) => ({
    /** Builds a guard whose handler sees this app's session type, on ctx.refuse the guard's own refusal codes, and on ctx.apiFacts the facts the app declared. */
    guard: lambderGuardBuilder(vocabulary),
    /** Builds a rate-limit key whose handler sees this app's session type; the counterpart of `guard`. */
    rateLimitKey: lambderRateLimitKeyBuilder(),
});
