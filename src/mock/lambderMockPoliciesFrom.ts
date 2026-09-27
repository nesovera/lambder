import type { LambderApiRateLimitPolicyConfig, LambderRateLimitKeyFn } from "../api/LambderApiRateLimits.js";
import type { LambderRateLimitPolicyEntry } from "../shared/wire/LambderApiOptionEntries.js";

/*
 * The server's rate-limit policies, as a mock restates them, from the
 * generated options module rather than from a copy kept by hand.
 *
 * A mock's create() takes the same policy configs the server declares, so
 * that a limit an endpoint restates is applied here as it is there. The
 * generated `rateLimitPolicies` table holds every policy less its key
 * handler, which is code and never written; this puts the handlers back, and
 * asks for exactly the ones the table says are missing. A policy the server
 * adds with a custom key is a compile error here until the mock gives it one,
 * and every other policy follows the server without anyone copying it.
 */

/** The names of the policies in a generated table whose key the app derives, and so the ones a mock has to supply a key handler for. */
export type LambderCustomKeyedPolicyNames<TPolicies> =
    { [N in keyof TPolicies]: TPolicies[N] extends { per: "custom" } ? N : never }[keyof TPolicies] & string;

/** One policy as the mock runs it: the table's entry with its `per` put back, the key handler for a custom one and the literal for the rest. */
type LambderMockPolicyOf<TPolicy, TKey> =
    Omit<TPolicy, "per"> & (TPolicy extends { per: "custom" } ? { per: TKey } : TPolicy extends { per: infer P } ? { per: P } : {});

/** The key handlers a table needs: one per custom-keyed policy, none where the table has none. */
export type LambderMockPolicyKeys<TPolicies> = { [N in LambderCustomKeyedPolicyNames<TPolicies>]: LambderRateLimitKeyFn<any, any> };

/**
 * The rate-limit policies a mock's create() takes, built from a generated
 * `rateLimitPolicies` table and the key handlers for its custom-keyed
 * policies (built with the mock's own `rateLimitKey`, so they see the mock's
 * context). Required for exactly those policies, refused for any other:
 *
 * ```ts
 * const mockApp = mock.create({
 *     rateLimits: {
 *         policies: lambderMockPoliciesFrom(rateLimitPolicies, {
 *             keys: {
 *                 codePerEmail: mock.rateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email.toLowerCase() }),
 *             },
 *         }),
 *     },
 * });
 * ```
 *
 * Everything else about a policy (windows, budget, charge point, message) is
 * the table's, so a mock never disagrees with the server about a limit it
 * did not mean to change. The result keeps each policy's `per` and `budget`
 * as literals, which is what lets create() hold it to the contract.
 */
export const lambderMockPoliciesFrom = <
    const TPolicies extends Record<string, LambderRateLimitPolicyEntry>,
    const TKeys extends LambderMockPolicyKeys<TPolicies> = LambderMockPolicyKeys<TPolicies>,
>(
    policies: TPolicies,
    options: [LambderCustomKeyedPolicyNames<TPolicies>] extends [never]
        ? { keys?: TKeys & Record<Exclude<keyof TKeys, LambderCustomKeyedPolicyNames<TPolicies>>, never> }
        : { keys: TKeys & Record<Exclude<keyof TKeys, LambderCustomKeyedPolicyNames<TPolicies>>, never> },
): { [N in keyof TPolicies]: LambderMockPolicyOf<TPolicies[N], N extends keyof TKeys ? TKeys[N] : never> } => {
    const keys = (options.keys ?? {}) as Record<string, LambderRateLimitKeyFn<any, any> | undefined>;
    const built: Record<string, LambderApiRateLimitPolicyConfig> = {};
    for(const [name, entry] of Object.entries(policies)){
        const { per, ...rest } = entry;
        if(per === "custom"){
            const key = keys[name];
            if(typeof key?.handler !== "function"){
                throw new Error(`LambderMockApp: rate-limit policy "${name}" is keyed by a handler of the server's, so the mock has to supply one: lambderMockPoliciesFrom(rateLimitPolicies, { keys: { ${name}: mock.rateLimitKey({ ... }) } }).`);
            }
            built[name] = { ...rest, per: key };
        }else{
            built[name] = per === undefined ? { ...rest } : { ...rest, per };
        }
    }
    for(const name of Object.keys(keys)){
        if(policies[name]?.per !== "custom"){
            throw new Error(`LambderMockApp: a key handler was given for rate-limit policy "${name}", which the server ${name in policies ? "does not key by a handler" : "does not declare"}.`);
        }
    }
    return built as never;
};
