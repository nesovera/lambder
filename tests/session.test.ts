/**
 * The session model, over the in-memory store: how sessions are minted,
 * found, validated, renewed, rotated and ended, and how the controller
 * reads them onto a call context and writes their cookies. Nothing here
 * touches DynamoDB; the DynamoDB store's own mapping and compression are
 * tests/ddb-session-store.test.ts.
 *
 * The last groups drive session routes and session APIs through a real
 * Lambder instance with the memory store, which is the first time the
 * session layer has been testable end to end without the AWS SDK mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import { decodeBody, testPublicFiles } from './helpers.js';
import LambderSessionManager, { LambderSessionDataRefreshError, LambderSessionReadError } from '../src/session/LambderSessionManager.js';
import type { LambderSessionRecord } from '../src/shared/contracts/LambderSessionStore.js';
import LambderSessionController, { LambderSessionNotFoundError, LambderSessionAmbiguousError } from '../src/session/LambderSessionController.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import { LambderWebCrypto, LambderPlainSessionCrypto } from '../src/session/LambderSessionCrypto.js';
import { LambderDdbSessionStore } from '../src/stores/LambderDdbSessionStore.js';
import type { LambderSessionStore } from '../src/shared/contracts/LambderSessionStore.js';
import { createApiCallContext } from '../src/api/LambderApiCallContext.js';
import { LambderLocalFileSource } from '../src/stores/LambderLocalFileSource.js';
import { lambderGuard } from '../src/core/LambderPolicyBuilders.js';
import Lambder, { initLambder } from '../src/core/Lambder.js';
import type { LambderRenderContext, LambderSessionRenderContext } from '../src/core/LambderContext.js';
import { LambderAnswerHeaders } from '../src/shared/wire/LambderAnswerHeaders.js';

const nowSec = () => Math.floor(Date.now() / 1000);
const webCrypto = new LambderWebCrypto();
const SALT = 'test-salt-12345';

/** sha256 the way the manager hashes, for records planted straight into a store. */
const sha256 = (value: string) => webCrypto.sha256Hex(value);

/**
 * A session read, as the controller performs it: look the record up by the
 * presented token, then renew it. The manager keeps the two halves apart so a
 * caller weighing several cookies can decide which one is this visitor's
 * before anything is written on their behalf.
 */
const readSession = async <T>(manager: LambderSessionManager<T>, token: string): Promise<LambderSessionRecord<T> | null> => {
    const found = await manager.lookupSession(token);
    return found ? await manager.renewSession(found) : null;
};

/**
 * A record planted directly into a store: `sessionKeyHash:secret` is its token
 * and `csrf` its CSRF token. The stand-ins are hex because the controller
 * checks every candidate against the minted token format before it reads
 * anything, so a cookie shaped like "hash:sortkey" is no session at all.
 */
const plantRecord = async (store: LambderSessionStore<any>, overrides: Partial<LambderSessionRecord<any>> & { secret?: string; csrf?: string } = {}) => {
    const { secret = 'facade', csrf = 'csrf-token', ...rest } = overrides;
    const record: LambderSessionRecord<any> = {
        sessionKeyHash: 'deadbeef',
        secretHash: await sha256(secret),
        csrfTokenHash: await sha256(csrf),
        sessionKey: 'user-123',
        data: { userId: '123', username: 'testuser', role: 'user' },
        createdAt: nowSec(),
        expiresAt: nowSec() + 3600,
        lastAccessedAt: nowSec(),
        ttlInSeconds: 3600,
        ...rest,
    };
    await store.put(record);
    return { record, token: `${record.sessionKeyHash}:${secret}`, csrf };
};

/** The Set-Cookie values a context has pending. */
const setCookiesOf = (ctx: { responseHeaders: LambderAnswerHeaders }): string[] => {
    const headers: Record<string, string[]> = {};
    ctx.responseHeaders.applyInto(headers);
    return headers['Set-Cookie'] ?? [];
};

interface UserSessionData {
    userId: string;
    username: string;
    role: 'admin' | 'user' | 'guest';
    preferences?: { theme: 'light' | 'dark'; language: string };
}

describe('Session Type Safety', () => {
    it('LambderSessionRecord is the stored record', () => {
        const session: LambderSessionRecord<UserSessionData> = {
            sessionKeyHash: 'hash',
            secretHash: 'secret-hash',
            csrfTokenHash: 'csrf-token-hash',
            sessionKey: 'user-123',
            data: { userId: '123', username: 'testuser', role: 'user' },
            createdAt: Date.now(),
            expiresAt: Date.now() + 3600000,
            lastAccessedAt: Date.now(),
            ttlInSeconds: 3600,
        };
        expect(session.data.userId).toBe('123');
        expect(session.data.role).toBe('user');
    });

    it('LambderSessionRenderContext is the render context with a present session', () => {
        const sessionCtx = {
            host: 'localhost', path: '/test', pathParams: {}, method: 'GET',
            get: {}, post: {}, cookie: {}, cookieList: {},
            session: {
                sessionKeyHash: 'hash', secretHash: 'secret-hash', csrfTokenHash: 'csrf-token-hash',
                sessionKey: 'user-123',
                data: { userId: '123', username: 'testuser', role: 'admin' as const, permissions: ['read', 'write'] },
                createdAt: Date.now(), expiresAt: Date.now() + 3600000, lastAccessedAt: Date.now(), ttlInSeconds: 3600,
            },
            api: null, apiName: null, apiPayload: {},
            guardData: {}, headers: {}, rawBody: '', ip: '', header: () => undefined,
            event: {} as any, lambdaContext: {} as any, eventFormat: 'v1' as const,
            responseHeaders: new LambderAnswerHeaders(), logList: [],
        } satisfies LambderRenderContext | LambderSessionRenderContext<any, UserSessionData & { permissions: string[] }>;
        expect(sessionCtx.session.data.permissions).toContain('read');
    });
});

describe('LambderSessionManager over the memory store', () => {
    let store: LambderMemorySessionStore<UserSessionData>;
    let manager: LambderSessionManager<UserSessionData>;

    beforeEach(() => {
        store = new LambderMemorySessionStore<UserSessionData>();
        manager = new LambderSessionManager<UserSessionData>({ store, sessionSalt: SALT, enableSlidingExpiration: true });
    });

    describe('createSession', () => {
        it('creates a record with the expected structure and stores it', async () => {
            const data: UserSessionData = { userId: '123', username: 'testuser', role: 'user' };
            const { session, sessionToken, csrfToken } = await manager.createSession('user-123', data, 3600);

            expect(sessionToken).toMatch(/^[0-9a-f]{64}:[0-9a-f]{64}$/);
            expect(csrfToken).toMatch(/^[0-9a-f]{64}$/);
            expect(session.sessionKey).toBe('user-123');
            expect(session.data).toEqual(data);
            expect(session.ttlInSeconds).toBe(3600);
            expect(session.expiresAt).toBe(session.createdAt + 3600);
            expect(store.size).toBe(1);
        });

        it('stores only hashes of the bearer secrets, never the raw tokens', async () => {
            const { sessionToken, csrfToken } = await manager.createSession('user-123', {} as UserSessionData, 3600);
            const [sessionKeyHash, secret] = sessionToken.split(':') as [string, string];
            const [stored] = store.list();

            expect(stored!.sessionKeyHash).toBe(sessionKeyHash);
            expect(stored!.sessionKeyHash).toBe(await sha256(`user-123${SALT}`));
            expect(stored!.secretHash).toBe(await sha256(secret));
            expect(stored!.csrfTokenHash).toBe(await sha256(csrfToken));
            const serialized = JSON.stringify(stored);
            expect(serialized).not.toContain(secret);
            expect(serialized).not.toContain(csrfToken);
        });

        it('defaults the TTL to thirty days', async () => {
            const { session } = await manager.createSession('user-123', {} as UserSessionData);
            expect(session.ttlInSeconds).toBe(30 * 24 * 60 * 60);
        });

        it('mints unique tokens per session', async () => {
            const first = await manager.createSession('user-123', {} as UserSessionData);
            const second = await manager.createSession('user-123', {} as UserSessionData);
            expect(first.sessionToken).not.toBe(second.sessionToken);
            expect(first.csrfToken).not.toBe(second.csrfToken);
            expect(store.size).toBe(2);
        });
    });

    describe('lookupSession and renewSession', () => {
        it('finds a session by its token: the secret half proves possession', async () => {
            const { token } = await plantRecord(store);
            const session = await readSession(manager, token);
            expect(session?.sessionKey).toBe('user-123');
            expect(session?.data.userId).toBe('123');
        });

        it('answers null for a malformed token, a wrong secret, an expired record and an unknown one', async () => {
            await plantRecord(store);
            expect(await readSession(manager, 'invalid-token')).toBeNull();
            expect(await readSession(manager, 'deadbeef:bad1')).toBeNull();
            expect(await readSession(manager, 'f00d:facade')).toBeNull();

            const { token } = await plantRecord(store, { secret: 'dec0de', expiresAt: nowSec() - 3600, createdAt: nowSec() - 7200 });
            expect(await readSession(manager, token)).toBeNull();
        });

        it('propagates store read failures as LambderSessionReadError instead of null', async () => {
            // Null would read as sessionExpired and make the caller clear the
            // client's cookies: an infra blip must not force a logout.
            const failing: LambderSessionStore<UserSessionData> = {
                isMemoryOnly: true,
                get: async () => { throw new Error('store down'); },
                put: store.put.bind(store), delete: store.delete.bind(store),
                listSecretHashes: store.listSecretHashes.bind(store), markDataExpired: store.markDataExpired.bind(store),
            };
            const broken = new LambderSessionManager({ store: failing, sessionSalt: SALT });
            await expect(readSession(broken, 'deadbeef:facade')).rejects.toBeInstanceOf(LambderSessionReadError);
        });

        it('slides the expiry and writes back once the write interval has passed', async () => {
            const { token } = await plantRecord(store, { lastAccessedAt: nowSec() - 1800, expiresAt: nowSec() + 1800, createdAt: nowSec() - 1800 });
            const session = await readSession(manager, token);
            expect(session?.expiresAt).toBeGreaterThanOrEqual(nowSec() + 3599);
            expect(store.list()[0]!.expiresAt).toBe(session!.expiresAt);
        });

        it('skips the sliding write when the session was accessed recently', async () => {
            const { token, record } = await plantRecord(store, { lastAccessedAt: nowSec() - 10 });
            const put = vi.spyOn(store, 'put');
            const session = await readSession(manager, token);
            expect(session?.expiresAt).toBe(record.expiresAt);
            expect(put).not.toHaveBeenCalled();
        });

        it('reads a record the store hands back past its expiry as no session', async () => {
            // The store interface allows it on purpose: a DynamoDB TTL deletes
            // within days rather than at the second, and a store over a plain
            // table sweeps nothing at all. Expiry is the manager's to enforce,
            // so a store that never sweeps is still correct.
            const expiredStore: LambderSessionStore<any> = {
                isMemoryOnly: true,
                get: async () => ({
                    sessionKeyHash: 'deadbeef', secretHash: await sha256('facade'), csrfTokenHash: await sha256('csrf-token'),
                    sessionKey: 'user-123', data: { role: 'user' },
                    createdAt: nowSec() - 7200, expiresAt: nowSec() - 3600, lastAccessedAt: nowSec() - 7200, ttlInSeconds: 3600,
                }),
                put: async () => {}, delete: async () => {},
                listSecretHashes: async () => [], markDataExpired: async () => {},
            };
            const overExpired = new LambderSessionManager({ store: expiredStore, sessionSalt: SALT });

            expect(await overExpired.lookupSession('deadbeef:facade')).toBeNull();
        });

        it('logs a failed renewal write instead of swallowing it, and still serves the session', async () => {
            // A store failing every renewal means sliding expiration has
            // quietly stopped working and every session now ends at its
            // creation TTL, which otherwise shows up only as users being
            // signed out sooner than the app promises.
            const error = vi.spyOn(console, 'error').mockImplementation(() => {});
            const { token } = await plantRecord(store, { lastAccessedAt: nowSec() - 3600, expiresAt: nowSec() + 1800 });
            vi.spyOn(store, 'put').mockRejectedValue(new Error('ddb down'));

            expect((await readSession(manager, token))?.sessionKey).toBe('user-123');

            expect(error).toHaveBeenCalledOnce();
            expect(String(error.mock.calls[0]![0])).toContain('ddb down');
            expect(String(error.mock.calls[0]![0])).not.toContain(token);
            vi.restoreAllMocks();
        });

        it('refuses a TTL that is not a positive whole number of seconds', async () => {
            // It becomes the record's expiresAt and the store's own expiry
            // attribute, so a NaN from an unparsed environment variable would
            // write a record nothing ever retires and no read ever accepts.
            await expect(manager.createSession('user-123', {} as UserSessionData, Number('not a number'))).rejects.toThrow(/ttlInSeconds must be a positive integer/);
            await expect(manager.createSession('user-123', {} as UserSessionData, 0)).rejects.toThrow(/positive integer/);
            await expect(manager.createSession('user-123', {} as UserSessionData, 60.5)).rejects.toThrow(/positive integer/);
        });

        it('refuses an empty sessionKey, which would write a record no read accepts', async () => {
            // The same class as the TTL refusal above: lookupSession rejects a
            // record without a sessionKey, so an empty one hands the caller a
            // valid-looking cookie pair for a session that can never be read
            // back, and every request after it looks like a silent logout.
            await expect(manager.createSession('', {} as UserSessionData)).rejects.toThrow(/sessionKey is empty/);
            expect(store.size).toBe(0);
        });

        it('honours slidingWriteIntervalSeconds', async () => {
            const eager = new LambderSessionManager({ store, sessionSalt: SALT, slidingWriteIntervalSeconds: 5 });
            const { token } = await plantRecord(store, { lastAccessedAt: nowSec() - 10 });
            const put = vi.spyOn(store, 'put');
            await readSession(eager, token);
            expect(put).toHaveBeenCalledOnce();
        });

        it('renews only the session the cookies resolved to, never a candidate it merely weighed', async () => {
            // The split into lookupSession and renewSession is what stops a
            // planted cookie being kept alive by the victim's own traffic:
            // every candidate is read, exactly one is renewed. A per-candidate
            // read that also renewed would put twice here and zero times in
            // the ambiguous case.
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const eager = new LambderSessionManager<UserSessionData>({ store, sessionSalt: SALT, slidingWriteIntervalSeconds: 5 });
            const live = await plantRecord(store, { lastAccessedAt: nowSec() - 10 });
            const put = vi.spyOn(store, 'put');
            const controllerOn = (cookies: Record<string, string[]>) => new LambderSessionController<UserSessionData>({
                manager: eager, tokenCookieKey: 'sessionToken', csrfCookieKey: 'csrfToken', ctx: createApiCallContext<UserSessionData>(),
                request: { host: 'localhost', cookies, csrfToken: 'csrf-token' },
            });

            // A live cookie beside a well-formed candidate the store does not hold: one renewal, for the live one.
            const resolved = await controllerOn({ sessionToken: [`${'a'.repeat(64)}:${'b'.repeat(64)}`, live.token] }).fetchSession();
            expect(resolved.sessionKeyHash).toBe(live.record.sessionKeyHash);
            expect(put).toHaveBeenCalledOnce();

            // Two live candidates: refused, and neither is renewed.
            const other = await plantRecord(store, { sessionKey: 'attacker', lastAccessedAt: nowSec() - 10, secret: 'facade2', csrf: 'other-csrf' });
            put.mockClear();
            await expect(controllerOn({ sessionToken: [other.token, live.token] }).fetchSession()).rejects.toBeInstanceOf(LambderSessionAmbiguousError);
            expect(put).not.toHaveBeenCalled();
            vi.restoreAllMocks();
        });
    });

    describe('isSessionTokenValid and isSessionCsrfTokenValid', () => {
        it('accept the matching token and CSRF token, and reject any mismatch or expiry', async () => {
            // Two named methods rather than one with a trailing boolean: a
            // route asks the first alone, an API call asks both, and a flag at
            // the call site said neither.
            const { record } = await plantRecord(store);
            expect(await manager.isSessionTokenValid(record, 'deadbeef:facade')).toBe(true);
            expect(await manager.isSessionTokenValid(record, 'feed:babe')).toBe(false);
            expect(await manager.isSessionTokenValid(record, null)).toBe(false);
            expect(await manager.isSessionTokenValid(null, 'deadbeef:facade')).toBe(false);
            expect(await manager.isSessionCsrfTokenValid(record, 'csrf-token')).toBe(true);
            expect(await manager.isSessionCsrfTokenValid(record, 'wrong-csrf')).toBe(false);
            expect(await manager.isSessionCsrfTokenValid(record, null)).toBe(false);
            expect(await manager.isSessionCsrfTokenValid(null, 'csrf-token')).toBe(false);

            const { record: expired } = await plantRecord(store, { secret: 'dec0de', expiresAt: nowSec() - 3600 });
            expect(await manager.isSessionTokenValid(expired, 'deadbeef:dec0de')).toBe(false);
        });
    });

    describe('updateSessionData', () => {
        it('writes the new data, stamps lastAccessedAt and slides the expiry', async () => {
            const { record } = await plantRecord(store, { lastAccessedAt: nowSec() - 1800, expiresAt: nowSec() + 1800 });
            const before = record.expiresAt;
            const updated = await manager.updateSessionData(record, { ...record.data, preferences: { theme: 'dark', language: 'en' } });
            expect(updated.data.preferences?.theme).toBe('dark');
            expect(updated.expiresAt).toBeGreaterThan(before);
            expect(store.list()[0]!.data.preferences?.theme).toBe('dark');
        });
    });

    describe('deleteSession, deleteSessionAll, deleteSessionAllByKey', () => {
        it('deletes one, every session of the subject, or every session of a sessionKey', async () => {
            const a = await manager.createSession('user-123', {} as UserSessionData);
            const b = await manager.createSession('user-123', {} as UserSessionData);
            await manager.createSession('user-456', {} as UserSessionData);
            expect(store.size).toBe(3);

            expect(await manager.deleteSession(a.session)).toBe(true);
            expect(store.size).toBe(2);
            expect(await readSession(manager, a.sessionToken)).toBeNull();
            expect(await readSession(manager, b.sessionToken)).not.toBeNull();

            expect(await manager.deleteSessionAll(b.session)).toBe(true);
            expect(store.size).toBe(1);

            expect(await manager.deleteSessionAllByKey('user-456')).toBe(true);
            expect(store.size).toBe(0);
        });
    });

    describe('regenerateSession', () => {
        it('rotates both secrets and keeps the subject, data and TTL', async () => {
            const original = await manager.createSession('user-123', { userId: '123', username: 'testuser', role: 'user' }, 3600);
            const { session, sessionToken, csrfToken } = await manager.regenerateSession(original.session);

            expect(sessionToken).not.toBe(original.sessionToken);
            expect(csrfToken).not.toBe(original.csrfToken);
            expect(session.secretHash).toBe(await sha256(sessionToken.split(':')[1]!));
            expect(session.secretHash).not.toBe(original.session.secretHash);
            expect(session.csrfTokenHash).not.toBe(original.session.csrfTokenHash);
            expect(session.sessionKey).toBe('user-123');
            expect(session.data).toEqual(original.session.data);
            expect(session.ttlInSeconds).toBe(3600);
            // The old record is gone; only the new token finds a session.
            expect(store.size).toBe(1);
            expect(await readSession(manager, original.sessionToken)).toBeNull();
            expect(await readSession(manager, sessionToken)).not.toBeNull();
        });
    });

    describe('crypto', () => {
        it('the plain crypto stand-in mints and validates sessions too, without hashing', async () => {
            const plainStore = new LambderMemorySessionStore();
            const plain = new LambderSessionManager({ store: plainStore, sessionSalt: SALT, crypto: new LambderPlainSessionCrypto() });
            const { sessionToken, csrfToken, session } = await plain.createSession('user-123', {} as UserSessionData, 60);
            expect(await readSession(plain, sessionToken)).not.toBeNull();
            expect(await plain.isSessionTokenValid(session, sessionToken)).toBe(true);
            expect(await plain.isSessionCsrfTokenValid(session, csrfToken)).toBe(true);
            expect(await plain.isSessionCsrfTokenValid(session, 'other')).toBe(false);
        });

        it('refuses the plain crypto stand-in over a store that outlives the process', () => {
            // It neither hashes nor draws random bytes, so every record in a
            // persistent store would be a usable credential and the salt would
            // be readable straight out of the partition key. A docstring is not
            // enough to keep that out of production, so the manager will not
            // assemble the pair at all.
            const persistent = new LambderDdbSessionStore({ tableName: 'test-sessions', region: 'us-east-1' });
            expect(() => new LambderSessionManager({ store: persistent, sessionSalt: SALT, crypto: new LambderPlainSessionCrypto() }))
                .toThrow(/may only sit in front of a store that dies with the process/);
        });

        it('refuses an empty sessionSalt', () => {
            // It salts the hash that partitions the store, so an unset
            // environment variable stringifying to nothing has to be loud.
            expect(() => new LambderSessionManager({ store: new LambderMemorySessionStore(), sessionSalt: '' }))
                .toThrow(/sessionSalt is empty/);
        });
    });

    describe('the memory store key', () => {
        it('escapes the separator, so two records cannot collapse into one', async () => {
            // Both halves are hex today, but a custom LambderSessionCrypto
            // writes whatever it likes into them, and a plain `a|b` join makes
            // ('x|a', 'b') and ('x', 'a|b') one key: one record would silently
            // overwrite the other, which is one visitor reading another's
            // session.
            const keyed = new LambderMemorySessionStore();
            const record = (sessionKeyHash: string, secretHash: string, sessionKey: string): LambderSessionRecord => ({
                sessionKeyHash, secretHash, sessionKey,
                csrfTokenHash: 'csrf-hash', data: {},
                createdAt: nowSec(), expiresAt: nowSec() + 3600, lastAccessedAt: nowSec(), ttlInSeconds: 3600,
            });
            await keyed.put(record('part|a', 'b', 'straddling'));
            await keyed.put(record('part', 'a|b', 'neighbour'));

            expect((await keyed.get('part|a', 'b'))?.sessionKey).toBe('straddling');
            expect((await keyed.get('part', 'a|b'))?.sessionKey).toBe('neighbour');
            expect(keyed.size).toBe(2);

            // And the deletion reaches exactly the one record it names.
            await keyed.delete('part|a', 'b');
            expect(await keyed.get('part|a', 'b')).toBeNull();
            expect((await keyed.get('part', 'a|b'))?.sessionKey).toBe('neighbour');
        });
    });

    describe('the memory store ceiling', () => {
        it('maxEntries bounds the sessions held, and the evicted one is a logout', async () => {
            // The ceiling is reachable through the store's own options now, and
            // what it costs is worth saying out loud: the soonest to expire is
            // dropped, and whoever held that session is signed out.
            const bounded = new LambderMemorySessionStore({ maxEntries: 2 });
            const overBounded = new LambderSessionManager({ store: bounded, sessionSalt: SALT });
            const shortest = await overBounded.createSession('user-1', {}, 60);
            await overBounded.createSession('user-2', {}, 3600);
            const longest = await overBounded.createSession('user-3', {}, 7200);

            expect(bounded.size).toBeLessThanOrEqual(2);
            expect(await overBounded.lookupSession(shortest.sessionToken)).toBeNull();
            expect(await overBounded.lookupSession(longest.sessionToken)).not.toBeNull();
        });
    });
});

describe('LambderSessionController over the memory store', () => {
    let store: LambderMemorySessionStore<UserSessionData>;
    let manager: LambderSessionManager<UserSessionData>;
    let ctx: ReturnType<typeof createApiCallContext<UserSessionData>>;

    const controllerFor = (cookies: Record<string, string[]>, csrfToken: string | null = 'csrf-token') =>
        new LambderSessionController<UserSessionData>({
            manager, tokenCookieKey: 'sessionToken', csrfCookieKey: 'csrfToken', ctx,
            request: { host: 'localhost', cookies, csrfToken },
        });

    beforeEach(() => {
        store = new LambderMemorySessionStore<UserSessionData>();
        manager = new LambderSessionManager<UserSessionData>({ store, sessionSalt: SALT });
        ctx = createApiCallContext<UserSessionData>();
    });

    it('createSession stores the record, sets ctx.session and writes both cookies with the raw secrets', async () => {
        const data: UserSessionData = { userId: '123', username: 'testuser', role: 'user' };
        const session = await controllerFor({}).createSession('user-123', data);

        expect(session.data).toEqual(data);
        expect(ctx.session).toBe(session);
        const cookies = setCookiesOf(ctx);
        expect(cookies.length).toBe(2);
        expect(cookies[0]).toMatch(/^sessionToken=[0-9a-f]{64}:[0-9a-f]{64}; Path=\/; Expires=.*; HttpOnly; Secure; SameSite=Lax$/);
        expect(cookies[1]).toMatch(/^csrfToken=[0-9a-f]{64}; Path=\/; Expires=.*; Secure; SameSite=Lax$/);
        // The cookie carries the raw secret whose hash is the record's range key.
        const rawSecret = cookies[0]!.split(';')[0]!.split(':')[1]!;
        expect(await sha256(rawSecret)).toBe(session.secretHash);
    });

    it('fetchSession reads the session the cookie names, checked against the posted CSRF token', async () => {
        const { token } = await plantRecord(store);
        const session = await controllerFor({ sessionToken: [token] }).fetchSession();
        expect(session.data.userId).toBe('123');
        expect(ctx.session).toBe(session);
    });

    it('fetchSession refuses without a session cookie, without a CSRF token on API calls, or with the wrong one', async () => {
        const { token } = await plantRecord(store);
        await expect(controllerFor({}).fetchSession()).rejects.toThrow('Session tokens are invalid');
        await expect(controllerFor({ sessionToken: [token] }, '').fetchSession()).rejects.toThrow('Session tokens are invalid');
        await expect(controllerFor({ sessionToken: [token] }, 'wrong-csrf').fetchSession()).rejects.toThrow('Session not found');
    });

    it('a route (no CSRF token posted) needs the cookie alone', async () => {
        const { token } = await plantRecord(store);
        const session = await controllerFor({ sessionToken: [token] }, null).fetchSession();
        expect(session.sessionKey).toBe('user-123');
    });

    it('fetchSessionIfExists answers null for a missing session and the session otherwise', async () => {
        expect(await controllerFor({}).fetchSessionIfExists()).toBeNull();
        const { token } = await plantRecord(store);
        expect((await controllerFor({ sessionToken: [token] }).fetchSessionIfExists())?.data.userId).toBe('123');
    });

    it('regenerateSession rotates the secrets and rewrites the cookies', async () => {
        const { token } = await plantRecord(store);
        const controller = controllerFor({ sessionToken: [token] });
        const before = await controller.fetchSession();

        const after = await controller.regenerateSession();

        expect(after.secretHash).not.toBe(before.secretHash);
        expect(after.csrfTokenHash).not.toBe(before.csrfTokenHash);
        const cookies = setCookiesOf(ctx);
        expect(cookies.length).toBe(2);
        const rawSecret = cookies.find((cookie) => cookie.startsWith('sessionToken='))!.split(';')[0]!.split(':')[1]!;
        expect(await sha256(rawSecret)).toBe(after.secretHash);
        expect(store.size).toBe(1);
    });

    it('regenerateSession, updateSessionData, endSession and endSessionAll need a fetched session', async () => {
        const controller = controllerFor({});
        await expect(controller.regenerateSession()).rejects.toThrow('Session not found');
        await expect(controller.updateSessionData({} as UserSessionData)).rejects.toThrow('Session not found');
        await expect(controller.endSession()).rejects.toThrow('Session not found');
        await expect(controller.endSessionAll()).rejects.toThrow('Session not found');
    });

    it('updateSessionData writes through and updates ctx.session', async () => {
        const { token } = await plantRecord(store);
        const controller = controllerFor({ sessionToken: [token] });
        const session = await controller.fetchSession();
        const updated = await controller.updateSessionData({ ...session.data, preferences: { theme: 'dark', language: 'en' } });
        expect(updated.data.preferences?.theme).toBe('dark');
        expect(ctx.session?.data.preferences?.theme).toBe('dark');
        expect(store.list()[0]!.data.preferences?.theme).toBe('dark');
    });

    it('endSession deletes the record, nulls ctx.session and clears both cookies', async () => {
        const { token } = await plantRecord(store);
        const controller = controllerFor({ sessionToken: [token] });
        await controller.fetchSession();

        await controller.endSession();

        expect(ctx.session).toBeNull();
        expect(store.size).toBe(0);
        const cookies = setCookiesOf(ctx);
        expect(cookies).toEqual([
            'sessionToken=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
            'csrfToken=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Lax',
        ]);
    });

    it('endSessionAll deletes every session of the subject', async () => {
        const { token } = await plantRecord(store);
        await plantRecord(store, { secret: 'b0b' });
        await plantRecord(store, { secret: 'ace', sessionKeyHash: 'beef', sessionKey: 'user-456' });
        const controller = controllerFor({ sessionToken: [token] });
        await controller.fetchSession();

        await controller.endSessionAll();

        expect(ctx.session).toBeNull();
        expect(store.list().map((record) => record.sessionKey)).toEqual(['user-456']);
    });

    it('a token cookie that is not the minted format is no session, and never a store read', async () => {
        // The format check is the controller's, before any read: hex, a
        // colon, hex, each half under a generous ceiling so a custom crypto
        // may mint longer halves in either case. Anything else cannot name a
        // record, so reading for it buys nothing and costs a store round trip
        // per planted cookie.
        await plantRecord(store);
        const get = vi.spyOn(store, 'get');

        for(const planted of ['not-hex:at-all', 'deadbeef', `${'a'.repeat(1100)}:${'b'.repeat(64)}`, 'dead beef:facade', ':facade', 'xyz:facade']){
            expect(await controllerFor({ sessionToken: [planted] }).fetchSessionIfExists()).toBeNull();
        }

        expect(get).not.toHaveBeenCalled();
    });

    it('reads a session whose token halves are longer than the default crypto mints', async () => {
        // The plain crypto hex-encodes its input instead of hashing it, so a
        // long session key mints a long first half; a custom crypto may do
        // the same. The format bound exists for planted oversized cookies and
        // must leave such sessions readable.
        const plainStore = new LambderMemorySessionStore<UserSessionData>();
        const plain = new LambderSessionManager<UserSessionData>({ store: plainStore, sessionSalt: SALT, crypto: new LambderPlainSessionCrypto() });
        const longKey = 'k'.repeat(200);
        const created = await plain.createSession(longKey, { userId: 'u1', role: 'user' } as UserSessionData, 3600);
        expect(created.sessionToken.split(':')[0]!.length).toBeGreaterThan(256);

        const controller = new LambderSessionController<UserSessionData>({
            manager: plain, tokenCookieKey: 'sessionToken', csrfCookieKey: 'csrfToken', ctx: createApiCallContext<UserSessionData>(),
            request: { host: 'localhost', cookies: { sessionToken: [created.sessionToken] }, csrfToken: created.csrfToken },
        });
        expect((await controller.fetchSession()).sessionKey).toBe(longKey);
    });

    it('fetchSession throws the typed no-session exits, and fetchSessionIfExists swallows only those', async () => {
        const { token } = await plantRecord(store);
        await expect(controllerFor({}).fetchSession()).rejects.toBeInstanceOf(LambderSessionNotFoundError);
        await expect(controllerFor({ sessionToken: [token] }, 'wrong-csrf').fetchSession()).rejects.toBeInstanceOf(LambderSessionNotFoundError);

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const manyCopies = Array.from({ length: 6 }, (_, index) => `deadbeef:0a${index}`);
        await expect(controllerFor({ sessionToken: manyCopies }).fetchSession()).rejects.toBeInstanceOf(LambderSessionAmbiguousError);
        warn.mockRestore();
    });

    it('a crash inside the manager surfaces as a crash, not as a logout', async () => {
        // The reason the exits are typed at all. Returning null for anything
        // thrown made a TypeError in a custom store, or a bug in this layer,
        // answer sessionExpired: the client then clears its cookies, so the
        // defect presented as the user being signed out and nothing was logged.
        const { token } = await plantRecord(store);
        vi.spyOn(manager, 'renewSession').mockRejectedValue(new TypeError('cannot read properties of undefined'));

        await expect(controllerFor({ sessionToken: [token] }).fetchSessionIfExists()).rejects.toBeInstanceOf(TypeError);
        vi.restoreAllMocks();
    });

    it('re-issues both cookies when a sliding write moved the expiry, and stays silent when it did not', async () => {
        // Sliding expiration moved the record and left the browser holding a
        // cookie that still expires at createdAt + ttl, so a visitor who never
        // stopped using the app was signed out anyway, on the one deadline
        // sliding expiration exists to push back.
        const fresh = await plantRecord(store, { lastAccessedAt: nowSec() });
        await controllerFor({ sessionToken: [fresh.token] }).fetchSession();
        expect(setCookiesOf(ctx)).toEqual([]);

        ctx = createApiCallContext<UserSessionData>();
        const slid = await plantRecord(store, { secret: 'b0b', lastAccessedAt: nowSec() - 3600, expiresAt: nowSec() + 1800 });
        const session = await controllerFor({ sessionToken: [slid.token] }).fetchSession();

        const cookies = setCookiesOf(ctx);
        expect(cookies.length).toBe(2);
        expect(cookies[0]).toContain(`sessionToken=${slid.token};`);
        expect(cookies[1]).toContain('csrfToken=csrf-token;');
        // Both carry the renewed expiry, which is what the browser was missing.
        expect(cookies[0]).toContain(`Expires=${new Date(session.expiresAt * 1000).toUTCString()}`);
        expect(cookies[1]).toContain(`Expires=${new Date(session.expiresAt * 1000).toUTCString()}`);
    });

    it('slides a route with the CSRF cookie it carries, and only once that cookie pairs', async () => {
        // A route posts no CSRF token, so the value to re-issue is the cookie
        // that arrived, and re-issuing one that does not pair would overwrite
        // this visitor's real CSRF cookie with a planted one.
        const slid = await plantRecord(store, { lastAccessedAt: nowSec() - 3600, expiresAt: nowSec() + 1800 });
        const routeController = new LambderSessionController<UserSessionData>({
            manager, tokenCookieKey: 'sessionToken', csrfCookieKey: 'csrfToken', ctx,
            request: { host: 'localhost', cookies: { sessionToken: [slid.token], csrfToken: ['csrf-token'] }, csrfToken: null },
        });

        await routeController.fetchSession();
        expect(setCookiesOf(ctx).map((cookie) => cookie.split('=')[0])).toEqual(['sessionToken', 'csrfToken']);

        ctx = createApiCallContext<UserSessionData>();
        const other = await plantRecord(store, { secret: 'b0b', lastAccessedAt: nowSec() - 3600, expiresAt: nowSec() + 1800 });
        const plantedCsrf = new LambderSessionController<UserSessionData>({
            manager, tokenCookieKey: 'sessionToken', csrfCookieKey: 'csrfToken', ctx,
            request: { host: 'localhost', cookies: { sessionToken: [other.token], csrfToken: ['planted'] }, csrfToken: null },
        });

        await plantedCsrf.fetchSession();
        expect(setCookiesOf(ctx).map((cookie) => cookie.split('=')[0])).toEqual(['sessionToken']);
    });
});

describe('The session option after the store moved out of it', () => {
    it('refuses a table field that now belongs to the store, instead of ignoring it', () => {
        // create() is generic over `const TOptions`, which switches
        // excess-property checking off, so these compile. Silently dropping
        // them would point the app at pk/sk on a table keyed otherwise, and
        // the first sign would be that nobody can log in.
        const withMovedField = (extra: Record<string, unknown>) => () => new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
            session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt', ...extra },
        } as never);

        expect(withMovedField({ partitionKey: 'myPk' })).toThrow(/no longer takes partitionKey/);
        expect(withMovedField({ tableName: 't', tableRegion: 'us-east-1' })).toThrow(/no longer takes tableName, tableRegion/);
        expect(withMovedField({ sortKey: 'mySk' })).toThrow(/LambderDdbSessionStore/);
        expect(withMovedField({ compression: false })).toThrow(/no longer takes compression/);
    });

    it('takes a current session option without complaint', () => {
        expect(() => new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
            session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt', tokenCookieKey: 'sid' },
        })).not.toThrow();
    });
});

describe('Session Endpoint Protection', () => {
    let store: LambderMemorySessionStore<UserSessionData>;
    let lambder: ReturnType<typeof makeApp>;

    const makeApp = (store: LambderMemorySessionStore<UserSessionData>) => initLambder<UserSessionData>().create({
        files: new LambderLocalFileSource({ root: '/public' }),
        apiPath: '/api',
        session: { store, sessionSalt: 'test-salt' },
    }).setGlobalErrorHandler((err, ctx, responseBuilder) => {
        if (ctx?.api) return responseBuilder.api({ error: err.message });
        return responseBuilder.html(`<h1>Error: ${err.message}</h1>`);
    });

    const createMockEvent = (path: string, method: string, sessionToken?: string, apiName?: string, payload?: any, csrfToken?: string): APIGatewayProxyEvent => ({
        body: apiName ? JSON.stringify({ apiName, payload: payload || {}, token: csrfToken ?? 'csrf-token' }) : null,
        headers: { Host: 'localhost', Cookie: sessionToken ? `LMDRSESSIONTKID=${sessionToken}` : '' },
        multiValueHeaders: {},
        httpMethod: method,
        isBase64Encoded: false,
        path,
        pathParameters: null,
        queryStringParameters: null,
        multiValueQueryStringParameters: null,
        stageVariables: null,
        requestContext: {} as any,
        resource: '',
    });

    const createMockContext = (): Context => ({
        callbackWaitsForEmptyEventLoop: false, functionName: 'test', functionVersion: '1', invokedFunctionArn: 'arn',
        memoryLimitInMB: '128', awsRequestId: 'request-id', logGroupName: 'log-group', logStreamName: 'log-stream',
        getRemainingTimeInMillis: () => 1000, done: () => {}, fail: () => {}, succeed: () => {},
    });

    beforeEach(() => {
        store = new LambderMemorySessionStore<UserSessionData>();
        lambder = makeApp(store);
    });

    describe('addSessionRoute', () => {
        it('answers 401 when no session exists', async () => {
            lambder.addSessionRoute('/protected', async (ctx, resolver) => resolver.html('<h1>Protected Page</h1>'));
            const response = await lambder.render(createMockEvent('/protected', 'GET', 'deadbeef:facade'), createMockContext());
            expect(response.statusCode).toBe(401);
            expect(decodeBody(response)).toContain('Session required');
        });

        it('runs the handler with the session when the cookie names a live one', async () => {
            const { token } = await plantRecord(store);
            lambder.addSessionRoute('/protected', async (ctx, resolver) => resolver.html(`<h1>Protected ${ctx.session.data.userId}</h1>`));
            const response = await lambder.render(createMockEvent('/protected', 'GET', token), createMockContext());
            expect(response.statusCode).toBe(200);
            expect(decodeBody(response)).toContain('Protected 123');
        });

        it('answers 401 when the session is expired', async () => {
            const { token } = await plantRecord(store, { expiresAt: nowSec() - 3600, createdAt: nowSec() - 7200 });
            lambder.addSessionRoute('/protected', async (ctx, resolver) => resolver.html('<h1>Protected Page</h1>'));
            const response = await lambder.render(createMockEvent('/protected', 'GET', token), createMockContext());
            expect(response.statusCode).toBe(401);
        });

        it('a session API without the session option is refused at registration', () => {
            const bare = new Lambder({ apiPath: '/api' });
            expect(() => bare.addSessionApi('x', { input: z.any(), output: z.any() }, async (ctx, res) => res.api(null)))
                .toThrow(/needs the session option at creation/);
        });
    });

    describe('addSessionApi', () => {
        const profileApi = () => lambder.addSessionApi('user.profile', { input: z.any(), output: z.any() },
            async (ctx, resolver) => resolver.api({ userId: ctx.session.data.userId }));

        it('answers the protocol\'s sessionExpired flag when no session exists', async () => {
            profileApi();
            const response = await lambder.render(createMockEvent('/api', 'POST', 'deadbeef:facade', 'user.profile'), createMockContext());
            const body = JSON.parse(decodeBody(response) || '{}');
            expect(body.sessionExpired).toBe(true);
            expect(body.payload ?? null).toBeNull();
        });

        it('runs the handler with the session when the cookie and CSRF token match', async () => {
            const { token } = await plantRecord(store);
            profileApi();
            const response = await lambder.render(createMockEvent('/api', 'POST', token, 'user.profile'), createMockContext());
            expect(JSON.parse(decodeBody(response) || '{}').payload?.userId).toBe('123');
        });

        it('answers sessionExpired when the CSRF token is missing or wrong', async () => {
            const { token } = await plantRecord(store);
            profileApi();
            for(const csrf of ['', 'wrong-csrf-token']){
                const response = await lambder.render(createMockEvent('/api', 'POST', token, 'user.profile', {}, csrf), createMockContext());
                expect(JSON.parse(decodeBody(response) || '{}').sessionExpired).toBe(true);
            }
        });

        it('session guards see ctx.session, receive their param, and feed ctx.guardData', async () => {
            const { token } = await plantRecord(store, { data: { userId: '123', username: 'testuser', role: 'admin' } });
            const guarded = initLambder<UserSessionData>().create({
                files: new LambderLocalFileSource({ root: '/public' }),
                apiPath: '/api',
                session: { store, sessionSalt: 'test-salt' },
                guards: {
                    orgPermission: lambderGuard({
                        session: true,
                        handler: (ctx, _payload, permission: string) => ({ subject: ctx.session.sessionKey, permission }),
                    }),
                },
            }).addSessionApi('org.action', { input: z.any(), output: z.any(), guards: { orgPermission: 'ORG.MANAGE' } },
                async (ctx, resolver) => resolver.api(ctx.guardData.orgPermission));

            const response = await guarded.render(createMockEvent('/api', 'POST', token, 'org.action'), createMockContext());
            expect(JSON.parse(decodeBody(response) || '{}').payload).toEqual({ subject: 'user-123', permission: 'ORG.MANAGE' });
        });

        it('the named opt-out guard under requireSessionApiGuards lets the handler run on the session alone', async () => {
            const { token } = await plantRecord(store);
            const strict = initLambder<UserSessionData>().create({
                files: new LambderLocalFileSource({ root: '/public' }),
                apiPath: '/api',
                session: { store, sessionSalt: 'test-salt' },
                guards: { sessionOnly: lambderGuard({ session: true, handler: () => {} }) },
                requireSessionApiGuards: true,
            }).addSessionApi('me.session', { input: z.any(), output: z.any(), guards: 'sessionOnly' },
                async (ctx, resolver) => resolver.api({ userId: ctx.session.data.userId }));

            const response = await strict.render(createMockEvent('/api', 'POST', token, 'me.session'), createMockContext());
            expect(JSON.parse(decodeBody(response) || '{}').payload).toEqual({ userId: '123' });
        });

        it('hands the handler typed session data', async () => {
            const { token } = await plantRecord(store, { data: { userId: '123', username: 'testuser', role: 'admin' } });
            lambder.addSessionApi('user.profile', { input: z.any(), output: z.any() }, async (ctx, resolver) => {
                const userId: string = ctx.session.data.userId;
                const role: 'admin' | 'user' | 'guest' = ctx.session.data.role;
                return resolver.api({ userId, role });
            });
            const response = await lambder.render(createMockEvent('/api', 'POST', token, 'user.profile'), createMockContext());
            expect(JSON.parse(decodeBody(response) || '{}').payload).toEqual({ userId: '123', role: 'admin' });
        });

        it('a handler creates a session through the controller and the answer carries its cookies', async () => {
            lambder.addApi('login', { input: z.object({ user: z.string() }), output: z.any() }, async (ctx, res) => {
                const session = await lambder.getSessionController(ctx).createSession(ctx.apiPayload.user, { userId: '9', username: ctx.apiPayload.user, role: 'user' });
                return res.api({ key: session.sessionKey });
            });
            const response = await lambder.render(createMockEvent('/api', 'POST', undefined, 'login', { user: 'ada' }), createMockContext());
            expect(JSON.parse(decodeBody(response) || '{}').payload).toEqual({ key: 'ada' });
            const cookies = response.multiValueHeaders?.['Set-Cookie'] ?? [];
            expect(cookies.length).toBe(2);
            expect(cookies[0]).toMatch(/^LMDRSESSIONTKID=/);
            expect(cookies[1]).toMatch(/^LMDRSESSIONCSTK=/);
            expect(store.size).toBe(1);
        });
    });

    describe('addSessionApi with dataRefresh', () => {
        const makeRefreshingLambder = (refresh: (session: LambderSessionRecord<UserSessionData>) => Promise<UserSessionData | null>) =>
            initLambder<UserSessionData>().create({
                files: new LambderLocalFileSource({ root: '/public' }), apiPath: '/api',
                session: { store, sessionSalt: 'test-salt', dataRefresh: { ttlSeconds: 600, refresh } },
            });

        it('hands handlers renewed data when the session data is stale', async () => {
            const { token } = await plantRecord(store, { dataExpiresAt: nowSec() - 10 });
            const app = makeRefreshingLambder(async (session) => ({ ...session.data, role: 'admin' as const }))
                .addSessionApi('user.profile', { input: z.any(), output: z.any() }, async (ctx, resolver) => resolver.api({ role: ctx.session.data.role }));
            const response = await app.render(createMockEvent('/api', 'POST', token, 'user.profile'), createMockContext());
            expect(JSON.parse(decodeBody(response) || '{}').payload?.role).toBe('admin');
            expect(store.list()[0]!.data.role).toBe('admin');
        });

        it('answers sessionExpired when the refresh callback ends the session', async () => {
            const { token } = await plantRecord(store, { dataExpiresAt: nowSec() - 10 });
            const app = makeRefreshingLambder(async () => null)
                .addSessionApi('user.profile', { input: z.any(), output: z.any() }, async (ctx, resolver) => resolver.api({ role: ctx.session.data.role }));
            const response = await app.render(createMockEvent('/api', 'POST', token, 'user.profile'), createMockContext());
            expect(JSON.parse(decodeBody(response) || '{}').sessionExpired).toBe(true);
            expect(store.size).toBe(0);
        });
    });
});

// ── dataRefresh: opt-in freshness for session.data ───────────────────────────

describe('LambderSessionManager dataRefresh', () => {
    let store: LambderMemorySessionStore;
    beforeEach(() => { store = new LambderMemorySessionStore(); });

    const makePlainManager = () => new LambderSessionManager({ store, sessionSalt: SALT });
    const makeManager = (refresh: (session: LambderSessionRecord) => Promise<any>) =>
        new LambderSessionManager({ store, sessionSalt: SALT, enableSlidingExpiration: true, dataRefresh: { ttlSeconds: 600, refresh } });

    it('createSession stamps dataExpiresAt only when configured', async () => {
        const { session } = await makeManager(async (s) => s.data).createSession('user-123', {}, 3600);
        expect(session.dataExpiresAt).toBeGreaterThanOrEqual(nowSec() + 599);
        const { session: plainSession } = await makePlainManager().createSession('user-123', {}, 3600);
        expect(plainSession.dataExpiresAt).toBeUndefined();
    });

    it('does not run refresh before dataExpiresAt', async () => {
        const refresh = vi.fn(async () => ({ role: 'admin' }));
        const { token } = await plantRecord(store, { data: { role: 'user' }, dataExpiresAt: nowSec() + 600 });
        const session = await readSession(makeManager(refresh), token);
        expect(refresh).not.toHaveBeenCalled();
        expect(session?.data).toEqual({ role: 'user' });
    });

    it('renews stale data and shares one write with the sliding-expiration write', async () => {
        const refresh = vi.fn(async () => ({ role: 'admin' }));
        const { token } = await plantRecord(store, { data: { role: 'user' }, dataExpiresAt: nowSec() - 10, lastAccessedAt: nowSec() - 3000 });
        const put = vi.spyOn(store, 'put');

        const session = await readSession(makeManager(refresh), token);

        expect(refresh).toHaveBeenCalledOnce();
        expect(session?.data).toEqual({ role: 'admin' });
        expect(session?.dataExpiresAt).toBeGreaterThanOrEqual(nowSec() + 599);
        expect(put).toHaveBeenCalledOnce();
        expect(store.list()[0]!.data).toEqual({ role: 'admin' });
    });

    it('renews records that predate dataRefresh on first read', async () => {
        const refresh = vi.fn(async () => ({ role: 'admin' }));
        const { token } = await plantRecord(store, { data: { role: 'user' } });
        const session = await readSession(makeManager(refresh), token);
        expect(refresh).toHaveBeenCalledOnce();
        expect(session?.data).toEqual({ role: 'admin' });
    });

    it('refresh returning null deletes the session and reports no session', async () => {
        const { token } = await plantRecord(store, { dataExpiresAt: nowSec() - 10 });
        expect(await readSession(makeManager(async () => null), token)).toBeNull();
        expect(store.size).toBe(0);
    });

    it('a throwing refresh fails the read and keeps the session record', async () => {
        const { token } = await plantRecord(store, { dataExpiresAt: nowSec() - 10 });
        await expect(readSession(makeManager(async () => { throw new Error('db down'); }), token)).rejects.toBeInstanceOf(LambderSessionDataRefreshError);
        expect(store.size).toBe(1);
    });

    it('updateSessionData re-stamps dataExpiresAt', async () => {
        const { record } = await plantRecord(store, { dataExpiresAt: nowSec() - 10 });
        const updated = await makeManager(async (s) => s.data).updateSessionData(record, { role: 'editor' });
        expect(updated.dataExpiresAt).toBeGreaterThanOrEqual(nowSec() + 599);
    });

    it('refreshSessionData forces a renewal even when data is fresh', async () => {
        const refresh = vi.fn(async () => ({ role: 'admin' }));
        const { record } = await plantRecord(store, { dataExpiresAt: nowSec() + 600 });
        const refreshed = await makeManager(refresh).refreshSessionData(record);
        expect(refresh).toHaveBeenCalledOnce();
        expect(refreshed?.data).toEqual({ role: 'admin' });
        expect(store.list()[0]!.data).toEqual({ role: 'admin' });
    });

    it('refreshSessionData throws when dataRefresh is not configured', async () => {
        const { record } = await plantRecord(store);
        await expect(makePlainManager().refreshSessionData(record)).rejects.toThrow('dataRefresh is not configured');
    });

    it('regenerateSession carries dataExpiresAt over instead of extending it', async () => {
        const oldStamp = nowSec() + 120;
        const { record } = await plantRecord(store, { dataExpiresAt: oldStamp });
        const regenerated = await makeManager(async (s) => s.data).regenerateSession(record);
        expect(regenerated.session.dataExpiresAt).toBe(oldStamp);
    });

    it('deleteSessionAllByKey derives the partition hash internally', async () => {
        const manager = makeManager(async (s) => s.data);
        await manager.createSession('user-123', {});
        await manager.createSession('user-123', {});
        await manager.createSession('user-999', {});
        await manager.deleteSessionAllByKey('user-123');
        expect(store.list().map((record) => record.sessionKey)).toEqual(['user-999']);
    });
});

describe('LambderSessionController dataRefresh', () => {
    let store: LambderMemorySessionStore;
    beforeEach(() => { store = new LambderMemorySessionStore(); });

    const makeController = (refresh: (session: LambderSessionRecord) => Promise<any>, token: string) => {
        const manager = new LambderSessionManager({ store, sessionSalt: SALT, dataRefresh: { ttlSeconds: 600, refresh } });
        const ctx = createApiCallContext();
        const controller = new LambderSessionController({
            manager, tokenCookieKey: 'sessionToken', csrfCookieKey: 'csrfToken', ctx,
            request: { host: 'localhost', cookies: { sessionToken: [token] }, csrfToken: 'csrf-token' },
        });
        return { controller, ctx };
    };

    it('refreshSessionData updates ctx.session in place', async () => {
        const { token } = await plantRecord(store, { data: { role: 'user' }, dataExpiresAt: nowSec() + 600 });
        const { controller, ctx } = makeController(async () => ({ role: 'admin' }), token);
        await controller.fetchSession();
        const refreshed = await controller.refreshSessionData();
        expect(refreshed?.data).toEqual({ role: 'admin' });
        expect(ctx.session?.data).toEqual({ role: 'admin' });
    });

    it('refreshSessionData ending the session clears cookies and nulls ctx.session', async () => {
        const { token } = await plantRecord(store, { dataExpiresAt: nowSec() + 600 });
        const { controller, ctx } = makeController(async () => null, token);
        await controller.fetchSession();
        const refreshed = await controller.refreshSessionData();
        expect(refreshed).toBeNull();
        expect(ctx.session).toBeNull();
        expect(setCookiesOf(ctx).length).toBe(2);
    });

    it('fetchSessionIfExists rethrows dataRefresh failures instead of reporting no session', async () => {
        const { token } = await plantRecord(store, { dataExpiresAt: nowSec() - 10 });
        const { controller } = makeController(async () => { throw new Error('db down'); }, token);
        await expect(controller.fetchSessionIfExists()).rejects.toBeInstanceOf(LambderSessionDataRefreshError);
    });

    it('deleteSessionAllByKey and expireSessionDataAllByKey work without a fetched session', async () => {
        const manager = new LambderSessionManager({ store, sessionSalt: SALT, dataRefresh: { ttlSeconds: 600, refresh: async (s) => s.data } });
        await manager.createSession('user-123', {});
        const { controller } = makeController(async (s) => s.data, 'f00d:0ff');
        await controller.expireSessionDataAllByKey('user-123');
        expect(store.list()[0]!.dataExpiresAt).toBeLessThanOrEqual(nowSec());
        await controller.deleteSessionAllByKey('user-123');
        expect(store.size).toBe(0);
    });
});

// ── expireSessionDataAllByKey: apply a subject's auth change now ────────────

describe('LambderSessionManager expireSessionDataAllByKey', () => {
    let store: LambderMemorySessionStore;
    beforeEach(() => { store = new LambderMemorySessionStore(); });
    const makeManager = () => new LambderSessionManager({ store, sessionSalt: SALT, dataRefresh: { ttlSeconds: 600, refresh: async (session) => session.data } });

    it('stamps dataExpiresAt to now on every session of the key and no other', async () => {
        const manager = makeManager();
        await manager.createSession('user-123', {});
        await manager.createSession('user-123', {});
        const other = await manager.createSession('user-999', {});

        await expect(manager.expireSessionDataAllByKey('user-123')).resolves.toBe(true);

        for(const record of store.list()){
            if(record.sessionKey === 'user-123') expect(record.dataExpiresAt).toBeLessThanOrEqual(nowSec());
            else expect(record.dataExpiresAt).toBe(other.session.dataExpiresAt);
        }
    });

    it('skips a session deleted between the listing and the stamp; other failures propagate', async () => {
        const manager = makeManager();
        await manager.createSession('user-123', {});
        const listed = store.listSecretHashes.bind(store);
        vi.spyOn(store, 'listSecretHashes').mockImplementation(async (hash) => { const hashes = await listed(hash); store.reset(); return hashes; });
        await expect(manager.expireSessionDataAllByKey('user-123')).resolves.toBe(true);

        vi.spyOn(store, 'markDataExpired').mockRejectedValue(new Error('store down'));
        vi.spyOn(store, 'listSecretHashes').mockResolvedValue(['x']);
        await expect(manager.expireSessionDataAllByKey('user-123')).rejects.toThrow('store down');
    });

    it('requires dataRefresh to be configured', async () => {
        await expect(new LambderSessionManager({ store, sessionSalt: SALT }).expireSessionDataAllByKey('user-123'))
            .rejects.toThrow(/dataRefresh is not configured/);
    });

    it('a stamped session renews its data on the next read', async () => {
        const refresh = vi.fn(async () => ({ role: 'admin' }));
        const manager = new LambderSessionManager({ store, sessionSalt: SALT, dataRefresh: { ttlSeconds: 600, refresh } });
        const { sessionToken } = await manager.createSession('user-123', { role: 'user' });
        await manager.expireSessionDataAllByKey('user-123');

        const session = await readSession(manager, sessionToken);
        expect(refresh).toHaveBeenCalledOnce();
        expect(session?.data).toEqual({ role: 'admin' });
    });
});
