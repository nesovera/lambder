import { assertGuardDeclaration } from "./LambderApiGuards.js";
import { assertRateLimitPolicyDeclaration } from "./LambderApiRateLimits.js";
import { mergeNamedMaps } from "../shared/util/LambderNamedMaps.js";
/** A record with no prototype, so a declaration named "__proto__" or "constructor" is a key like any other. */
const bareRecord = () => Object.create(null);
/**
 * A module's declarations from what defineApiModule() was given: each option
 * one map or a list of them, merged, a name two of a list's maps declare
 * refused; every guard and policy held to the rules the creation's are held
 * to. A module declaring nothing is refused, as an empty guards option is:
 * its builders would be the instance's own.
 */
export const apiModuleDeclarationsOf = (options, owner) => {
    const guards = bareRecord();
    const rateLimitPolicies = bareRecord();
    if (options.guards !== undefined) {
        for (const [name, guard] of Object.entries(mergeNamedMaps(options.guards, "guard", "defineApiModule()"))) {
            assertGuardDeclaration(name, guard);
            guards[name] = guard;
        }
    }
    if (options.rateLimitPolicies !== undefined) {
        for (const [name, policy] of Object.entries(mergeNamedMaps(options.rateLimitPolicies, "rate-limit policy", "defineApiModule()"))) {
            assertRateLimitPolicyDeclaration(name, policy);
            rateLimitPolicies[name] = policy;
        }
    }
    if (Object.keys(guards).length === 0 && Object.keys(rateLimitPolicies).length === 0) {
        throw new Error(owner === "Lambder"
            ? "Lambder: defineApiModule() was given no guard and no rate-limit policy, which declares nothing a module's endpoints could name " +
                "beyond the instance's own. Declare the module's guards or rate-limit policies, or declare its endpoints with the instance's builders."
            : "LambderMockApp: defineApiModule() was given no guard, which declares nothing a module's entries could name beyond the app's own. " +
                "Declare the module's mock guards, or build its entries with the app's own builders.");
    }
    return Object.freeze({ guards: Object.freeze(guards), rateLimitPolicies: Object.freeze(rateLimitPolicies) });
};
