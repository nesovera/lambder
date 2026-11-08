import { assertGuardDeclaration, type LambderApiGuard } from "./LambderApiGuards.js";
import { assertRateLimitPolicyDeclaration, type LambderApiRateLimitPolicyConfig } from "./LambderApiRateLimits.js";
import { mergeNamedMaps, type LambderNamedMapsOption } from "../shared/util/LambderNamedMaps.js";

// -----------------------------------------------------------------------------
// Modules: the guards and rate-limit policies a part of an app declares for
// its own endpoints, beside the ones its instance was created with. An app
// defines a module on its instance (defineApiModule), declares the module's
// endpoints with the builders it hands back, and registers their groups as
// any other; registration finds the module on them and adds what it declares
// to the instance, refusing a name the instance or another module declares.
// The server and the mock runtime both read modules this way, through the
// pipeline, so the rule and its messages are one.
// -----------------------------------------------------------------------------

/** One map of guards, of either adapter's contexts. */
type LambderModuleGuards = Readonly<Record<string, LambderApiGuard<any, any, any, any, any>>>;

/** One map of rate-limit policies, of either adapter's contexts. */
type LambderModulePolicies = Readonly<Record<string, LambderApiRateLimitPolicyConfig<any>>>;

/**
 * What a module declares, as registration adds it: its guards and its
 * rate-limit policies, merged into one map each. One object per module, made
 * once by defineApiModule() and carried by every endpoint its builders
 * declare and every lazy group its lazyApiGroup registers: the object is how
 * a registration finds a module and tells two apart.
 */
export type LambderApiModuleDeclarations = {
    readonly guards: LambderModuleGuards;
    readonly rateLimitPolicies: LambderModulePolicies;
};

/** A module a registration brings, and where it was met, for the error naming a name two declare. */
export type LambderApiModuleUse = {
    readonly module: LambderApiModuleDeclarations;
    /** How the error names the module: "declaring group \"orders\"", say. */
    readonly usedBy: string;
};

/**
 * The modules one registration adds, checked against what the instance
 * declares and against each other, their declarations merged. Registration
 * checks every endpoint against these and the instance's own before the
 * pipeline takes them (LambderApiPipeline.addModules), so a refused
 * registration leaves the instance as it was.
 */
export type LambderAddedApiModules = {
    readonly modules: readonly LambderApiModuleDeclarations[];
    readonly guards: LambderModuleGuards;
    readonly rateLimitPolicies: LambderModulePolicies;
};

/** What a registration checks an endpoint's names against beside the instance's own: the declarations of the modules it is adding, or of the one module building an entry. */
export type LambderPendingDeclarations = Pick<LambderAddedApiModules, "guards" | "rateLimitPolicies">;

/** A record with no prototype, so a declaration named "__proto__" or "constructor" is a key like any other. */
const bareRecord = <TValue>(): Record<string, TValue> => Object.create(null) as Record<string, TValue>;

/**
 * A module's declarations from what defineApiModule() was given: each option
 * one map or a list of them, merged, a name two of a list's maps declare
 * refused; every guard and policy held to the rules the creation's are held
 * to. A module declaring nothing is refused, as an empty guards option is:
 * its builders would be the instance's own.
 */
export const apiModuleDeclarationsOf = (options: {
    guards?: LambderNamedMapsOption<LambderModuleGuards>;
    rateLimitPolicies?: LambderNamedMapsOption<LambderModulePolicies>;
}, owner: "Lambder" | "LambderMockApp"): LambderApiModuleDeclarations => {
    const guards = bareRecord<LambderApiGuard<any, any, any, any, any>>();
    const rateLimitPolicies = bareRecord<LambderApiRateLimitPolicyConfig<any>>();
    if(options.guards !== undefined){
        for(const [name, guard] of Object.entries(mergeNamedMaps(options.guards, "guard", "defineApiModule()"))){
            assertGuardDeclaration(name, guard);
            guards[name] = guard;
        }
    }
    if(options.rateLimitPolicies !== undefined){
        for(const [name, policy] of Object.entries(mergeNamedMaps(options.rateLimitPolicies, "rate-limit policy", "defineApiModule()"))){
            assertRateLimitPolicyDeclaration(name, policy);
            rateLimitPolicies[name] = policy;
        }
    }
    if(Object.keys(guards).length === 0 && Object.keys(rateLimitPolicies).length === 0){
        throw new Error(owner === "Lambder"
            ? "Lambder: defineApiModule() was given no guard and no rate-limit policy, which declares nothing a module's endpoints could name " +
                "beyond the instance's own. Declare the module's guards or rate-limit policies, or declare its endpoints with the instance's builders."
            : "LambderMockApp: defineApiModule() was given no guard, which declares nothing a module's entries could name beyond the app's own. " +
                "Declare the module's mock guards, or build its entries with the app's own builders.");
    }
    return Object.freeze({ guards: Object.freeze(guards), rateLimitPolicies: Object.freeze(rateLimitPolicies) });
};
