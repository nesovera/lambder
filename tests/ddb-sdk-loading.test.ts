/**
 * The DynamoDB SDK is an optional peer, loaded on first use.
 *
 * This file simulates the package being absent: importing lambder's root
 * entry, creating an app with sessions, and constructing every DynamoDB
 * store must all succeed, and only the first call that touches a table
 * fails, with the install hint naming the package. Its sibling,
 * ddb-sdk-loading-order.test.ts, checks the other half with the package
 * present: nothing loads it until first use.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@aws-sdk/client-dynamodb', () => { throw new Error('Cannot find module @aws-sdk/client-dynamodb'); });
vi.mock('@aws-sdk/lib-dynamodb', () => { throw new Error('Cannot find module @aws-sdk/lib-dynamodb'); });

describe('DynamoDB SDK absent', () => {
    it('lambder\'s root entry still imports, and an app with sessions and every store still constructs', async () => {
        const lambder = await import('../src/index.js');
        const app = lambder.initLambder<{ userId: string }>().create({
            apiPath: '/api',
            session: { store: new lambder.LambderDdbSessionStore({ tableName: 'sessions', region: 'us-east-1' }), sessionSalt: 'salt' },
        });
        expect(app.apiPath).toBe('/api');
        expect(() => new lambder.LambderDdbCache({ tableName: 'cache' })).not.toThrow();
        expect(() => new lambder.LambderDdbRateLimiter({ tableName: 'limits' })).not.toThrow();
        expect(() => new lambder.LambderDdbIdempotencyStore({ tableName: 'idem' })).not.toThrow();
    });

    it('the first call that touches a table fails with the install hint, naming the store', async () => {
        const { LambderDdbCache, LambderDdbRateLimiter, LambderDdbIdempotencyStore, LambderSessionManager, LambderDdbSessionStore } = await import('../src/index.js');

        await expect(new LambderDdbCache({ tableName: 'cache' }).get('k'))
            .rejects.toThrow('LambderDdbCache requires @aws-sdk/client-dynamodb: npm install @aws-sdk/client-dynamodb');
        await expect(new LambderDdbRateLimiter({ tableName: 'limits' }).isRateLimited('ip:1', { perMin: 1 }))
            .rejects.toThrow('LambderDdbRateLimiter requires @aws-sdk/client-dynamodb');
        await expect(new LambderDdbIdempotencyStore({ tableName: 'idem' }).peek('scope'))
            .rejects.toThrow('LambderDdbIdempotencyStore requires @aws-sdk/client-dynamodb');
        const sessions = new LambderSessionManager({
            store: new LambderDdbSessionStore({ tableName: 'sessions', region: 'us-east-1' }), sessionSalt: 'salt',
        });
        // A call that must query the table (getSession answers null for a token it cannot parse without one).
        const failure = await sessions.deleteSessionAllByKey('key').then(() => null, (err: unknown) => err) as Error & { cause?: Error };
        expect(failure).toBeInstanceOf(Error);
        expect(`${failure.message} ${failure.cause?.message ?? ''}`).toContain('LambderDdbSessionStore requires @aws-sdk/');
    });

    it('a failed load is not memoized, so a later call reports again rather than caching a stale rejection', async () => {
        const { LambderDdbRateLimiter } = await import('../src/index.js');
        const limiter = new LambderDdbRateLimiter({ tableName: 'limits' });
        await expect(limiter.isRateLimited('ip:1', { perMin: 1 })).rejects.toThrow('requires @aws-sdk/client-dynamodb');
        await expect(limiter.isRateLimited('ip:1', { perMin: 1 })).rejects.toThrow('requires @aws-sdk/client-dynamodb');
    });
});
