/**
 * One set of rules, every implementation of a store interface.
 *
 * Tests run against the memory implementations while production runs against
 * the DynamoDB ones, which is only sound while the two behave identically.
 * The compiler checks a method's SIGNATURE, not its semantics, so every rule
 * an engine relies on is asserted once, in the suites `lambder/testing`
 * exports for an app's own stores, and driven here through each of
 * Lambder's.
 *
 * The DynamoDB stores run against the in-memory DynamoDB from helpers, which
 * models the conditional writes they depend on. Time comes from the clock
 * each case hands its store, and the system clock deliberately does NOT move
 * with it: a store that read Date.now() behind its `now` option would see
 * time standing still and fail the expiry rules, rather than pass because the
 * test moved the world.
 */

import { describe, it, expect } from 'vitest';
import { LambderMemoryIdempotencyStore } from '../src/stores/LambderMemoryIdempotencyStore.js';
import { LambderDdbIdempotencyStore } from '../src/stores/LambderDdbIdempotencyStore.js';
import { LambderMemoryRateLimiter } from '../src/stores/LambderMemoryRateLimiter.js';
import { LambderDdbRateLimiter } from '../src/stores/LambderDdbRateLimiter.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import { LambderDdbSessionStore } from '../src/stores/LambderDdbSessionStore.js';
import { LambderMemoryOneShotSecretStore } from '../src/stores/LambderMemoryOneShotSecretStore.js';
import { LambderDdbOneShotSecretStore } from '../src/stores/LambderDdbOneShotSecretStore.js';
import {
    lambderIdempotencyStoreConformance,
    lambderOneShotSecretStoreConformance,
    lambderRateLimiterConformance,
    lambderSessionStoreConformance,
    type LambderIdempotencyStoreConformanceOptions,
    type LambderOneShotSecretStoreConformanceOptions,
    type LambderRateLimiterConformanceOptions,
    type LambderSessionStoreConformanceOptions,
} from '../src/testing.js';
import { MemoryDdb, MemoryDdbDocument } from './helpers.js';

/** An implementation under its name, with what its suite asks beside the runner. */
type Implementation<TOptions> = { name: string } & Omit<TOptions, 'it' | 'expect'>;

// ---------------------------------------------------------------------------
// LambderIdempotencyStore
// ---------------------------------------------------------------------------

/**
 * Near-incompressible, so the DynamoDB store cannot get it under its budget
 * with Brotli. Built once: a megabyte of it is not cheap to make.
 */
const incompressibleBody = (() => {
    // xorshift32: every step stays inside 32 bits, so the sequence does not
    // lose precision and collapse into something Brotli can crush.
    let seed = 0x9e3779b9;
    const characters: string[] = [];
    for(let i = 0; i < 600_000; i += 1){
        seed ^= seed << 13; seed >>>= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5; seed >>>= 0;
        characters.push(String.fromCharCode(33 + (seed % 94)));
    }
    return characters.join('');
})();

const idempotencyImplementations: Implementation<LambderIdempotencyStoreConformanceOptions>[] = [
    {
        name: 'LambderMemoryIdempotencyStore',
        create: ({ now }) => new LambderMemoryIdempotencyStore({ maxBodyBytes: 64, now }),
        oversizedBody: 'x'.repeat(200),
        largestStorableBody: 'x'.repeat(64),
    },
    {
        name: 'LambderDdbIdempotencyStore',
        create: ({ now }) => new LambderDdbIdempotencyStore({ tableName: 'test-table', client: new MemoryDdb(), now }),
        oversizedBody: incompressibleBody,
        // Far past the item budget raw and far under it stored, which is the
        // thing this store's budget means: it is on the bytes written.
        largestStorableBody: 'a'.repeat(1_000_000),
    },
    {
        // The other supported edge of the same option, and the one the cache
        // and the session store both ship as their default: compress
        // everything. It is the configuration where a body the compressor
        // cannot describe (an empty one) reaches the table.
        name: 'LambderDdbIdempotencyStore (compression from the first byte)',
        create: ({ now }) => new LambderDdbIdempotencyStore({ tableName: 'test-table', client: new MemoryDdb(), compression: { minBytes: 0 }, now }),
        oversizedBody: incompressibleBody,
        largestStorableBody: 'a'.repeat(1_000_000),
    },
    {
        // A supported configuration, and the one where the budget is easiest
        // to forget: with nothing to compress, the body goes to the table as
        // it is, and DynamoDB answers an oversized item with a
        // ValidationException, which is not a conditional-check failure and so
        // escapes as a store error rather than a "too-large".
        name: 'LambderDdbIdempotencyStore (compression off)',
        create: ({ now }) => new LambderDdbIdempotencyStore({ tableName: 'test-table', client: new MemoryDdb(), compression: false, now }),
        oversizedBody: incompressibleBody,
        // Exactly the stored-body budget, with nothing compressing it down to fit.
        largestStorableBody: 'a'.repeat(350_000),
    },
];

for(const { name, ...implementation } of idempotencyImplementations){
    describe(`LambderIdempotencyStore conformance: ${name}`, () => {
        lambderIdempotencyStoreConformance({ it, expect, ...implementation });
    });
}

// ---------------------------------------------------------------------------
// LambderRateLimiter
// ---------------------------------------------------------------------------

const rateLimiterImplementations: Implementation<LambderRateLimiterConformanceOptions>[] = [
    { name: 'LambderMemoryRateLimiter', create: ({ now }) => new LambderMemoryRateLimiter({ now }) },
    { name: 'LambderDdbRateLimiter', create: ({ now }) => new LambderDdbRateLimiter({ tableName: 'test-table', client: new MemoryDdb(), now }) },
];

for(const { name, ...implementation } of rateLimiterImplementations){
    describe(`LambderRateLimiter conformance: ${name}`, () => {
        lambderRateLimiterConformance({ it, expect, ...implementation });
    });
}

// ---------------------------------------------------------------------------
// LambderSessionStore
// ---------------------------------------------------------------------------

/**
 * The whole session test file runs on the memory store while production runs
 * on DynamoDB, so this is what checks that the two agree on a missing record,
 * on partition isolation, on skipping a record that is gone, and on the
 * dataVersion every conditioned write depends on.
 */
const sessionStoreImplementations: Implementation<LambderSessionStoreConformanceOptions>[] = [
    { name: 'LambderMemorySessionStore', create: ({ now }) => new LambderMemorySessionStore({ now }), isMemoryOnly: true },
    {
        name: 'LambderDdbSessionStore',
        create: () => new LambderDdbSessionStore({ tableName: 'test-sessions', client: new MemoryDdbDocument() as any }),
    },
    {
        // The other supported setting, and a different item shape: the data
        // as a plain map rather than Brotli bytes, so every write that holds
        // data swaps attributes the other way round.
        name: 'LambderDdbSessionStore (compression off)',
        create: () => new LambderDdbSessionStore({ tableName: 'test-sessions', client: new MemoryDdbDocument() as any, compression: false }),
    },
];

for(const { name, ...implementation } of sessionStoreImplementations){
    describe(`LambderSessionStore conformance: ${name}`, () => {
        lambderSessionStoreConformance({ it, expect, ...implementation });
    });
}

// ---------------------------------------------------------------------------
// LambderOneShotSecretStore
// ---------------------------------------------------------------------------

const oneShotImplementations: Implementation<LambderOneShotSecretStoreConformanceOptions>[] = [
    { name: 'LambderMemoryOneShotSecretStore', create: ({ now }) => new LambderMemoryOneShotSecretStore({ now }) },
    { name: 'LambderDdbOneShotSecretStore', create: () => new LambderDdbOneShotSecretStore({ tableName: 'test-table', client: new MemoryDdb() }) },
];

for(const { name, ...implementation } of oneShotImplementations){
    describe(`LambderOneShotSecretStore conformance: ${name}`, () => {
        lambderOneShotSecretStoreConformance({ it, expect, ...implementation });
    });
}
