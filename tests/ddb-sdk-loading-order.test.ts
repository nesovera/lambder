/**
 * The DynamoDB SDK is loaded on first use, not at construction and not when
 * lambder is imported. The mock factory records the moment the package is
 * first imported; everything up to the first table access must happen
 * before that moment.
 *
 * The client that load makes is here too, since it is the same step: which
 * region it is built for, for every store that has one.
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
            session: { store: new lambder.LambderDdbSessionStore({ tableName: 'sessions', region: 'us-east-1' }), sessionSalt: 'salt' },
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

describe('the client the loader makes', () => {
    it('is built for the region the store was given', async () => {
        const { createDynamoClientLoader } = await import('../src/stores/LambderDdbSdk.js');
        const { client } = await createDynamoClientLoader({ user: 'LambderDdbCache', region: 'eu-west-1' })();

        expect(await client.config.region()).toBe('eu-west-1');
    });

    it('is one client per region, shared by every store not given one', async () => {
        const { createDynamoClientLoader, createDynamoDocumentClientLoader } = await import('../src/stores/LambderDdbSdk.js');
        const [cache, limiter, other] = await Promise.all([
            createDynamoClientLoader({ user: 'LambderDdbCache', region: 'eu-central-1' })(),
            createDynamoClientLoader({ user: 'LambderDdbRateLimiter', region: 'eu-central-1' })(),
            createDynamoClientLoader({ user: 'LambderDdbRateLimiter', region: 'eu-north-1' })(),
        ]);
        expect(limiter.client).toBe(cache.client);
        expect(other.client).not.toBe(cache.client);

        const [sessions, moreSessions] = await Promise.all([
            createDynamoDocumentClientLoader({ user: 'LambderDdbSessionStore', region: 'eu-central-1' })(),
            createDynamoDocumentClientLoader({ user: 'LambderDdbSessionStore', region: 'eu-central-1' })(),
        ]);
        expect(moreSessions.client).toBe(sessions.client);
    });

    it('falls to the SDK default chain when the store was given none', async () => {
        // All four stores share this rule. A store with a fixed fallback region
        // would quietly land there when an app deployed elsewhere and left the
        // option out, while its sibling stores followed the deployment.
        const { createDynamoClientLoader } = await import('../src/stores/LambderDdbSdk.js');
        const before = process.env.AWS_REGION;
        process.env.AWS_REGION = 'ap-south-1';
        try {
            const { client } = await createDynamoClientLoader({ user: 'LambderDdbCache' })();
            expect(await client.config.region()).toBe('ap-south-1');
        } finally {
            if(before === undefined) delete process.env.AWS_REGION;
            else process.env.AWS_REGION = before;
        }
    });
});
