/**
 * Which of register()'s arguments is the rest entry rather than a slice.
 *
 * Read off the one field restNotMocked() writes, which is also why that field
 * is named as it is: a slice is keyed by endpoint names holding entries, so
 * what tells the two apart has to be a key no endpoint name plausibly is,
 * carrying a value no entry is.
 */
const isRestNotMockedEntry = (slice) => typeof slice.restNotMockedReason === "string";
/**
 * Which mock answers an endpoint: the registered entries, and the overrides
 * standing over them.
 *
 * One of the four pieces of state LambderMockApp holds that nothing else
 * touches; it meets the rest of the runtime at one call, the lookup a request
 * makes. The app keeps the whole caller-facing surface (register,
 * registerPartial, override, restoreOverrides, registeredNames) as
 * delegations, because that surface is contract-typed and the checks that
 * make it safe are compile-time; what lives here is the bookkeeping.
 *
 * Generic over the contract only so the entries keep their type through the
 * map; the registry itself never reads one.
 */
export class LambderMockEntryRegistry {
    entries = new Map();
    /**
     * The overrides standing over one endpoint, innermost last. A stack
     * rather than one slot because overrides nest: an override a describe
     * scopes and one an it scopes are both live, and restoring the inner one
     * has to uncover the outer rather than the registry.
     */
    overrideStacks = new Map();
    /** The reason register() was given a rest entry with; null while it was given none. */
    restReason = null;
    /**
     * What a call to an endpoint no slice registered is refused with, or null
     * when no rest entry was registered. A registration like any other, so
     * reset() keeps it.
     */
    get restNotMockedReason() {
        return this.restReason;
    }
    /**
     * Adds every entry of every slice, and the rest entry where one is among
     * them. Slices are staged and committed together, so a slice that fails a
     * check leaves nothing behind: a caller that catches the error and retries
     * sees the problem it is fixing rather than a duplicate-name error from
     * its own first attempt. The rest entry is staged with them, for the same
     * reason.
     */
    addSlices(slices) {
        const staged = new Map();
        let stagedRestReason = null;
        for (const slice of slices) {
            if (isRestNotMockedEntry(slice)) {
                // Two of them answer the same calls with two different
                // reasons, and which one a call would get is registration
                // order, which is exactly what a duplicate name is refused
                // for.
                const registered = this.restReason ?? stagedRestReason;
                if (registered !== null) {
                    throw new Error(`LambderMockApp: the rest of the contract is already registered as not mocked ("${registered}"). One restNotMocked entry covers every endpoint the slices leave out.`);
                }
                stagedRestReason = slice.restNotMockedReason;
                continue;
            }
            for (const [key, entry] of Object.entries(slice)) {
                // The compile-time completeness check reads the slice's KEYS
                // and registration reads entry.name, so the two have to agree
                // or the check is checking something else than what runs. A
                // hand-written slice is where they part: `{ ...userMocks,
                // "user.list": someOtherEntry }` registers the other endpoint
                // and leaves "user.list" unanswered, and the first symptom is
                // an overlap error naming an endpoint nobody wrote twice.
                if (key !== entry.name) {
                    throw new Error(`LambderMockApp: slice key "${key}" holds the mock for "${entry.name}". Key every entry by its own endpoint name, or build the slice with mockApp.apiSlice(...).`);
                }
                if (this.entries.has(entry.name) || staged.has(entry.name)) {
                    throw new Error(`LambderMockApp: endpoint "${entry.name}" is mocked in more than one slice.`);
                }
                staged.set(entry.name, entry);
            }
        }
        for (const [name, entry] of staged)
            this.entries.set(name, entry);
        if (stagedRestReason !== null)
            this.restReason = stagedRestReason;
    }
    /** The registered entry for a name, before any override; null when there is none. */
    registered(apiName) {
        return this.entries.get(apiName) ?? null;
    }
    /** Stacks an override over a registered entry and hands back its removal. */
    pushOverride(name, entry) {
        const stack = this.overrideStacks.get(name) ?? [];
        stack.push(entry);
        this.overrideStacks.set(name, stack);
        // Removes this override wherever it sits rather than popping the top:
        // scopes do not always unwind innermost first (an outer handle
        // restored by hand while an inner one is still standing), and popping
        // would then take down somebody else's override. Restoring twice is a
        // no-op.
        const restore = () => {
            const current = this.overrideStacks.get(name);
            const at = current?.lastIndexOf(entry) ?? -1;
            if (!current || at === -1)
                return;
            current.splice(at, 1);
            if (!current.length)
                this.overrideStacks.delete(name);
        };
        return { restore };
    }
    /** Puts every overridden handler back, however deeply they were stacked. */
    restoreOverrides() {
        this.overrideStacks.clear();
    }
    /** The registered endpoint names. */
    get names() {
        return [...this.entries.keys()];
    }
    /** What answers this call: the innermost override, else the registered entry. */
    entryFor(apiName) {
        return this.overrideStacks.get(apiName)?.at(-1) ?? this.entries.get(apiName) ?? null;
    }
}
