/**
 * The declared options of an app's APIs as plain data: what
 * `lambder.apiOptionEntries()` reports and `writeApiOptions` (lambder/build)
 * writes to a module a mock or a test imports instead of the server. The
 * contract carries the same options as types; this is the same fact as a
 * value, for the code that has to decide something at runtime with it (which
 * declarations a mock restates, which APIs a test walks). A screen reads one
 * guard's parameters instead (writeApiGuardParams), since this table names
 * every endpoint.
 *
 * Declared here, below the contract and the engines, for the reason
 * LambderApiOptionValues is: the generated module names these types through
 * `lambder/client`, the instance method fills them, and neither may reach
 * into `api/`. The three vocabularies the engines share with the entries
 * (when a guard runs, what a budget spans, when a custom key is charged) are
 * declared here too and re-exported by the engines that read them.
 */
import type { LambderApiMode, LambderGuardNamesIn } from "./LambderApiContract.js";
import type { LambderApiIdempotencyOption, LambderGuardsOptionValue, LambderRateLimitOptionValue } from "./LambderApiOptionValues.js";
import type { LambderAppRefusalMessage } from "./LambderApiRefusal.js";
import type { LambderRateLimitPolicy } from "../contracts/LambderRateLimiter.js";
/**
 * When a guard runs, relative to the API's input validation.
 *
 * - "beforeInputValidation" (default): an unauthorized caller learns nothing
 *   about the input, and no async refinement in the schema runs for it.
 * - "afterInputValidation": for a guard that spends something on the
 *   request, such as a single-use captcha token, which a request refused for
 *   a mistyped field would otherwise waste. The API's input schema then runs
 *   for callers this guard would refuse, so keep lookups (an "email is free"
 *   refinement) out of it, in the handler.
 *
 * Guards run in their declared order within each, and the limits keyed by
 * caller data are charged after both unless their policy says otherwise
 * (LambderRateLimitChargeAt).
 */
export type LambderGuardRunAt = "beforeInputValidation" | "afterInputValidation";
/**
 * What one rate-limit budget spans:
 *
 * - "perApi" (default): every API referencing the policy gets its own
 *   counter, so the windows are a per-API ceiling (three APIs referencing a
 *   60/min policy allow one subject 180/min in total). An API may tune the
 *   windows in its declaration: `rateLimit: { name: { perMin: 20 } }`.
 * - "perPolicy": every API referencing the policy shares ONE counter, so the
 *   windows are one combined budget (e.g. one per-email allowance across
 *   send, register, and reset). The policy IS the group: to give user APIs
 *   and report APIs separate shared budgets, declare two policies.
 */
export type LambderRateLimitBudget = "perApi" | "perPolicy";
/**
 * When a custom-keyed policy is charged, relative to the guards and the input
 * schema.
 *
 * - "afterGuards" (default): after every guard and the input schema passed.
 *   The key is a value the caller chose (an email in the payload), so a
 *   caller who never passes a captcha guard cannot spend a victim's budget
 *   and lock them out of reset, register and send-code.
 * - "beforeGuards": before the guards and the input schema, so an attempt
 *   they refuse is counted too. For a limit on guessing a secret a guard or
 *   the schema checks (a one-time code checked by a guard, keyed per email):
 *   charged after them, a wrong guess is refused before it is ever counted.
 *   Pair it with an IP limit, since anyone may spend this budget.
 */
export type LambderRateLimitChargeAt = "beforeGuards" | "afterGuards";
/**
 * One API as the generated module records it: its mode and its three
 * declarative options exactly as written at registration. A guard's
 * parameter is written as the JSON it is (a permission string, a list of
 * them, a reason), which is what makes the module plain data: a parameter
 * that is code or a class instance fails the write and names the API.
 */
export type LambderApiOptionEntry = {
    mode: LambderApiMode;
    guards?: LambderGuardsOptionValue;
    rateLimit?: LambderRateLimitOptionValue;
    idempotency?: LambderApiIdempotencyOption;
};
/**
 * One rate-limit policy as the generated module records it: its windows,
 * budget, charge point and message as declared, and its key reduced to what
 * it counts. A policy keyed by a handler of the app's is `per: "custom"` and
 * nothing more: the handler is code, and never written. A policy with no
 * `per` is charged by code with a key of its own and has none here either.
 */
export type LambderRateLimitPolicyEntry = LambderRateLimitPolicy & {
    per?: "ip" | "session" | "custom";
    budget?: LambderRateLimitBudget;
    chargeAt?: LambderRateLimitChargeAt;
    errorMessage?: LambderAppRefusalMessage;
};
/**
 * One guard as the generated module records it: how it is fed (a slice of
 * the API's own payload, a value the client sends separately, or nothing),
 * whether it needs a session, and when it runs. The schema behind an input
 * mode is never written; the mode alone is what a mock guard standing in for
 * it has to match.
 */
export type LambderGuardDeclarationEntry = {
    input: "apiInput" | "guardInput" | "none";
    session: boolean;
    runAt: LambderGuardRunAt;
};
/** Everything `lambder.apiOptionEntries()` reports, and the three tables the generated module exports. */
export type LambderApiOptionEntries = {
    apis: Record<string, LambderApiOptionEntry>;
    rateLimitPolicies: Record<string, LambderRateLimitPolicyEntry>;
    guards: Record<string, LambderGuardDeclarationEntry>;
};
/** The names of the APIs in a generated `apiOptions` table whose guards option names guard N, in any of its three forms and whatever else it declares beside it. */
export type LambderApisWithGuard<TOptions, N extends string> = {
    [K in keyof TOptions]: TOptions[K] extends {
        guards: infer G;
    } ? (N extends LambderGuardNamesIn<G> ? K : never) : never;
}[keyof TOptions] & string;
/**
 * The names of the APIs whose guards option is exactly TGuards: the APIs
 * behind `"platformAdmin"` alone, say, and not those that declare it beside
 * another guard. For a list a test loops over, checked against the table in
 * both directions.
 */
export type LambderApisGuardedBy<TOptions, TGuards> = {
    [K in keyof TOptions]: TOptions[K] extends {
        guards: infer G;
    } ? ([G] extends [TGuards] ? K : never) : never;
}[keyof TOptions] & string;
/** The names of the APIs of one mode in a generated `apiOptions` table. */
export type LambderApisWithMode<TOptions, M extends LambderApiMode> = {
    [K in keyof TOptions]: TOptions[K] extends {
        mode: M;
    } ? K : never;
}[keyof TOptions] & string;
/**
 * The parameter an API's guards option gives guard N: the value in the map
 * form, `true` for a guard named without one (the string and list forms, or
 * `true` in the map), and `undefined` for an API that does not declare it.
 */
export type LambderGuardParamOf<TEntry, N extends string> = TEntry extends {
    guards: infer G;
} ? G extends string ? (N extends G ? true : undefined) : G extends readonly string[] ? (N extends G[number] ? true : undefined) : N extends keyof G ? G[N] : undefined : undefined;
/**
 * The parameter an API's guards option gives guard N, read off a generated
 * `apiOptions` table with the type the table pins: the literal a permission
 * was declared as, `true` for a guard named without a parameter, and
 * `undefined` when the API does not declare the guard. What a test or a mock
 * reads instead of the source.
 */
export declare const apiGuardParam: <TOptions extends Record<string, LambderApiOptionEntry>, K extends keyof TOptions & string, N extends string>(options: TOptions, name: K, guard: N) => LambderGuardParamOf<TOptions[K], N>;
