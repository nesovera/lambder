import type { z } from "zod";
import type { LambderRenderContext, LambderSessionRenderContext } from "./LambderContext.js";
import type { LambderObjectOutputCheck, LambderPayloadSliceCheck, LambderRequirableGuardsField } from "./LambderCreateOptions.js";
import type { LambderReadonlyDeep, LambderMaybePromise } from "../shared/util/LambderTypeUtilities.js";
import type { LambderDeclaredRefuse } from "../shared/wire/LambderApiRefusal.js";
import type { LambderApiIdempotencyOption } from "../shared/wire/LambderApiOptionValues.js";
import type { LambderContractEntry, LambderJsonOf } from "../shared/wire/LambderApiContract.js";
import type { LambderGuardDataOf, LambderGuardInputsOf, LambderGuardRefusalNamesOf, LambderGuardsOption } from "../api/LambderApiGuards.js";
import type { LambderRateLimitOption } from "../api/LambderApiRateLimits.js";
import type { LambderHandlerRefusalsOf, LambderRefusalNamesIn, LambderRefusalsOption, LambderWireRefusalsOf } from "../api/LambderApiRefusals.js";
import type { LambderApiModuleDeclarations } from "../api/LambderApiModules.js";
import { type LambderActionNamesCheck, type LambderApiDeclaration, type LambderApiDeclarations, type LambderApiGroup, type LambderApiModeOf, type LambderAppTypes, type LambderGroupNameCheck, type LambderGroupPartsCheck, type LambderLazyApiGroup, type LambderMergedParts, type LambderPublicSessionPolicyCheck, type LambderSessionModeCheck } from "../api/LambderApiDeclarations.js";
/** The codes one API may refuse with, typed: its own refusals option's and its declared guards', as the vocabulary holds them. */
export type LambderApiRefusalCodes<TVocabulary, TGuards, TRefusalsOpt, TGuardsOpt> = (LambderRefusalNamesIn<TRefusalsOpt> | LambderGuardRefusalNamesOf<TGuards, TGuardsOpt>) & keyof TVocabulary & string;
/**
 * What an endpoint's handler is handed: the session context when one of its
 * guards needs a session (so ctx.session is typed present), the plain one
 * otherwise, with the payload, the guards' data and a refuse() typed to the
 * codes the endpoint may refuse with.
 */
export type LambderApiHandlerContext<TApp extends LambderAppTypes, TPayload, TGuardsOpt, TRefusalsOpt> = (LambderApiModeOf<TApp["guards"], TGuardsOpt> extends "session" ? LambderSessionRenderContext<TPayload, TApp["session"], Record<string, string>, LambderGuardDataOf<TApp["guards"], TGuardsOpt>, TApp["policies"]> : LambderRenderContext<TPayload, Record<string, string>, LambderGuardDataOf<TApp["guards"], TGuardsOpt>, TApp["session"], TApp["policies"]>) & {
    refuse: LambderDeclaredRefuse<LambderHandlerRefusalsOf<TApp["refusals"], LambderApiRefusalCodes<TApp["refusals"], TApp["guards"], TRefusalsOpt, TGuardsOpt>>, TApp["refusalCodesRequired"]>;
};
/**
 * Declares one endpoint, typed on one set of app types: its input and output
 * schemas, its guards, rate limits, idempotency and refusals, and its
 * handler. Nothing is registered until the declaration is put in a group
 * (defineApiGroup) and the group is registered (registerApiGroups).
 *
 * The guards say who may call it, and so its mode: an endpoint whose guards
 * include one that needs a session (`session: true`) is a session endpoint,
 * its session read before the guards run and a call without one answered
 * sessionExpired, and its handler's ctx.session is typed present. Any other
 * endpoint is public.
 */
export type LambderDefineApi<TApp extends LambderAppTypes> = <TInput extends z.ZodType, TOutput extends z.ZodType, const TAnswer extends LambderReadonlyDeep<z.input<TOutput>>, const TRateOpt extends LambderRateLimitOption<TApp["policies"]> = never, const TGuardsOpt extends LambderGuardsOption<TApp["guards"]> = never, const TIdempotencyOpt extends LambderApiIdempotencyOption = never, const TRefusalsOpt extends LambderRefusalsOption<TApp["refusals"]> = never>(options: {
    input: TInput;
    output: TOutput;
} & {
    /** Named rate limits, checked in declared order within their phase (per ip before the session read, per session before the guards, a custom key after the guards and input validation): a name, a list of names, or a { name: true | override } map (windows overridable on perApi budgets, refusal on any). The first exceeded one refuses (429 envelope + Retry-After); attempts count on every counter checked before it. A per-session policy needs one of the endpoint's guards to need a session. */
    rateLimit?: TRateOpt;
    /** Replay-protect this API per client idempotencyKey. Requires the idempotency option at creation. */
    idempotency?: TApp["idempotency"] extends true ? TIdempotencyOpt : never;
    /**
     * The refusal codes this API may refuse with, from the vocabulary given at creation: one code or a
     * non-empty list. Its guards' codes join them. The handler raises one with `ctx.refuse(content, { code, data })`,
     * its callers narrow on them, and a refusal with any other code is a crash rather than an answer.
     */
    refusals?: TRefusalsOpt;
    /**
     * Whether this API's answers are compressed for a caller that accepts it: "auto" (the default) when the
     * body is large enough to gain, false never, true always. false suits an answer of base64 bytes: once
     * compressed it leaves the function base64-encoded again, so it is no smaller under Lambda's response
     * cap or to a lambda caller, and a browser gets it only about a quarter smaller for the time spent at
     * both ends. A transport setting of this server's, not part of the API's contract.
     */
    compress?: boolean | "auto";
} & LambderRequirableGuardsField<TApp["guardsRequired"], TGuardsOpt> & LambderObjectOutputCheck<TOutput> & LambderPayloadSliceCheck<TApp["guards"], TApp["policies"], TGuardsOpt, TRateOpt, z.input<TInput>> & LambderPublicSessionPolicyCheck<LambderApiModeOf<TApp["guards"], TGuardsOpt>, TApp["policies"], TRateOpt> & LambderSessionModeCheck<LambderApiModeOf<TApp["guards"], TGuardsOpt>, TApp["sessions"]>, 
/** Answers the call by returning its output (parsed through `output` before it is sent), or refuses it with ctx.refuse() or refuse(). */
handler: (ctx: LambderApiHandlerContext<TApp, z.infer<TInput>, TGuardsOpt, TRefusalsOpt>) => LambderMaybePromise<TAnswer>) => LambderApiDeclaration<LambderContractEntry<z.input<TInput>, LambderJsonOf<z.output<TOutput>>, LambderApiModeOf<TApp["guards"], TGuardsOpt>, LambderGuardInputsOf<TApp["guards"], TGuardsOpt>, TGuardsOpt, TRateOpt, TIdempotencyOpt, LambderWireRefusalsOf<TApp["refusals"], LambderApiRefusalCodes<TApp["refusals"], TApp["guards"], TRefusalsOpt, TGuardsOpt>>>>;
/**
 * Gathers endpoints into a named group: each is registered as `name.action`
 * and called at `{apiPath}/{name}/{action}`, and every Lambder caller
 * reaches it as `caller.name.action(input)`. A group's name and its actions
 * are identifiers, and a group may not take a name a caller already answers
 * for (see LAMBDER_RESERVED_GROUP_NAMES).
 *
 * A group declared across files takes each file's part:
 * `defineApiGroup("orders", orderReadApis, orderWriteApis)`. An action two
 * parts declare is refused, at compile time and at startup, rather than one
 * silently replacing the other as an object spread would. Endpoints a
 * module's builders declared may sit in any group: registering it adds
 * their module.
 */
export type LambderDefineApiGroup = <const TName extends string, const TParts extends readonly [LambderApiDeclarations, ...LambderApiDeclarations[]]>(name: TName & LambderGroupNameCheck<TName>, ...parts: TParts & LambderGroupPartsCheck<TParts> & {
    [TIndex in keyof TParts]: LambderActionNamesCheck<TParts[TIndex]>;
}) => LambderApiGroup<TName, LambderMergedParts<TParts>>;
/**
 * A group loaded on the first call to one of its endpoints:
 * `lazyApiGroup("orders", () => import("./orders.js").then((m) => m.orderApis))`.
 * A cold start then parses none of it, nor anything only it imports, until
 * a request calls it; the contract is the loaded group's, read off its type.
 * The group loaded must carry the same name, which the type checks and
 * loading checks again. `loadApiGroups()` loads every group, for a build
 * step or a boot check that has to see them all.
 *
 * A module's lazyApiGroup carries the module, so its guards and policies
 * are added when the group is registered, at startup, rather than when it
 * loads; a group whose endpoints a module's builders declared is registered
 * lazily with that module's.
 */
export type LambderDefineLazyApiGroup = <const TName extends string, TGroup extends LambderApiGroup<TName, any>>(name: TName & LambderGroupNameCheck<TName>, load: () => Promise<TGroup>) => LambderLazyApiGroup<TName, NoInfer<TGroup>>;
/** The three builders, typed on one set of app types. */
export type LambderApiBuilders<TApp extends LambderAppTypes> = {
    readonly defineApi: LambderDefineApi<TApp>;
    readonly defineApiGroup: LambderDefineApiGroup;
    readonly lazyApiGroup: LambderDefineLazyApiGroup;
};
/**
 * The builders as values: the instance's own (module null), or a module's,
 * whose endpoints and lazy groups carry the module for registration to add.
 * Plain functions closing over nothing else, so an app may hand them out
 * detached.
 */
export declare const apiBuildersFor: <TApp extends LambderAppTypes>(module: LambderApiModuleDeclarations | null) => LambderApiBuilders<TApp>;
