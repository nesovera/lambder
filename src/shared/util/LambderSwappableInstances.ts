import { LAMBDER_BACKEND_SWAP } from "./LambderTestingDoors.js";

/*
 * The instances `lambder/testing` puts a memory twin under without the app
 * handing them over.
 *
 * An app builds some Lambder classes itself, as module-level constants beside
 * its instance (a cache, the store under its one-shot secrets, an upload
 * bucket, an invoke caller to another function), so no instance holds them
 * and the backend swap cannot reach them. Each such class registers itself
 * here as it is constructed, and the test app finds every one through this
 * list: those constructed before `lambder/testing` was loaded, and, through
 * the watcher, those constructed after.
 *
 * What a serving process pays is one WeakRef and an array slot per
 * construction, nothing per call. The list holds no instance alive: an entry
 * is a WeakRef, and dead entries are swept as the list doubles, so an app that
 * constructs one of these per request keeps a list as long as what is alive.
 *
 * The list lives on globalThis under a registered symbol, so two copies of
 * this module in one process (an app's import of the package and a test
 * runner's, resolved apart) share one list. Each entry carries the door key of
 * the copy that registered it, since that copy's LAMBDER_BACKEND_SWAP is the
 * key its instance answers to.
 */

type RegisteredEntry = { readonly ref: WeakRef<object>; readonly door: symbol };

type SwappableInstanceRegistry = {
    entries: RegisteredEntry[];
    /** The list length at which dead entries are next swept. */
    sweepAt: number;
    /** Told of each instance registered from now on; set by the test app in charge. */
    watcher: ((instance: LambderSwappableInstance) => void) | null;
};

/** A registered instance as the test kit reaches it. */
export type LambderSwappableInstance = {
    readonly instance: object;
    /**
     * Calls the instance's swap door with the twins the test kit offers. The
     * door picks the one its class needs, so this list need not know what
     * each instance is.
     */
    swapIn(twins: unknown): void;
};

const REGISTRY_KEY = Symbol.for("lambder.swappableInstances");
const MIN_SWEEP_AT = 64;

/** Created on first use rather than when the module loads, so importing it does nothing. */
const registry = (): SwappableInstanceRegistry => {
    const holder = globalThis as { [REGISTRY_KEY]?: SwappableInstanceRegistry };
    return holder[REGISTRY_KEY] ??= { entries: [], sweepAt: MIN_SWEEP_AT, watcher: null };
};

const handleOf = (instance: object, door: symbol): LambderSwappableInstance => ({
    instance,
    swapIn: (twins) => (instance as Record<symbol, (twins: unknown) => void>)[door]!(twins),
});

/**
 * Registers an instance `lambder/testing` puts a memory twin under, from the
 * end of its constructor: the swap door keyed LAMBDER_BACKEND_SWAP must work
 * by then, since a test app already in charge swaps it on the spot.
 */
export const registerSwappableInstance = (instance: object): void => {
    const state = registry();
    state.entries.push({ ref: new WeakRef(instance), door: LAMBDER_BACKEND_SWAP });
    if(state.entries.length >= state.sweepAt){
        state.entries = state.entries.filter((entry) => entry.ref.deref() !== undefined);
        state.sweepAt = Math.max(MIN_SWEEP_AT, state.entries.length * 2);
    }
    state.watcher?.(handleOf(instance, LAMBDER_BACKEND_SWAP));
};

/** Every registered instance still alive, in the order they were constructed. */
export const liveSwappableInstances = (): LambderSwappableInstance[] => {
    const handles: LambderSwappableInstance[] = [];
    for(const entry of registry().entries){
        const instance = entry.ref.deref();
        if(instance !== undefined) handles.push(handleOf(instance, entry.door));
    }
    return handles;
};

/** Hands every instance registered from now on to the watcher, in place of any earlier one. */
export const watchSwappableInstances = (watcher: (instance: LambderSwappableInstance) => void): void => {
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
export const delegateToTwin = <TInterface extends object>(
    instance: TInterface,
    twin: TInterface,
    members: { readonly [TMember in keyof TInterface]-?: true },
): void => {
    for(const member of Object.keys(members) as (keyof TInterface & string)[]){
        const method = twin[member] as (...args: unknown[]) => unknown;
        Object.defineProperty(instance, member, { value: method.bind(twin), configurable: true, writable: true });
    }
};
