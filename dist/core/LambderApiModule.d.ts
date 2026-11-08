import type { LambderAppTypes, LambderPlainAppTypes } from "../api/LambderApiDeclarations.js";
import type { LambderApiModuleDeclarations } from "../api/LambderApiModules.js";
import type { LambderGuardMetaMap } from "../api/LambderApiGuards.js";
import type { LambderApiRateLimitPolicyConfig } from "../api/LambderApiRateLimits.js";
import type { LambderMergedNamedMaps, LambderNamedMapsOption } from "../shared/util/LambderNamedMaps.js";
import { type LambderDefineApi, type LambderDefineApiGroup, type LambderDefineLazyApiGroup } from "./LambderApiBuilders.js";
import type { LambderGivenOption, LambderGuardChecks, LambderGuardsMap, LambderRateLimitPoliciesMap, LambderRateLimitPolicyChecks } from "./LambderCreateOptions.js";
/**
 * What defineApiModule() takes: the guards and the rate-limit policies a
 * module declares for its own endpoints, each one map or a list of maps, as
 * create() takes its own. The guards are pinned to the app's session type,
 * as create()'s are.
 */
export type LambderApiModuleOptions<TSessionData = any> = {
    /** The module's guards, which its endpoints name beside the instance's: one map, or a list of maps merged in order. */
    guards?: LambderNamedMapsOption<LambderGuardsMap<TSessionData>>;
    /** The module's rate-limit policies, counted on the instance's limiter, which its endpoints name beside the instance's: one map, or a list of maps merged in order. */
    rateLimitPolicies?: LambderNamedMapsOption<LambderRateLimitPoliciesMap>;
};
/** Every name a map, or each map of a list, declares. */
type LambderNamesDeclaredBy<TMaps> = TMaps extends readonly unknown[] ? {
    [TIndex in keyof TMaps]: keyof TMaps[TIndex];
}[number] : keyof TMaps;
/** A module's map held to declaring names of its own: one the instance declares is a compile error, and the property name is the message. */
type LambderModuleNamesCheck<TMaps, TInstanceNames> = [
    Extract<LambderNamesDeclaredBy<TMaps>, TInstanceNames>
] extends [never] ? unknown : {
    readonly "lambder: the instance declares these names already; a module declares names of its own": Extract<LambderNamesDeclaredBy<TMaps>, TInstanceNames>;
};
/**
 * defineApiModule()'s options held to what create() holds its own to, one
 * level down (each guard and each policy checked for surplus keys, a guard's
 * refusal codes held to the vocabulary, a name two maps of a list declare
 * refused), and to declaring no name the instance declares.
 */
export type LambderApiModuleOptionChecks<TApp extends LambderAppTypes, TOptions extends LambderApiModuleOptions<TApp["session"]>> = {
    guards?: LambderGuardChecks<TApp["session"], NonNullable<LambderGivenOption<TOptions, "guards">>, TApp["refusals"]> & LambderModuleNamesCheck<NonNullable<LambderGivenOption<TOptions, "guards">>, keyof TApp["guards"]>;
    rateLimitPolicies?: LambderRateLimitPolicyChecks<NonNullable<LambderGivenOption<TOptions, "rateLimitPolicies">>> & LambderModuleNamesCheck<NonNullable<LambderGivenOption<TOptions, "rateLimitPolicies">>, keyof TApp["policies"]>;
} & LambderModuleDeclaresSomething<TOptions>;
/**
 * A module declaring neither guards nor policies, refused as an empty guards
 * option is: its builders would be the instance's own. The property name is
 * the message.
 */
type LambderModuleDeclaresSomething<TOptions> = [
    LambderGivenOption<TOptions, "guards"> | LambderGivenOption<TOptions, "rateLimitPolicies">
] extends [undefined] ? {
    readonly "lambder: a module declares guards or rate-limit policies of its own; one with neither declares its endpoints with the instance's builders": never;
} : unknown;
/** One map from what a module option was given: a list merged, a lone map as it is, nothing for an option left out. */
type LambderModuleMap<TOption> = [TOption] extends [undefined] ? {} : LambderMergedNamedMaps<TOption>;
/**
 * The app types a module's builders are typed on: the instance's, with the
 * module's guards and rate-limit policies beside the instance's own. Its
 * endpoints name either, and nothing else.
 */
export type LambderModuleAppTypes<TApp extends LambderAppTypes, TGuards, TPolicies> = {
    session: TApp["session"];
    policies: TApp["policies"] & (LambderModuleMap<TPolicies> extends infer TMerged extends Record<string, LambderApiRateLimitPolicyConfig> ? TMerged : {});
    guards: TApp["guards"] & LambderGuardMetaMap<LambderModuleMap<TGuards>>;
    idempotency: TApp["idempotency"];
    guardsRequired: TApp["guardsRequired"];
    sessions: TApp["sessions"];
    refusals: TApp["refusals"];
    refusalCodesRequired: TApp["refusalCodesRequired"];
};
/**
 * A part of an app with guards and rate-limit policies of its own, for its
 * own endpoints: the declaration builders typed on its instance's types with
 * the module's guards and policies beside the instance's. Made by an
 * instance's defineApiModule(); its endpoints are registered on the instance
 * as any are (registerApiGroups), and their registration adds the module's
 * guards and policies to the instance, refusing a name the instance or
 * another module declares.
 *
 * So an app's core creates its instance knowing only its own policies, and
 * each module brings its own: nothing has to import every module's guards
 * before the instance can exist. Hand the builders out under the module's
 * name, as an instance's are:
 *
 * ```typescript
 * export const giftCardModule = storeApp.defineApiModule({ guards: { cardHolder }, rateLimitPolicies: { redeemPerCard } });
 * export type GiftCardModule = typeof giftCardModule;
 * export const defineApi: GiftCardModule["defineApi"] = giftCardModule.defineApi;
 * ```
 *
 * @typeParam TApp - @internal The module's app types (LambderModuleAppTypes): the instance's, widened by the module's guards and policies (do not pass manually)
 */
export declare class LambderApiModule<TApp extends LambderAppTypes = LambderPlainAppTypes> {
    /**
     * Type property for the module's app types, as an instance's AppTypes
     * is: what LambderRenderContextOf<typeof module> reads, for a helper
     * handed one of the module's handler contexts, its policies typed. It
     * has no value.
     */
    readonly AppTypes: TApp;
    /** Declares one of the module's endpoints: its guards and rate limits may name the instance's and the module's own. */
    readonly defineApi: LambderDefineApi<TApp>;
    /** Gathers endpoints into a named group, as the instance's does. */
    readonly defineApiGroup: LambderDefineApiGroup;
    /** A group of the module's loaded on the first call to it, carrying the module, so its guards and policies are added when the group is registered. */
    readonly lazyApiGroup: LambderDefineLazyApiGroup;
    /** Called by an instance's defineApiModule(), with the declarations it checked; an app does not construct one. */
    constructor(declarations: LambderApiModuleDeclarations);
}
export {};
