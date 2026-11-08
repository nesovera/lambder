import { type LambderApiGuard } from "./LambderApiGuards.js";
import { type LambderApiRateLimitPolicyConfig } from "./LambderApiRateLimits.js";
import { type LambderNamedMapsOption } from "../shared/util/LambderNamedMaps.js";
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
/**
 * A module's declarations from what defineApiModule() was given: each option
 * one map or a list of them, merged, a name two of a list's maps declare
 * refused; every guard and policy held to the rules the creation's are held
 * to. A module declaring nothing is refused, as an empty guards option is:
 * its builders would be the instance's own.
 */
export declare const apiModuleDeclarationsOf: (options: {
    guards?: LambderNamedMapsOption<LambderModuleGuards>;
    rateLimitPolicies?: LambderNamedMapsOption<LambderModulePolicies>;
}, owner: "Lambder" | "LambderMockApp") => LambderApiModuleDeclarations;
export {};
