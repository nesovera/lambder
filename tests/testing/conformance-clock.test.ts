/**
 * The conformance suites' clock starts far in the future, so a storage that
 * removes expired entries by itself (a native TTL, as DynamoDB's or Redis's)
 * runs the cache suite with that TTL on: nothing a case writes has expired by
 * the world's clock, and an entry counts as expired only by the case's own.
 */

import { describe, it, expect } from 'vitest';
import { LambderStorageBackedCache, type LambderCacheStorage, type LambderCacheStoredEntry } from '../../src/stores/LambderStorageBackedCache.js';
import type { LambderCacheAddress } from '../../src/stores/LambderCacheKeys.js';
import { conformanceClock } from '../../src/testing/LambderConformanceRunner.js';
import { lambderCacheConformance, lambderCacheStorageConformance } from '../../src/testing.js';
import { MemoryCacheStorage } from '../helpers.js';

/** A storage whose own TTL drops an entry once the world's clock passes its expiry, before anything reads it. */
class NativeTtlCacheStorage implements LambderCacheStorage {
    private readonly held = new MemoryCacheStorage();

    private dropExpired(): void {
        const worldSeconds = Date.now() / 1000;
        for(const [memoryKey, { entry }] of this.held.entries){
            if(entry.expiresAt <= worldSeconds) this.held.entries.delete(memoryKey);
        }
    }

    async read(address: LambderCacheAddress): Promise<LambderCacheStoredEntry | null> {
        this.dropExpired();
        return await this.held.read(address);
    }

    async write(address: LambderCacheAddress, entry: LambderCacheStoredEntry): Promise<void> {
        this.dropExpired();
        await this.held.write(address, entry);
    }

    async delete(address: LambderCacheAddress, nowSeconds: number): Promise<boolean> {
        this.dropExpired();
        return await this.held.delete(address, nowSeconds);
    }

    async deletePartition(partition: string, nowSeconds: number): Promise<number> {
        this.dropExpired();
        return await this.held.deletePartition(partition, nowSeconds);
    }

    async listSortKeys(partition: string, prefix: string, nowSeconds: number): Promise<string[]> {
        this.dropExpired();
        return await this.held.listSortKeys(partition, prefix, nowSeconds);
    }
}

it('starts every case after the world\'s clock', () => {
    expect(conformanceClock().now()).toBeGreaterThan(Date.now());
});

describe('LambderCache conformance over a storage with a native TTL', () => {
    lambderCacheConformance({ it, expect, create: ({ now }) => new LambderStorageBackedCache({ storage: new NativeTtlCacheStorage(), now }) });
});

describe('LambderCacheStorage conformance over a storage with a native TTL', () => {
    lambderCacheStorageConformance({ it, expect, create: () => new NativeTtlCacheStorage() });
});
