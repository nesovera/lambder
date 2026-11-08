import type { z } from "zod";
import type { LambderApiContractShape } from "../shared/wire/LambderApiContract.js";
import type { LambderApiGuard } from "../api/LambderApiGuards.js";
import type { LambderRefusalVocabulary } from "../api/LambderApiRefusals.js";
import type { LambderMockGuardsAgree, LambderMockGuardShapes } from "./LambderMockCreateOptions.js";
import type { LambderMockCallContext, LambderMockEntry, LambderMockEntryGuardsCheck, LambderMockEntryInput, LambderMockGuardMapChecks, LambderMockHandler, LambderMockNotMockedGuardsCheck, LambderMockNotMockedInput, LambderMockOverride, LambderMockSessionCallContext, LambderMockSlice } from "./LambderMockTypes.js";
/**
 * What a mock app's defineApiModule() takes: the mock guards a part of the
 * app declares for its own endpoints, standing in for the guards the
 * server's module declares (its defineApiModule), as create()'s guards stand
 * in for the server instance's. One map.
 *
 * No rate-limit policies: a mock takes every policy at create(), from the
 * generated table the server writes (lambderMockPoliciesFrom), the module's
 * among them, so none is restated by hand here.
 */
export type LambderMockApiModuleOptions<S = any> = {
    /** The module's mock guards, one per guard the server's module declares, built with the mock init's guard(). */
    guards: Record<string, LambderApiGuard<any, any, any, LambderMockCallContext<S>, LambderMockSessionCallContext<S>>>;
};
/** A module's map held to declaring names of its own: one the mock app's create() declares is a compile error, and the property name is the message. */
type LambderMockModuleNamesCheck<MG, TAppNames> = [
    Extract<keyof MG, TAppNames>
] extends [never] ? unknown : {
    readonly "lambder: the mock app declares these guards already; a module declares guards of its own": Extract<keyof MG, TAppNames>;
};
/**
 * A module's mock guards held to what create()'s are held to: the contract,
 * the generated guard declarations when the app was given them, surplus
 * keys, and names of their own.
 */
export type LambderMockApiModuleChecks<C, S, G, D, TOptions extends LambderMockApiModuleOptions<S>> = {
    guards: LambderMockGuardMapChecks<C, S, TOptions["guards"]> & LambderMockGuardShapes<S, TOptions["guards"]> & LambderMockGuardsAgree<TOptions["guards"], D> & LambderMockModuleNamesCheck<TOptions["guards"], keyof G>;
};
/**
 * What a mock module asks of the app that made it: the app's own entry
 * builders, given the module's declarations. The constructor's parameter,
 * which the app's defineApiModule() passes; an app does not build one.
 */
export type LambderMockApiModuleDoor = {
    api: (name: string, entry: unknown) => LambderMockEntry<any, any>;
    notMocked: (name: string, input: unknown) => LambderMockEntry<any, any>;
    apiSlice: (...entries: readonly LambderMockEntry<any, any>[]) => unknown;
    override: (name: string, handler: unknown) => LambderMockOverride;
};
/**
 * A part of a mock app with mock guards of its own: the app's entry builders,
 * typed with the module's guards beside the app's. Made by the mock app's
 * defineApiModule(); its entries are registered as any are (register,
 * registerPartial), and registering them adds the module's guards to the
 * app, refusing a name the app or another module declares. The mock twin of
 * the server's LambderApiModule, so a module's mock guards are declared with
 * the module's mocks, and the app's own setup imports none of them.
 *
 * `G` is the app's guards and the module's together, which is what the
 * entries' handlers read guardData by.
 */
export declare class LambderMockApiModule<C extends LambderApiContractShape, S = any, G extends Record<string, LambderApiGuard<any, any, any>> = {}, TDerived extends boolean = false, TVocabulary extends LambderRefusalVocabulary = never, TCodesRequired extends boolean = false> {
    private readonly door;
    constructor(door: LambderMockApiModuleDoor);
    /** A mock for one of the module's endpoints, as the app's api() builds one: its guards may be the app's and the module's own. */
    api<K extends keyof C & string, TInputSchema extends z.ZodType = z.ZodType>(name: K & LambderMockEntryGuardsCheck<C, K, G, TDerived>, entry: LambderMockEntryInput<C, K, S, G, TInputSchema, TDerived, TVocabulary, TCodesRequired>): LambderMockEntry<C, K>;
    /** One of the module's endpoints deliberately left without a mock, as the app's notMocked() builds one; its restated guards may name the module's. */
    notMocked<K extends keyof C & string>(name: K & LambderMockNotMockedGuardsCheck<C, K, G, TDerived>, input: LambderMockNotMockedInput<C, K, TDerived>): LambderMockEntry<C, K>;
    /** The entries of one slice, keyed by name, as the app's apiSlice() gathers them. */
    apiSlice<const E extends readonly LambderMockEntry<C, keyof C & string>[]>(...entries: E): LambderMockSlice<C, E[number]["name"]>;
    /** Replaces one of the module's registered handlers until restored, as the app's override() does, its guardData typed with the module's guards. */
    override<K extends keyof C & string>(name: K, handler: LambderMockHandler<C, K, S, G, TVocabulary, TCodesRequired>): LambderMockOverride;
}
export {};
