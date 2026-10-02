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
/**
 * Registers an instance `lambder/testing` puts a memory twin under, from the
 * end of its constructor: the swap door keyed LAMBDER_BACKEND_SWAP must work
 * by then, since a test app already in charge swaps it on the spot.
 */
export declare const registerSwappableInstance: (instance: object) => void;
/** Every registered instance still alive, in the order they were constructed. */
export declare const liveSwappableInstances: () => LambderSwappableInstance[];
/** Hands every instance registered from now on to the watcher, in place of any earlier one. */
export declare const watchSwappableInstances: (watcher: (instance: LambderSwappableInstance) => void) => void;
/**
 * Makes every member named answer from the twin, in place: an own property of
 * the instance, bound to the twin, over the class's method. Whatever holds the
 * instance (a module-level constant, a class built over it) reaches the twin
 * on its next call without being told, and a second twin replaces the first.
 * The members are a record over the interface's keys, so an interface that
 * grows a method fails to compile until its stores' doors hand it over too.
 */
export declare const delegateToTwin: <TInterface extends object>(instance: TInterface, twin: TInterface, members: { readonly [TMember in keyof TInterface]-?: true; }) => void;
