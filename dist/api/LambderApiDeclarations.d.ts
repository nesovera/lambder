import type { z } from "zod";
import type { MaybePromise } from "../shared/util/LambderTypeUtilities.js";
import type { LambderApiMode, LambderGuardNamesIn } from "../shared/wire/LambderApiContract.js";
import type { LambderApiIdempotencyOption, LambderGuardsOptionValue, LambderRateLimitOptionValue, LambderRefusalsOptionValue } from "../shared/wire/LambderApiOptionValues.js";
import type { LambderApiRateLimitPolicyConfig, LambderPolicyPerOf } from "./LambderApiRateLimits.js";
import type { LambderRefusalVocabulary } from "./LambderApiRefusals.js";
import { type LambderReservedActionName, type LambderReservedGroupName } from "../shared/wire/LambderApiNames.js";
/**
 * What an instance's declarations are typed against, fixed at create(): the
 * session data, the rate-limit policies, the guards (as LambderGuardMetaMap
 * records them), whether idempotency is configured, whether every endpoint
 * must declare a guard, whether sessions are configured, and the refusal
 * vocabulary with whether every refusal must name a code.
 */
export type LambderAppTypes = {
    session: unknown;
    policies: Record<string, LambderApiRateLimitPolicyConfig>;
    guards: Record<string, any>;
    idempotency: boolean;
    guardsRequired: boolean;
    sessions: boolean;
    refusals: LambderRefusalVocabulary;
    refusalCodesRequired: boolean;
};
/** The types of an instance built without create(): no policies, guards or vocabulary, sessions allowed. */
export type LambderPlainAppTypes<TSession = any> = {
    session: TSession;
    policies: {};
    guards: {};
    idempotency: false;
    guardsRequired: false;
    sessions: true;
    refusals: {};
    refusalCodesRequired: false;
};
/** The guards among the names an endpoint declares that need a session (`session: true`). */
export type LambderSessionGuardNamesIn<TGuards, TGuardsOpt> = {
    [K in LambderGuardNamesIn<TGuardsOpt> & keyof TGuards]: TGuards[K] extends {
        session: true;
    } ? K : never;
}[LambderGuardNamesIn<TGuardsOpt> & keyof TGuards];
/**
 * An endpoint's mode, from the guards it declares: "session" when any of
 * them needs a session, "public" otherwise. The guard is the one place the
 * endpoint says who may call it, and a session is part of that answer, so
 * nothing else states the mode and nothing can disagree with it.
 */
export type LambderApiModeOf<TGuards, TGuardsOpt> = [
    LambderSessionGuardNamesIn<TGuards, TGuardsOpt>
] extends [never] ? "public" : "session";
/** The per-session policies among the names an endpoint's rateLimit option declares. */
type LambderSessionPolicyNamesIn<TPolicies, TRateOpt> = {
    [K in LambderGuardNamesIn<TRateOpt> & keyof TPolicies]: [LambderPolicyPerOf<TPolicies[K]>] extends ["session"] ? K : never;
}[LambderGuardNamesIn<TRateOpt> & keyof TPolicies];
/**
 * A public endpoint's per-session rate limits, refused on the option: a
 * public call carries no session to count against. The property name is the
 * message and its value the policies at fault.
 */
export type LambderPublicSessionPolicyCheck<TMode extends LambderApiMode, TPolicies, TRateOpt> = TMode extends "session" ? unknown : [LambderSessionPolicyNamesIn<TPolicies, TRateOpt>] extends [never] ? unknown : {
    rateLimit: {
        readonly "lambder: these rate limits count per session, and none of this API's guards needs a session": LambderSessionPolicyNamesIn<TPolicies, TRateOpt>;
    };
};
/** What a session endpoint needs of its instance: sessions configured at create(). */
type LambderSessionsConfigured = {
    readonly "lambder: a guard of this API needs a session, and sessions are not configured on this instance. Pass the session option to create().": never;
};
/** A session endpoint on an instance without sessions, refused where it is declared. */
export type LambderSessionModeCheck<TMode extends LambderApiMode, TSessions extends boolean> = TMode extends "session" ? (TSessions extends true ? unknown : LambderSessionsConfigured) : unknown;
/** One endpoint's options as registration reads them. */
export type LambderApiDeclarationOptions = {
    input: z.ZodType;
    output: z.ZodType;
    guards?: LambderGuardsOptionValue;
    rateLimit?: LambderRateLimitOptionValue;
    idempotency?: LambderApiIdempotencyOption;
    refusals?: LambderRefusalsOptionValue;
    compress?: boolean | "auto";
};
/** The key the contract entry of a declaration is typed under. It exists only in types: nothing reads or writes it. */
declare const LAMBDER_CONTRACT_ENTRY: unique symbol;
/**
 * One endpoint, declared: its options and its handler, and in its type the
 * contract entry a client calls it by. Built by an instance's defineApi(),
 * registered by being put in a group.
 */
export type LambderApiDeclaration<TEntry = unknown> = {
    readonly kind: "lambderApi";
    readonly options: LambderApiDeclarationOptions;
    readonly handler: (ctx: never) => MaybePromise<unknown>;
    readonly [LAMBDER_CONTRACT_ENTRY]: TEntry;
};
/** A group's endpoints by action name. */
export type LambderApiDeclarations = Record<string, LambderApiDeclaration<any>>;
/** A group of endpoints: `name.action` for each of its actions. Built by defineApiGroup(). */
export type LambderApiGroup<TName extends string = string, TApis extends LambderApiDeclarations = LambderApiDeclarations> = {
    readonly kind: "lambderApiGroup";
    readonly name: TName;
    readonly apis: TApis;
};
/**
 * A group loaded on the first call to one of its endpoints: its name, and
 * how to load it. Built by lazyApiGroup(). What a cold start parses then
 * leaves out every group no request has called yet.
 */
export type LambderLazyApiGroup<TName extends string = string, TGroup extends LambderApiGroup<TName, any> = LambderApiGroup<TName, any>> = {
    readonly kind: "lambderLazyApiGroup";
    readonly name: TName;
    readonly load: () => Promise<TGroup>;
};
/** Either kind of group registerApiGroups() takes. */
export type LambderRegistrableApiGroup = LambderApiGroup<string, any> | LambderLazyApiGroup<string, any>;
/** A declaration's contract entry. */
export type LambderEntryOf<TDeclaration> = TDeclaration extends {
    readonly [LAMBDER_CONTRACT_ENTRY]: infer TEntry;
} ? TEntry : never;
type LambderLoadedGroupOf<TGroup> = TGroup extends LambderLazyApiGroup<string, infer TLoaded> ? TLoaded : TGroup;
/**
 * One group's part of the contract: `group.action` for each action, its
 * declaration's entry. Distributed over a union of groups (the `TGroup
 * extends unknown`), so each group is read on its own: read as one union,
 * the actions would be only those every group shares.
 */
type LambderGroupContract<TGroup> = TGroup extends unknown ? (LambderLoadedGroupOf<TGroup> extends LambderApiGroup<infer TName, infer TApis> ? {
    [TAction in keyof TApis & string as `${TName}.${TAction}`]: LambderEntryOf<TApis[TAction]>;
} : never) : never;
type LambderUnionToIntersection<TUnion> = (TUnion extends unknown ? (value: TUnion) => void : never) extends (value: infer TIntersection) => void ? TIntersection : never;
/** The contract of every group registered together, as one flat object type keyed by endpoint name. */
export type LambderContractOfGroups<TGroups extends readonly unknown[]> = LambderUnionToIntersection<LambderGroupContract<TGroups[number]>> extends infer TMerged ? {
    [TName in keyof TMerged]: TMerged[TName];
} : never;
/**
 * Whether a group, the group a lazy one loads, or that group's endpoints is
 * typed any. A part typed any, merged with the rest, comes out as an index
 * signature rather than as any, and no group declared action by action has
 * one, so that counts too.
 */
type LambderGroupTypedAny<TGroup> = 0 extends 1 & TGroup ? true : 0 extends 1 & LambderLoadedGroupOf<TGroup> ? true : LambderLoadedGroupOf<TGroup> extends {
    readonly apis: infer TApis;
} ? (0 extends 1 & TApis ? true : string extends keyof TApis ? true : false) : false;
/** The group names one registerApiGroups() call names twice. */
type LambderRepeatedGroupNames<TGroups extends readonly unknown[], TSeen = never> = TGroups extends readonly [infer THead, ...infer TRest] ? (THead extends {
    name: infer TName;
} ? ([TName] extends [TSeen] ? TName : never) | LambderRepeatedGroupNames<TRest, TSeen | TName> : never) : never;
/**
 * What registerApiGroups() asks of its receiver: the instance itself, unless
 * a group, what a lazy group loads or a group's endpoints is typed `any` (a
 * module whose types were lost would otherwise make its endpoints `any` to
 * every client) or a group name is given twice (two
 * groups of one name would be one namespace with two owners). Then it asks
 * for an object no instance is, whose property name is the message, so the
 * call is refused where it is written.
 */
export type LambderRegisteredGroupsCheck<TGroups extends readonly unknown[], TSelf> = true extends {
    [TIndex in keyof TGroups]: LambderGroupTypedAny<TGroups[TIndex]>;
}[number] ? {
    readonly "lambder: a group given to registerApiGroups, what a lazy group loads, or a group's endpoints is typed any, which would make its part of the contract any. Build it with defineApiGroup() and let its type through.": never;
} : [LambderRepeatedGroupNames<TGroups>] extends [never] ? TSelf : {
    readonly "lambder: these group names are registered twice": LambderRepeatedGroupNames<TGroups>;
};
/** A group's name held to the rule a caller's properties need. */
export type LambderGroupNameCheck<TName extends string> = TName extends LambderReservedGroupName ? {
    readonly "lambder: a caller already has a member of this name, so no group may take it": TName;
} : unknown;
/** The actions more than one of a group's parts declare. */
type LambderRepeatedActions<TParts extends readonly unknown[], TSeen = never> = TParts extends readonly [infer THead, ...infer TRest] ? (Extract<keyof THead, TSeen> | LambderRepeatedActions<TRest, TSeen | keyof THead>) : never;
/** A group's parts held to declaring each action once: a part would otherwise replace another's endpoint of the same name. */
export type LambderGroupPartsCheck<TParts extends readonly unknown[]> = [
    LambderRepeatedActions<TParts>
] extends [never] ? unknown : {
    readonly "lambder: these actions are declared by more than one part of the group": LambderRepeatedActions<TParts>;
};
/** One group's endpoints, from the parts it was declared in. */
export type LambderMergedParts<TParts extends readonly unknown[]> = LambderUnionToIntersection<TParts[number]> extends infer TMerged ? {
    [TAction in keyof TMerged]: TMerged[TAction];
} : never;
/** A group's action names held to the rule the functions a caller hands out need. */
export type LambderActionNamesCheck<TApis> = [
    Extract<keyof TApis, LambderReservedActionName>
] extends [never] ? unknown : {
    readonly "lambder: a function already has a member of these names, so no action may take them": Extract<keyof TApis, LambderReservedActionName>;
};
/**
 * Builds a group from its parts, refusing a name no caller could carry, an
 * action two parts declare, and a value that is not an endpoint. A group is
 * usually one part; one declared across files gives each file's part.
 */
export declare const buildApiGroup: <TName extends string, TApis extends LambderApiDeclarations>(name: TName, parts: readonly LambderApiDeclarations[]) => LambderApiGroup<TName, TApis>;
/** Builds a lazy group; the name is checked here, the group it loads when it loads. */
export declare const buildLazyApiGroup: <TName extends string, TGroup extends LambderApiGroup<TName, any>>(name: TName, load: () => Promise<TGroup>) => LambderLazyApiGroup<TName, TGroup>;
/** Whether a value is either kind of group registerApiGroups() takes. */
export declare const isRegistrableApiGroup: (value: unknown) => value is LambderRegistrableApiGroup;
export {};
