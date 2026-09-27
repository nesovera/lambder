/**
 * LambderOneShotSecrets over the memory store: the life of a code and of a
 * token as the class runs it, and the shapes it mints. The store's own rules
 * (one record per scope, the counted try, the single consume) are asserted
 * against every store in store-conformance.test.ts; this is about what the
 * class makes of them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LambderOneShotSecrets } from '../../src/secrets/LambderOneShotSecrets.js';
import { LambderMemoryOneShotSecretStore } from '../../src/stores/LambderMemoryOneShotSecretStore.js';
import { LambderDdbOneShotSecretStore } from '../../src/stores/LambderDdbOneShotSecretStore.js';
import { keyedDigest } from '../../src/shared/util/LambderSignedClaims.js';
import { MemoryDdb } from '../helpers.js';

const START = 1_790_000_000_000;
const LETTERS = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

const secretsWith = () => {
    let now = START;
    const store = new LambderMemoryOneShotSecretStore({ now: () => now });
    const secrets = new LambderOneShotSecrets({
        store,
        secret: 'app-secret',
        now: () => now,
        kinds: {
            emailCode: { shape: 'code', length: 6, ttlSeconds: 600, maxAttempts: 3 },
            deviceCode: { shape: 'code', alphabet: LETTERS, length: 8, ttlSeconds: 7200, maxAttempts: 5 },
            activationLink: { shape: 'token', ttlSeconds: 48 * 3600 },
            // Typed by somebody who does not know what it pairs, so it is redeemed by value, and guessable: the app rate-limits it.
            pairingCode: { shape: 'token', alphabet: LETTERS, length: 8, ttlSeconds: 7200 },
        },
    });
    return { secrets, store, advance: (ms: number) => { now += ms; } };
};

const issuedPlaintext = async (secrets: ReturnType<typeof secretsWith>['secrets'], kind: 'emailCode' | 'deviceCode' | 'activationLink' | 'pairingCode', scope: string, options?: { cooldownSeconds?: number; meta?: Record<string, string> }) => {
    const outcome = await secrets.issue(kind, scope, options);
    if(!outcome.issued) throw new Error(`expected an issue, refused until ${outcome.retryAt}`);
    return outcome;
};

describe('LambderOneShotSecrets', () => {
    it('mints codes of the declared alphabet and length, and tokens as base64url of the declared bytes', async () => {
        const { secrets } = secretsWith();
        const code = await issuedPlaintext(secrets, 'emailCode', 'register:ada@example.com');
        expect(code.plaintext).toMatch(/^[0-9]{6}$/);
        expect(code.expiresAt).toBe(Math.floor(START / 1000) + 600);
        expect((await issuedPlaintext(secrets, 'deviceCode', 'device:1')).plaintext).toMatch(new RegExp(`^[${LETTERS}]{8}$`));
        expect((await issuedPlaintext(secrets, 'pairingCode', 'device:2')).plaintext).toMatch(new RegExp(`^[${LETTERS}]{8}$`));
        expect((await issuedPlaintext(secrets, 'activationLink', 'activate:ada@example.com')).plaintext).toMatch(/^[A-Za-z0-9_-]{43}$/);
        // Codes are drawn afresh: a thousand six-digit codes are not all the same handful.
        const drawn = new Set<string>();
        for(let i = 0; i < 200; i += 1) drawn.add((await issuedPlaintext(secrets, 'emailCode', `scope-${i}`)).plaintext);
        expect(drawn.size).toBeGreaterThan(190);
    });

    it('stores a keyed digest and never the plaintext', async () => {
        const { secrets, store } = secretsWith();
        const { plaintext } = await issuedPlaintext(secrets, 'emailCode', 'register:ada@example.com');
        const record = (await store.findByScope('register:ada@example.com'))!;
        expect(record.digest).not.toContain(plaintext);
        expect(record.digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(record.digest).toBe(await keyedDigest('app-secret', `code|emailCode|register:ada@example.com|${plaintext}`));
    });

    it('accepts the code that is out, once, with the scope and meta it was issued with', async () => {
        const { secrets } = secretsWith();
        const { plaintext } = await issuedPlaintext(secrets, 'emailCode', 'register:ada@example.com', { meta: { identity: 'id-7' } });

        expect(await secrets.redeem('emailCode', 'register:ada@example.com', plaintext))
            .toEqual({ state: 'accepted', scope: 'register:ada@example.com', meta: { identity: 'id-7' }, issuedAt: Math.floor(START / 1000) });
        expect(await secrets.redeem('emailCode', 'register:ada@example.com', plaintext)).toEqual({ state: 'none' });
    });

    it('counts a wrong code, says how many tries are left, and refuses the code as exhausted past the ceiling, right or wrong', async () => {
        const { secrets } = secretsWith();
        const { plaintext } = await issuedPlaintext(secrets, 'emailCode', 'register:ada@example.com');
        const wrong = plaintext === '000000' ? '111111' : '000000';

        expect(await secrets.redeem('emailCode', 'register:ada@example.com', wrong)).toEqual({ state: 'wrong', attemptsLeft: 2 });
        expect(await secrets.redeem('emailCode', 'register:ada@example.com', wrong)).toEqual({ state: 'wrong', attemptsLeft: 1 });
        expect(await secrets.redeem('emailCode', 'register:ada@example.com', wrong)).toEqual({ state: 'wrong', attemptsLeft: 0 });
        // The fourth try, right or wrong, is one too many.
        expect(await secrets.redeem('emailCode', 'register:ada@example.com', plaintext)).toEqual({ state: 'exhausted' });
        expect(await secrets.redeem('emailCode', 'register:ada@example.com', plaintext)).toEqual({ state: 'exhausted' });
    });

    it('binds a code to its scope and kind: the same digits under another scope or kind are a wrong code', async () => {
        const { secrets } = secretsWith();
        const { plaintext } = await issuedPlaintext(secrets, 'emailCode', 'register:ada@example.com');
        await issuedPlaintext(secrets, 'emailCode', 'register:grace@example.com');
        expect(await secrets.redeem('emailCode', 'register:grace@example.com', plaintext)).toEqual({ state: 'wrong', attemptsLeft: 2 });
        expect(await secrets.redeem('deviceCode', 'register:ada@example.com', plaintext)).toEqual({ state: 'none' });
        expect(await secrets.redeem('emailCode', 'nobody', plaintext)).toEqual({ state: 'none' });
    });

    it('says expired once the code that is out has run out of time, and none once the store has let it go', async () => {
        const { secrets, advance } = secretsWith();
        const { plaintext } = await issuedPlaintext(secrets, 'emailCode', 'register:ada@example.com');
        advance(601_000);
        expect(await secrets.redeem('emailCode', 'register:ada@example.com', plaintext)).toEqual({ state: 'expired' });
        advance(3600_000);
        expect(await secrets.redeem('emailCode', 'register:ada@example.com', plaintext)).toEqual({ state: 'none' });
    });

    it('replaces the code that is out on a new issue, so the older one is a wrong code', async () => {
        const { secrets } = secretsWith();
        const first = await issuedPlaintext(secrets, 'emailCode', 'register:ada@example.com');
        const second = await issuedPlaintext(secrets, 'emailCode', 'register:ada@example.com');
        if(first.plaintext !== second.plaintext){
            expect(await secrets.redeem('emailCode', 'register:ada@example.com', first.plaintext)).toEqual({ state: 'wrong', attemptsLeft: 2 });
        }
        expect((await secrets.redeem('emailCode', 'register:ada@example.com', second.plaintext)).state).toBe('accepted');
    });

    it('refuses a reissue inside the cooldown, naming when to ask again, and issues once it is over', async () => {
        const { secrets, advance } = secretsWith();
        await issuedPlaintext(secrets, 'emailCode', 'register:ada@example.com', { cooldownSeconds: 30 });
        advance(10_000);
        expect(await secrets.issue('emailCode', 'register:ada@example.com', { cooldownSeconds: 30 }))
            .toEqual({ issued: false, refused: 'cooldown', retryAt: Math.floor(START / 1000) + 30 });
        advance(20_000);
        expect((await secrets.issue('emailCode', 'register:ada@example.com', { cooldownSeconds: 30 })).issued).toBe(true);
        // Retiring what was sent (it never arrived) lifts the cooldown.
        await secrets.retire('register:ada@example.com');
        expect((await secrets.issue('emailCode', 'register:ada@example.com', { cooldownSeconds: 30 })).issued).toBe(true);
    });

    it('redeems a token by its value, once, and never as another kind or after expiry', async () => {
        const { secrets, advance } = secretsWith();
        const { plaintext } = await issuedPlaintext(secrets, 'activationLink', 'activate:ada@example.com', { meta: { identity: 'id-7', organization: 'org-1' } });

        expect(await secrets.redeemToken('activationLink', 'nonsense')).toEqual({ state: 'none' });
        expect(await secrets.redeemToken('activationLink', plaintext.slice(0, -1))).toEqual({ state: 'none' });
        expect(await secrets.redeemToken('activationLink', 'x'.repeat(600))).toEqual({ state: 'none' });
        expect(await secrets.redeemToken('activationLink', plaintext))
            .toEqual({ state: 'accepted', scope: 'activate:ada@example.com', meta: { identity: 'id-7', organization: 'org-1' }, issuedAt: Math.floor(START / 1000) });
        expect(await secrets.redeemToken('activationLink', plaintext)).toEqual({ state: 'none' });

        const second = await issuedPlaintext(secrets, 'activationLink', 'activate:ada@example.com');
        // Past its 48 hours, while the store still holds it.
        advance(48 * 3600_000 + 60_000);
        expect(await secrets.redeemToken('activationLink', second.plaintext)).toEqual({ state: 'expired' });
    });

    it('redeems a token drawn from an alphabet by value, as a pairing code is typed', async () => {
        const { secrets } = secretsWith();
        const { plaintext } = await issuedPlaintext(secrets, 'pairingCode', 'device:9');
        expect(await secrets.redeemToken('pairingCode', plaintext)).toMatchObject({ state: 'accepted', scope: 'device:9' });
        expect(await secrets.redeemToken('pairingCode', plaintext)).toEqual({ state: 'none' });
    });

    it('retires a token with its scope, and a scope reissued replaces it', async () => {
        const { secrets } = secretsWith();
        const first = await issuedPlaintext(secrets, 'activationLink', 'activate:ada@example.com');
        const second = await issuedPlaintext(secrets, 'activationLink', 'activate:ada@example.com');
        expect(await secrets.redeemToken('activationLink', first.plaintext)).toEqual({ state: 'none' });
        await secrets.retire('activate:ada@example.com');
        expect(await secrets.redeemToken('activationLink', second.plaintext)).toEqual({ state: 'none' });
    });

    it('keeps a code kind and a token kind on their own methods', async () => {
        const { secrets } = secretsWith();
        // @ts-expect-error a token is redeemed by value.
        await expect(secrets.redeem('activationLink', 'scope', 'x')).rejects.toThrow(/is a token, redeemed by value with redeemToken\(\)/);
        // @ts-expect-error a code is redeemed with its scope.
        await expect(secrets.redeemToken('emailCode', 'x')).rejects.toThrow(/is a code, redeemed with its scope through redeem\(\)/);
        // @ts-expect-error not a kind.
        await expect(secrets.issue('nobody', 'scope')).rejects.toThrow(/knows no kind "nobody"/);
    });

    it('refuses kinds it cannot mint, at construction', () => {
        const store = new LambderMemoryOneShotSecretStore();
        expect(() => new LambderOneShotSecrets({ store, secret: '', kinds: { a: { shape: 'code', length: 6, ttlSeconds: 60, maxAttempts: 3 } } })).toThrow(/needs a secret/);
        expect(() => new LambderOneShotSecrets({ store, secret: 's', kinds: {} })).toThrow(/given no kinds/);
        expect(() => new LambderOneShotSecrets({ store, secret: 's', kinds: { a: { shape: 'code', length: 0, ttlSeconds: 60, maxAttempts: 3 } } })).toThrow(/kinds\.a\.length must be a positive integer/);
        expect(() => new LambderOneShotSecrets({ store, secret: 's', kinds: { a: { shape: 'code', alphabet: 'AA', length: 4, ttlSeconds: 60, maxAttempts: 3 } } })).toThrow(/kinds\.a\.alphabet must be 2 to 256 distinct characters/);
        expect(() => new LambderOneShotSecrets({ store, secret: 's', kinds: { a: { shape: 'token', ttlSeconds: 0 } } })).toThrow(/kinds\.a\.ttlSeconds must be a positive integer/);
        expect(() => new LambderOneShotSecrets({ store, secret: 's', kinds: { a: { shape: 'token', alphabet: 'ABC', length: 0, ttlSeconds: 60 } } })).toThrow(/kinds\.a\.length must be a positive integer/);
    });
});

describe('LambderOneShotSecrets when two scopes draw the same token', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    /**
     * Scripts what crypto.getRandomValues hands the next draws, one byte per
     * character, so a collision is made rather than waited for. A two-letter
     * alphabet and a one-letter code: byte 0 draws "A", byte 1 draws "B".
     */
    const scriptDraws = (bytes: number[]) => {
        const queue = [...bytes];
        vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
            const view = array as unknown as Uint8Array;
            view.fill(0);
            view[0] = queue.shift() ?? 0;
            return array;
        });
    };
    const tinyCodes = () => {
        const store = new LambderMemoryOneShotSecretStore();
        const secrets = new LambderOneShotSecrets({
            store,
            secret: 'app-secret',
            kinds: { pairingCode: { shape: 'token', alphabet: 'AB', length: 1, ttlSeconds: 7200 } },
        });
        return { store, secrets };
    };

    it('draws again rather than share a digest, so each holder redeems their own scope and no other', async () => {
        const { secrets } = tinyCodes();
        // Device A draws "A"; device B draws "A" too, is refused the digest, and draws "B".
        scriptDraws([0, 0, 1]);
        const a = await secrets.issue('pairingCode', 'device:a', { meta: { organization: 'org-a' } });
        const b = await secrets.issue('pairingCode', 'device:b', { meta: { organization: 'org-b' } });
        vi.restoreAllMocks();

        expect(a).toMatchObject({ issued: true, plaintext: 'A' });
        expect(b).toMatchObject({ issued: true, plaintext: 'B' });
        expect(await secrets.redeemToken('pairingCode', 'A')).toMatchObject({ state: 'accepted', scope: 'device:a', meta: { organization: 'org-a' } });
        expect(await secrets.redeemToken('pairingCode', 'B')).toMatchObject({ state: 'accepted', scope: 'device:b', meta: { organization: 'org-b' } });
    });

    it('gives up after five draws whose digest another scope holds, naming the kind', async () => {
        const { secrets } = tinyCodes();
        scriptDraws([0]);
        await secrets.issue('pairingCode', 'device:a');
        scriptDraws([0, 0, 0, 0, 0]);
        await expect(secrets.issue('pairingCode', 'device:b')).rejects.toThrow('Lambder: kind "pairingCode" drew 5 secrets in a row whose digest another scope holds; its alphabet and length leave too few for the ones out at once.');
    });

    it('issues a token in one DynamoDB request, and a code in one write with no digest item', async () => {
        const client = new MemoryDdb();
        const sent: string[] = [];
        const send = client.send.bind(client);
        client.send = (async (command: { constructor: { name: string } }) => { sent.push(command.constructor.name); return await send(command as never); }) as typeof client.send;
        const secrets = new LambderOneShotSecrets({
            store: new LambderDdbOneShotSecretStore({ tableName: 'test-table', client }),
            secret: 'app-secret',
            kinds: {
                emailCode: { shape: 'code', length: 6, ttlSeconds: 600, maxAttempts: 3 },
                activationLink: { shape: 'token', ttlSeconds: 48 * 3600 },
            },
        });

        await secrets.issue('activationLink', 'activate:ada@example.com');
        expect(sent).toEqual(['TransactWriteItemsCommand']);
        sent.length = 0;
        await secrets.issue('emailCode', 'register:ada@example.com');
        expect(sent).toEqual(['PutItemCommand']);
        // The scope item and the token's digest item; the code has only its scope item.
        expect([...client.items.keys()].map((key) => key.split('#')[1]).sort()).toEqual(['digest', 'scope', 'scope']);
    });
});

describe('LambderDdbOneShotSecretStore when a write meets a transaction on its item', () => {
    const storeOver = (client: MemoryDdb) => new LambderDdbOneShotSecretStore({ tableName: 'test-table', client });
    const tokenDraft = { kind: 'activationLink', scope: 'activate:ada@example.com', shape: 'token' as const, digest: 'digest-1', issuedAt: 1_790_000_000, expiresAt: 1_790_000_600, meta: {} };

    it('sends the refused write again, since nothing was written and the SDK does not retry it', async () => {
        const client = new MemoryDdb();
        const store = storeOver(client);

        client.conflictNextWrites = 2;
        const issued = await store.issue(tokenDraft, {});
        expect(issued).toMatchObject({ issued: true });
        expect((await store.findByDigest('digest-1'))?.scope).toBe('activate:ada@example.com');

        client.conflictNextWrites = 1;
        expect(await store.consume('activate:ada@example.com', (issued as { id: string }).id)).toBe(true);
        expect(client.conflictNextWrites).toBe(0);
    });

    it('throws the conflict after the third refusal, having written nothing', async () => {
        const client = new MemoryDdb();
        const store = storeOver(client);

        client.conflictNextWrites = 3;
        await expect(store.issue(tokenDraft, {})).rejects.toMatchObject({ name: 'TransactionCanceledException' });
        expect(client.items.size).toBe(0);
    });
});
