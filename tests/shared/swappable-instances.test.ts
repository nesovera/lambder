/**
 * The registry the app's own Lambder classes join as they are constructed, so
 * `lambder/testing` can put a memory twin under each without the app handing
 * it over: found whether it was built before the test kit loaded or after,
 * held by nothing but a WeakRef, and shared by two copies of the module.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { LAMBDER_BACKEND_SWAP } from '../../src/shared/util/LambderTestingDoors.js';
import {
    delegateToTwin,
    liveSwappableInstances,
    registerSwappableInstance,
    watchSwappableInstances,
} from '../../src/shared/util/LambderSwappableInstances.js';

setFlagsFromString('--expose_gc');
const gc = runInNewContext('gc') as () => void;

/** Collects what nothing holds. A WeakRef keeps its target to the end of the job that made it, hence the turns first. */
const collectGarbage = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
    await new Promise((resolve) => setImmediate(resolve));
    gc();
};

const REGISTRY_KEY = Symbol.for('lambder.swappableInstances');
/** The process-wide list, which two copies of the module share by this key. */
const registry = () => (globalThis as Record<symbol, { entries: unknown[]; sweepAt: number }>)[REGISTRY_KEY]!;

/** A registered class as the stores are: a door under LAMBDER_BACKEND_SWAP that records what it was offered. */
const swappable = () => {
    const offered: unknown[] = [];
    return { offered, [LAMBDER_BACKEND_SWAP]: (twins: unknown) => { offered.push(twins); } };
};

beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];
});

describe('registerSwappableInstance', () => {
    it('lists what was registered, alive, in the order it was constructed, and opens its door', () => {
        const first = swappable();
        const second = swappable();
        registerSwappableInstance(first);
        registerSwappableInstance(second);

        const found = liveSwappableInstances();
        expect(found.map(({ instance }) => instance)).toEqual([first, second]);
        found[1]!.swapIn('twins');
        expect(second.offered).toEqual(['twins']);
    });

    it('hands what is registered after a watcher is set to the watcher, at once, and a second watcher takes over', () => {
        const seenByFirst: object[] = [];
        const seenBySecond: object[] = [];
        const before = swappable();
        registerSwappableInstance(before);

        watchSwappableInstances(({ instance }) => { seenByFirst.push(instance); });
        const during = swappable();
        registerSwappableInstance(during);
        watchSwappableInstances(({ instance, swapIn }) => { seenBySecond.push(instance); swapIn('second twins'); });
        const after = swappable();
        registerSwappableInstance(after);

        expect(seenByFirst).toEqual([during]);
        expect(seenBySecond).toEqual([after]);
        expect(after.offered).toEqual(['second twins']);
        // What was there before any watcher is the list's to hand out.
        expect(liveSwappableInstances().map(({ instance }) => instance)).toEqual([before, during, after]);
    });

    it('holds nothing alive', async () => {
        let probe: WeakRef<object> | undefined;
        (() => {
            const instance = swappable();
            registerSwappableInstance(instance);
            probe = new WeakRef(instance);
        })();
        await collectGarbage();

        expect(probe!.deref()).toBeUndefined();
        expect(liveSwappableInstances()).toEqual([]);
    });

    it('sweeps what was collected as the list grows, so it stays as long as what is alive', async () => {
        const alive = [swappable(), swappable(), swappable()];
        for(const instance of alive) registerSwappableInstance(instance);
        while(registry().entries.length < registry().sweepAt - 1) registerSwappableInstance(swappable());
        await collectGarbage();

        // The registration that reaches the sweep point drops every dead entry.
        registerSwappableInstance(swappable());
        expect(registry().entries.length).toBeLessThanOrEqual(alive.length + 1);
        expect(liveSwappableInstances().map(({ instance }) => instance).slice(0, 3)).toEqual(alive);
    });

    it('is one list for two copies of the module, each instance opened under its own copy\'s door', async () => {
        const instance = swappable();
        registerSwappableInstance(instance);

        vi.resetModules();
        const secondCopy = await import('../../src/shared/util/LambderSwappableInstances.js');
        const secondDoors = await import('../../src/shared/util/LambderTestingDoors.js');
        // A copy in earnest: its door key is not this one's.
        expect(secondDoors.LAMBDER_BACKEND_SWAP).not.toBe(LAMBDER_BACKEND_SWAP);

        const found = secondCopy.liveSwappableInstances().find((handle) => handle.instance === instance);
        found!.swapIn('twins from the second copy');
        expect(instance.offered).toEqual(['twins from the second copy']);

        // And the other way round: registered by the second copy, found by the first.
        const theirs = { offered: [] as unknown[], [secondDoors.LAMBDER_BACKEND_SWAP]: (twins: unknown) => { theirs.offered.push(twins); } };
        secondCopy.registerSwappableInstance(theirs);
        liveSwappableInstances().find((handle) => handle.instance === theirs)!.swapIn('twins from the first copy');
        expect(theirs.offered).toEqual(['twins from the first copy']);
    });
});

describe('delegateToTwin', () => {
    type Counter = { add(amount: number): number; read(): number };
    const counter = (start: number) => {
        let value = start;
        return { add: (amount: number) => (value += amount), read: () => value };
    };

    class StoredCounter implements Counter {
        add(): number { throw new Error('reached the production table'); }
        read(): number { throw new Error('reached the production table'); }
    }

    it('answers every member from the twin, in place, so whatever holds the instance reaches the twin', () => {
        const stored = new StoredCounter();
        const heldElsewhere = { counter: stored as Counter };
        delegateToTwin<Counter>(stored, counter(10), { add: true, read: true });

        expect(heldElsewhere.counter.add(5)).toBe(15);
        expect(stored.read()).toBe(15);
    });

    it('replaces an earlier twin with a later one', () => {
        const stored = new StoredCounter();
        delegateToTwin<Counter>(stored, counter(10), { add: true, read: true });
        delegateToTwin<Counter>(stored, counter(100), { add: true, read: true });
        expect(stored.read()).toBe(100);
    });

    it('takes the interface\'s every member, so a member left off fails to compile', () => {
        // @ts-expect-error read is left off
        expect(() => delegateToTwin<Counter>(new StoredCounter(), counter(0), { add: true })).not.toThrow();
    });
});
