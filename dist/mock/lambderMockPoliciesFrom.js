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
export const lambderMockPoliciesFrom = (policies, options) => {
    const keys = (options.keys ?? {});
    const built = {};
    for (const [name, entry] of Object.entries(policies)) {
        const { per, ...rest } = entry;
        if (per === "custom") {
            const key = keys[name];
            if (typeof key?.handler !== "function") {
                throw new Error(`LambderMockApp: rate-limit policy "${name}" is keyed by a handler of the server's, so the mock has to supply one: lambderMockPoliciesFrom(rateLimitPolicies, { keys: { ${name}: mock.rateLimitKey({ ... }) } }).`);
            }
            built[name] = { ...rest, per: key };
        }
        else {
            built[name] = per === undefined ? { ...rest } : { ...rest, per };
        }
    }
    for (const name of Object.keys(keys)) {
        if (policies[name]?.per !== "custom") {
            throw new Error(`LambderMockApp: a key handler was given for rate-limit policy "${name}", which the server ${name in policies ? "does not key by a handler" : "does not declare"}.`);
        }
    }
    return built;
};
