import type { LambderRateLimitKeyFn } from "../api/LambderApiRateLimits.js";
import type { LambderRateLimitPolicyEntry } from "../shared/wire/LambderApiOptionEntries.js";
/** The names of the policies in a generated table whose key the app derives, and so the ones a mock has to supply a key handler for. */
export type LambderCustomKeyedPolicyNames<TPolicies> = {
    [N in keyof TPolicies]: TPolicies[N] extends {
        per: "custom";
    } ? N : never;
}[keyof TPolicies] & string;
/** One policy as the mock runs it: the table's entry with its `per` put back, the key handler for a custom one and the literal for the rest. */
type LambderMockPolicyOf<TPolicy, TKey> = Omit<TPolicy, "per"> & (TPolicy extends {
    per: "custom";
} ? {
    per: TKey;
} : TPolicy extends {
    per: infer P;
} ? {
    per: P;
} : {});
/** The key handlers a table needs: one per custom-keyed policy, none where the table has none. */
export type LambderMockPolicyKeys<TPolicies> = {
    [N in LambderCustomKeyedPolicyNames<TPolicies>]: LambderRateLimitKeyFn<any, any>;
};
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
export declare const lambderMockPoliciesFrom: <const TPolicies extends Record<string, LambderRateLimitPolicyEntry>, const TKeys extends LambderMockPolicyKeys<TPolicies> = LambderMockPolicyKeys<TPolicies>>(policies: TPolicies, options: [LambderCustomKeyedPolicyNames<TPolicies>] extends [never] ? {
    keys?: TKeys & Record<Exclude<keyof TKeys, LambderCustomKeyedPolicyNames<TPolicies>>, never>;
} : {
    keys: TKeys & Record<Exclude<keyof TKeys, LambderCustomKeyedPolicyNames<TPolicies>>, never>;
}) => { [N in keyof TPolicies]: LambderMockPolicyOf<TPolicies[N], N extends keyof TKeys ? TKeys[N] : never>; };
export {};
