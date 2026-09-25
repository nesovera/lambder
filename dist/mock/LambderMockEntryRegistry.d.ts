import type { LambderMockEntry, LambderMockOverride, LambderMockRestEntry } from "./LambderMockTypes.js";
/**
 * Which mock answers an endpoint: the registered entries, and the overrides
 * standing over them.
 *
 * One of the four pieces of state LambderMockApp holds that nothing else
 * touches; the rest of the runtime reaches it only through a request's
 * lookup. The app keeps the caller-facing surface (register, registerPartial,
 * override, restoreOverrides, registeredNames) as delegations, because that
 * surface is contract-typed and its safety checks are compile-time; this
 * class holds the bookkeeping.
 *
 * Generic over the contract only so entries keep their type through the map;
 * the registry itself never reads one.
 */
export declare class LambderMockEntryRegistry<C> {
    private readonly entries;
    /**
     * The overrides standing over one endpoint, innermost last. A stack
     * rather than one slot because overrides nest: an override a describe
     * scopes and one an it scopes are both live, and restoring the inner one
     * has to uncover the outer rather than the registry.
     */
    private readonly overrideStacks;
    /** The reason register() was given a rest entry with; null while it was given none. */
    private restReason;
    /**
     * What a call to an endpoint no slice registered is refused with, or null
     * when no rest entry was registered. A registration like any other, so
     * reset() keeps it.
     */
    get restNotMockedReason(): string | null;
    /**
     * Adds every entry of every slice, and the rest entry where one is among
     * them. Everything is staged and committed together, so a failed check
     * leaves nothing behind: a caller that catches the error and retries sees
     * the problem it is fixing, not a duplicate-name error from its own first
     * attempt.
     */
    addSlices(slices: readonly (Record<string, LambderMockEntry<C, any>> | LambderMockRestEntry)[]): void;
    /** The registered entry for a name, before any override; null when there is none. */
    registered(apiName: string): LambderMockEntry<C, any> | null;
    /** Stacks an override over a registered entry and hands back its removal. */
    pushOverride(name: string, entry: LambderMockEntry<C, any>): LambderMockOverride;
    /** Puts every overridden handler back, however deeply they were stacked. */
    restoreOverrides(): void;
    /** The registered endpoint names. */
    get names(): string[];
    /** What answers this call: the innermost override, else the registered entry. */
    entryFor(apiName: string): LambderMockEntry<C, any> | null;
}
