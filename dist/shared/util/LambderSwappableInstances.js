import { LAMBDER_BACKEND_SWAP } from "./LambderTestingDoors.js";
const REGISTRY_KEY = Symbol.for("lambder.swappableInstances");
const MIN_SWEEP_AT = 64;
/** Created on first use rather than when the module loads, so importing it does nothing. */
const registry = () => {
    const holder = globalThis;
    return holder[REGISTRY_KEY] ??= { entries: [], sweepAt: MIN_SWEEP_AT, watcher: null };
};
const handleOf = (instance, door) => ({
    instance,
    swapIn: (twins) => instance[door](twins),
});
/**
 * Registers an instance `lambder/testing` puts a memory twin under, from the
 * end of its constructor: the swap door keyed LAMBDER_BACKEND_SWAP must work
 * by then, since a test app already in charge swaps it on the spot.
 */
export const registerSwappableInstance = (instance) => {
    const state = registry();
    state.entries.push({ ref: new WeakRef(instance), door: LAMBDER_BACKEND_SWAP });
    if (state.entries.length >= state.sweepAt) {
        state.entries = state.entries.filter((entry) => entry.ref.deref() !== undefined);
        state.sweepAt = Math.max(MIN_SWEEP_AT, state.entries.length * 2);
    }
    state.watcher?.(handleOf(instance, LAMBDER_BACKEND_SWAP));
};
/** Every registered instance still alive, in the order they were constructed. */
export const liveSwappableInstances = () => {
    const handles = [];
    for (const entry of registry().entries) {
        const instance = entry.ref.deref();
        if (instance !== undefined)
            handles.push(handleOf(instance, entry.door));
    }
    return handles;
};
/** Hands every instance registered from now on to the watcher, in place of any earlier one. */
export const watchSwappableInstances = (watcher) => {
    registry().watcher = watcher;
};
/**
 * Makes every member named answer from the twin, in place: an own property of
 * the instance, bound to the twin, over the class's method. Whatever holds the
 * instance (a module-level constant, a class built over it) reaches the twin
 * on its next call without being told, and a second twin replaces the first.
 * The members are a record over the interface's keys, so an interface that
 * grows a method fails to compile until its stores' doors hand it over too.
 */
export const delegateToTwin = (instance, twin, members) => {
    for (const member of Object.keys(members)) {
        const method = twin[member];
        Object.defineProperty(instance, member, { value: method.bind(twin), configurable: true, writable: true });
    }
};
