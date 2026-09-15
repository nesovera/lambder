/**
 * Where in a call each rate-limit policy is checked.
 *
 * A policy whose key is known from the request alone (`per: "ip"`) runs
 * BEFORE the session is read, because the session read is one of the things
 * it exists to bound: a request carrying a bogus session cookie costs a
 * store scan plus a read per candidate, and it used to be answered
 * sessionExpired without the limiter having run at all. Everything else runs
 * after the session, since `per: "session"` needs it and a custom key handler
 * is app code that may read it too.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../src/core/Lambder.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import { LambderMemoryRateLimiter } from '../src/stores/LambderMemoryRateLimiter.js';
import { lambderRateLimitKey } from '../src/core/LambderPolicyBuilders.js';
import type { LambderSessionRecord, LambderSessionStore } from '../src/shared/contracts/LambderSessionStore.js';
import { createApiEvent, createMockContext, testPublicFiles } from './helpers.js';

const testSchema = {
    input: z.object({ value: z.string() }),
    output: z.object({ result: z.string() }),
};

/** A memory session store that counts what the manager asked it for. */
class CountingSessionStore implements LambderSessionStore<any> {
    readonly isMemoryOnly = true;
    private inner = new LambderMemorySessionStore();
    reads = 0;

    async get(sessionKeyHash: string, secretHash: string): Promise<LambderSessionRecord<any> | null> {
        this.reads += 1;
        return await this.inner.get(sessionKeyHash, secretHash);
    }
    async put(record: LambderSessionRecord<any>): Promise<void> { await this.inner.put(record); }
    async delete(sessionKeyHash: string, secretHash: string): Promise<void> { await this.inner.delete(sessionKeyHash, secretHash); }
    async listSecretHashes(sessionKeyHash: string): Promise<string[]> {
        this.reads += 1;
        return await this.inner.listSecretHashes(sessionKeyHash);
    }
    async markDataExpired(sessionKeyHash: string, secretHash: string, at: number): Promise<void> {
        await this.inner.markDataExpired(sessionKeyHash, secretHash, at);
    }
}

describe('Rate limits and the session read', () => {
    it('refuses a flood of bogus session cookies before the session store is asked', async () => {
        // Ten requests against a perMin: 1 policy. Measured before the fix:
        // forty store reads and zero 429s, because the session read came
        // first and every request was answered sessionExpired on its own.
        const store = new CountingSessionStore();
        const lambder = initLambder<{ role: string }>().create({
            files: testPublicFiles(),
            apiPath: '/api',
            session: { store, sessionSalt: 'salt' },
            rateLimits: {
                limiter: new LambderMemoryRateLimiter(),
                policies: { perIp: { perMin: 1, per: 'ip' } },
            },
        }).addSessionApi('secure.read', { ...testSchema, rateLimit: 'perIp' }, async (_ctx, res) => res.api({ result: 'ok' }));

        const bogusCookie = `${'a'.repeat(64)}:${'b'.repeat(64)}.${'c'.repeat(64)}`;
        const call = () => lambder.render(createApiEvent(
            { apiName: 'secure.read', payload: { value: 'x' } },
            { headers: { Host: 'localhost', Cookie: `LMDRSESSIONTKID=${bogusCookie}; LMDRSESSIONCSTK=nope` } },
        ), createMockContext());

        const statuses: number[] = [];
        for(let i = 0; i < 10; i += 1) statuses.push((await call()).statusCode);

        expect(statuses.filter((status) => status === 429).length).toBe(9);
        expect(store.reads).toBeLessThanOrEqual(1);
    });

    it('still runs a session-keyed policy, which needs the session the read produced', async () => {
        const store = new LambderMemorySessionStore();
        const lambder = initLambder<{ role: string }>().create({
            files: testPublicFiles(),
            apiPath: '/api',
            session: { store, sessionSalt: 'salt' },
            rateLimits: {
                limiter: new LambderMemoryRateLimiter(),
                policies: { perUser: { perMin: 1, per: 'session' } },
            },
        }).addSessionApi('secure.write', { ...testSchema, rateLimit: 'perUser' }, async (_ctx, res) => res.api({ result: 'ok' }));

        const { sessionToken, csrfToken } = await lambder.getSessionManager().createSession('u1', { role: 'admin' });
        const call = () => lambder.render(createApiEvent(
            { apiName: 'secure.write', payload: { value: 'x' }, token: csrfToken },
            { headers: { Host: 'localhost', Cookie: `LMDRSESSIONTKID=${sessionToken}; LMDRSESSIONCSTK=${csrfToken}` } },
        ), createMockContext());

        expect((await call()).statusCode).toBe(200);
        expect((await call()).statusCode).toBe(429);
    });

    it('keys a per-ip counter by the address the gateway reported, so two callers do not share one', async () => {
        // Every per: "ip" test used to run without a source IP at all, so
        // every caller in the suite shared the empty-string counter and a
        // per-caller limit was indistinguishable from a global one.
        const lambder = initLambder().create({
            files: testPublicFiles(),
            apiPath: '/api',
            rateLimits: {
                limiter: new LambderMemoryRateLimiter(),
                policies: { perIp: { perMin: 1, per: 'ip' } },
            },
        }).addApi('public.ping', { ...testSchema, rateLimit: 'perIp' }, async (_ctx, res) => res.api({ result: 'ok' }));

        const call = (sourceIp: string) => lambder.render(
            createApiEvent({ apiName: 'public.ping', payload: { value: 'x' } }, { sourceIp }),
            createMockContext(),
        );

        expect((await call('203.0.113.7')).statusCode).toBe(200);
        // A different address: its own counter, not the first caller's.
        expect((await call('198.51.100.9')).statusCode).toBe(200);
        expect((await call('203.0.113.7')).statusCode).toBe(429);
        expect((await call('198.51.100.9')).statusCode).toBe(429);
    });

    it('a custom key handler runs after the session read, so it may read the session', async () => {
        const store = new LambderMemorySessionStore();
        const seen: (string | null)[] = [];
        const lambder = initLambder<{ role: string }>().create({
            files: testPublicFiles(),
            apiPath: '/api',
            session: { store, sessionSalt: 'salt' },
            rateLimits: {
                limiter: new LambderMemoryRateLimiter(),
                policies: {
                    perRole: {
                        perMin: 5,
                        per: lambderRateLimitKey({ handler: (ctx) => {
                            const role = (ctx.session as { data?: { role?: string } } | null)?.data?.role ?? null;
                            seen.push(role);
                            return role ?? 'anonymous';
                        } }),
                    },
                },
            },
        }).addSessionApi('secure.role', { ...testSchema, rateLimit: 'perRole' }, async (_ctx, res) => res.api({ result: 'ok' }));

        const { sessionToken, csrfToken } = await lambder.getSessionManager().createSession('u1', { role: 'admin' });
        const result = await lambder.render(createApiEvent(
            { apiName: 'secure.role', payload: { value: 'x' }, token: csrfToken },
            { headers: { Host: 'localhost', Cookie: `LMDRSESSIONTKID=${sessionToken}; LMDRSESSIONCSTK=${csrfToken}` } },
        ), createMockContext());

        expect(result.statusCode).toBe(200);
        expect(seen).toEqual(['admin']);
    });
});
