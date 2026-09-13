/**
 * The DynamoDB SDK is loaded on first use, not at construction and not when
 * lambder is imported. The mock factory records the moment the package is
 * first imported; everything up to the first table access must happen
 * before that moment.
 */

import { describe, it, expect, vi } from 'vitest';

const seen = vi.hoisted(() => ({ loads: [] as string[] }));
vi.mock('@aws-sdk/client-dynamodb', async (importOriginal) => {
    seen.loads.push('@aws-sdk/client-dynamodb');
    return await importOriginal<typeof import('@aws-sdk/client-dynamodb')>();
});
vi.mock('@aws-sdk/lib-dynamodb', async (importOriginal) => {
    seen.loads.push('@aws-sdk/lib-dynamodb');
    return await importOriginal<typeof import('@aws-sdk/lib-dynamodb')>();
});

describe('DynamoDB SDK loading order', () => {
    it('importing lambder and constructing an app with sessions and the stores loads nothing; the first table access loads the SDK', async () => {
        const lambder = await import('../src/index.js');
        expect(seen.loads).toEqual([]);

        lambder.initLambder().create({
            apiPath: '/api',
            session: { tableName: 'sessions', tableRegion: 'us-east-1', sessionSalt: 'salt' },
        });
        // A client that answers nothing, so the call completes without a table.
        const fakeClient = { send: async () => ({}) } as unknown as import('@aws-sdk/client-dynamodb').DynamoDBClient;
        const limiter = new lambder.LambderDdbRateLimiter({ tableName: 'limits', client: fakeClient });
        const cache = new lambder.LambderDdbCache({ tableName: 'cache', client: fakeClient });
        expect(seen.loads).toEqual([]);

        await limiter.isRateLimited('ip:1', { perMin: 5 });
        expect(seen.loads).toEqual(['@aws-sdk/client-dynamodb']);

        // A second store shares the loaded module; nothing is imported twice.
        await cache.get('missing');
        expect(seen.loads).toEqual(['@aws-sdk/client-dynamodb']);
    });

    it('a provided client is used as given; commands still come from the loaded SDK', async () => {
        const { LambderDdbRateLimiter } = await import('../src/index.js');
        const { UpdateItemCommand } = await import('@aws-sdk/client-dynamodb');
        const sent: unknown[] = [];
        const fakeClient = { send: async (command: unknown) => { sent.push(command); return {}; } } as unknown as import('@aws-sdk/client-dynamodb').DynamoDBClient;

        const limiter = new LambderDdbRateLimiter({ tableName: 'limits', client: fakeClient });
        await limiter.isRateLimited('ip:1', { perMin: 5 });

        expect(sent).toHaveLength(1);
        expect(sent[0]).toBeInstanceOf(UpdateItemCommand);
    });
});
