/**
 * Where in a call each rate-limit policy is checked.
 *
 * A policy whose key is known from the request alone (`per: "ip"`) runs
 * BEFORE the session is read, because the session read is one of the things
 * it exists to bound: a bogus session cookie costs a store scan plus a read
 * per candidate. `per: "session"` runs after the session read and before the
 * guards. A custom key runs after the guards by default: it is a
 * caller-chosen value (an email in the payload), and charging it earlier would
 * let a caller the guards refuse spend a victim's budget. A policy that must
 * count what the guards refuse (guesses at a code a guard checks) says
 * `chargeAt: "beforeGuards"`.
 *
 * Also how a per-IP counter keys an IPv6 caller: by its /64, since the
 * interface id inside it is the caller's to rotate.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../src/core/Lambder.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import { LambderMemoryRateLimiter } from '../src/stores/LambderMemoryRateLimiter.js';
import { lambderGuard, lambderRateLimitKey } from '../src/core/LambderPolicyBuilders.js';
import type { LambderSessionRecord, LambderSessionStore } from '../src/shared/contracts/LambderSessionStore.js';
import { createApiEvent, createMockContext, testPublicFiles } from './helpers.js';
import { lambderTestApp, assertApiFailure, assertApiSuccess } from '../src/testing.js';
import { refuse } from '../src/shared/wire/LambderApiRefusal.js';
import { normalizeClientIp, rateLimitSubjectOf, resolveClientIp } from '../src/shared/util/LambderClientIp.js';

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
    async create(record: LambderSessionRecord<any>): Promise<void> { await this.inner.create(record); }
    async update(...args: Parameters<LambderSessionStore<any>['update']>): ReturnType<LambderSessionStore<any>['update']> { return await this.inner.update(...args); }
    async delete(sessionKeyHash: string, secretHash: string): Promise<LambderSessionRecord<any> | null> { return await this.inner.delete(sessionKeyHash, secretHash); }
    async listSecretHashes(sessionKeyHash: string): Promise<string[]> {
        this.reads += 1;
        return await this.inner.listSecretHashes(sessionKeyHash);
    }
}

describe('Rate limits and the session read', () => {
    it('refuses a flood of bogus session cookies before the session store is asked', async () => {
        // Ten requests against a perMin: 1 policy. With the session read
        // first, every request would be answered sessionExpired after its
        // store reads, and the limiter would never refuse one.
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

        const statuses: Array<number | undefined> = [];
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
        // Two distinct source IPs: callers with no source IP would all share
        // the empty-string counter, and a per-caller limit would look the
        // same as a global one.
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

describe('Custom keys and the guards', () => {
    it('lets no caller the guards refuse spend somebody else\'s budget', async () => {
        // The documented shape: a per-email budget shared by send, register
        // and reset, behind a captcha. Charged before the guards, it would
        // let a caller who never solves a captcha lock the victim out forever.
        const app = lambderTestApp(initLambder().create({
            apiPath: '/api',
            rateLimits: {
                limiter: new LambderMemoryRateLimiter(),
                policies: {
                    codePerEmail: {
                        perMin: 2, budget: 'perPolicy',
                        per: lambderRateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email }),
                    },
                },
            },
            guards: {
                captcha: lambderGuard({ guardInput: z.object({ token: z.string() }), handler: async (_ctx, { token }) => { if(token !== 'solved') refuse('Verification failed.'); } }),
            },
        }).addApi('code.send', { input: z.object({ email: z.string() }), output: z.object({ sent: z.boolean() }), rateLimit: 'codePerEmail', guards: 'captcha' },
            async (_ctx, res) => res.api({ sent: true })));

        const attacker = app.visitor({ clientIp: '198.51.100.1' });
        for(let attempt = 0; attempt < 5; attempt += 1){
            assertApiFailure(await attacker.apiOutcome('code.send', { email: 'victim@example.com' }, { guardInputs: { captcha: { token: 'wrong' } } }), 'errorMessage');
        }

        const victim = app.visitor({ clientIp: '203.0.113.9' });
        assertApiSuccess(await victim.apiOutcome('code.send', { email: 'victim@example.com' }, { guardInputs: { captcha: { token: 'solved' } } }));
    });

    it('counts the guesses a guard refuses when the policy is charged before the guards', async () => {
        // A one-time code checked by a guard, limited per email: charged
        // after the guard, every wrong guess would be refused before it was
        // ever counted, and the code could be guessed without limit.
        const app = lambderTestApp(initLambder().create({
            apiPath: '/api',
            rateLimits: {
                limiter: new LambderMemoryRateLimiter(),
                policies: {
                    guessPerEmail: {
                        perMin: 3, chargeAt: 'beforeGuards',
                        per: lambderRateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email }),
                    },
                },
            },
            guards: {
                emailCode: lambderGuard({ apiInput: z.object({ code: z.string() }), handler: async (_ctx, { code }) => { if(code !== '424242') refuse('Wrong code.'); } }),
            },
        }).addApi('code.verify', { input: z.object({ email: z.string(), code: z.string() }), output: z.object({ verified: z.boolean() }), rateLimit: 'guessPerEmail', guards: 'emailCode' },
            async (_ctx, res) => res.api({ verified: true })));

        const guesser = app.visitor({ clientIp: '198.51.100.1' });
        const statuses: Array<number | undefined> = [];
        for(let guess = 0; guess < 5; guess += 1){
            const outcome = await guesser.apiOutcome('code.verify', { email: 'victim@example.com', code: String(100000 + guess) });
            statuses.push(outcome.ok ? 200 : outcome.status);
        }
        // Three wrong guesses refused by the guard, then the limit.
        expect(statuses.map((status) => status === 429)).toEqual([false, false, false, true, true]);
        // Even the right code is refused once the budget is spent.
        const right = await guesser.apiOutcome('code.verify', { email: 'victim@example.com', code: '424242' });
        expect(right.ok ? 200 : right.status).toBe(429);
    });

    it('takes chargeAt only on a policy keyed by a custom key', () => {
        expect(() => initLambder().create({
            apiPath: '/api',
            rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: { perIp: { per: 'ip', perMin: 1, chargeAt: 'beforeGuards' } } },
        })).toThrow(/only a policy keyed by a \{ apiInput\?, handler \} key takes/);
    });
});

describe('Guards placed after input validation', () => {
    /** The documented captcha, spending a single-use token, and a per-email budget keyed from the payload. */
    const captchaApp = (placement: { runAt?: 'beforeInputValidation' | 'afterInputValidation' }) => {
        const spent: string[] = [];
        const order: string[] = [];
        const app = lambderTestApp(initLambder().create({
            apiPath: '/api',
            rateLimits: {
                limiter: new LambderMemoryRateLimiter(),
                policies: {
                    codePerEmail: {
                        perMin: 1, budget: 'perPolicy',
                        per: lambderRateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => { order.push('limit'); return email; } }),
                    },
                },
            },
            guards: {
                session: lambderGuard({ handler: () => { order.push('free guard'); } }),
                captcha: lambderGuard({
                    ...placement,
                    guardInput: z.object({ token: z.string() }),
                    handler: async (_ctx, { token }) => {
                        order.push('captcha');
                        if(spent.includes(token)) refuse('Verification failed.');
                        spent.push(token);
                    },
                }),
            },
        }).addApi('code.send', {
            input: z.object({ email: z.string().email() }),
            output: z.object({ sent: z.boolean() }),
            rateLimit: 'codePerEmail',
            guards: ['session', 'captcha'],
        }, async (_ctx, res) => res.api({ sent: true })));
        return { app, spent, order };
    };

    it('does not spend a single-use token on a request refused for its input', async () => {
        const { app, spent, order } = captchaApp({ runAt: 'afterInputValidation' });
        const visitor = app.visitor();

        assertApiFailure(await visitor.apiOutcome('code.send', { email: 'not-an-email' }, { guardInputs: { captcha: { token: 't1' } } }), 'validation');
        expect(spent).toEqual([]);
        // Nor charged the per-email budget, which is spent only once everything else passed.
        expect(order).toEqual(['free guard']);

        // The corrected form goes through on the same token.
        assertApiSuccess(await visitor.apiOutcome('code.send', { email: 'ada@example.com' }, { guardInputs: { captcha: { token: 't1' } } }));
        expect(order).toEqual(['free guard', 'free guard', 'captcha', 'limit']);
    });

    it('runs a guard before validation by default, so a refused caller learns nothing of the input', async () => {
        const { app, spent } = captchaApp({});
        const visitor = app.visitor();

        assertApiFailure(await visitor.apiOutcome('code.send', { email: 'not-an-email' }, { guardInputs: { captcha: { token: 't1' } } }), 'validation');
        expect(spent).toEqual(['t1']);
    });

    it('reads a guard\'s own slice of the payload as it was sent, not as the input schema transformed it', async () => {
        const seen: unknown[] = [];
        const app = lambderTestApp(initLambder().create({
            apiPath: '/api',
            guards: {
                amountCheck: lambderGuard({
                    runAt: 'afterInputValidation',
                    apiInput: z.object({ amount: z.string() }),
                    handler: (_ctx, { amount }) => { seen.push(amount); },
                }),
            },
        }).addApi('pay', {
            input: z.object({ amount: z.string().transform(Number) }),
            output: z.object({ amount: z.number() }),
            guards: 'amountCheck',
        }, async (ctx, res) => res.api({ amount: ctx.apiPayload.amount })));

        const outcome = await app.visitor().apiOutcome('pay', { amount: '12' });
        assertApiSuccess(outcome);
        expect(outcome.payload).toEqual({ amount: 12 });
        expect(seen).toEqual(['12']);
    });
});

describe('Per-IP counters and IPv6', () => {
    it('keys an IPv6 address by its /64, maps IPv4-mapped addresses to IPv4, and leaves IPv4 and non-addresses alone', () => {
        expect(rateLimitSubjectOf('2001:db8:1:2::1')).toBe('2001:db8:1:2:0:0:0:0/64');
        expect(rateLimitSubjectOf('2001:0DB8:0001:0002:ffff:eeee:dddd:cccc')).toBe('2001:db8:1:2:0:0:0:0/64');
        expect(rateLimitSubjectOf('2001:db8:1:2:3:4:5:6', 48)).toBe('2001:db8:1:0:0:0:0:0/48');
        expect(rateLimitSubjectOf('2001:db8:1:2:3:4:5:6', 56)).toBe('2001:db8:1:0:0:0:0:0/56');
        expect(rateLimitSubjectOf('2001:db8:1:2ff:3:4:5:6', 56)).toBe('2001:db8:1:200:0:0:0:0/56');
        expect(rateLimitSubjectOf('::ffff:192.0.2.1')).toBe('192.0.2.1');
        expect(rateLimitSubjectOf('192.0.2.1')).toBe('192.0.2.1');
        expect(rateLimitSubjectOf('not an address')).toBe('not an address');
    });

    it('reads the port off the viewer address by the header it came from, since CloudFront always appends one', () => {
        const viaCloudFront = (value: string) => resolveClientIp({ 'cloudfront-viewer-address': value }, '203.0.113.9', ['CloudFront-Viewer-Address']);
        expect(viaCloudFront('2001:db8:1:2:3:4:5:6:443')).toBe('2001:db8:1:2:3:4:5:6');
        expect(viaCloudFront('192.0.2.1:443')).toBe('192.0.2.1');
        expect(viaCloudFront('[2001:db8::1]:443')).toBe('2001:db8::1');
        // Regression: the port came off only when the text did not already
        // parse as an address. A compressed address still parses with its
        // port on, the port became its last group, and the /64 moved with
        // whichever interface-id groups the caller chose.
        expect(viaCloudFront('2600:3c00::1111:91ff:fe93:1234:443')).toBe('2600:3c00::1111:91ff:fe93:1234');
        expect(rateLimitSubjectOf(viaCloudFront('2600:3c00::1111:91ff:fe93:1234:443'))).toBe('2600:3c00:0:0:0:0:0:0/64');
    });

    it('reads a port off any other header only where the text says so: brackets, or IPv4 host:port', () => {
        expect(normalizeClientIp('[2001:db8::1]:443')).toBe('2001:db8::1');
        expect(normalizeClientIp('192.0.2.1:443')).toBe('192.0.2.1');
        expect(resolveClientIp({ 'x-forwarded-for': '[2001:db8::1]:443, 10.0.0.1' }, '203.0.113.9', ['x-forwarded-for'])).toBe('2001:db8::1');
        // An unbracketed address is an address, compressed or not.
        expect(normalizeClientIp('2001:db8::1:443')).toBe('2001:db8::1:443');
        expect(resolveClientIp({ 'x-forwarded-for': '2001:db8::1:443' }, '203.0.113.9', ['x-forwarded-for'])).toBe('2001:db8::1:443');
    });

    it('counts every address in one /64 as one caller', async () => {
        const app = lambderTestApp(initLambder().create({
            apiPath: '/api',
            rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: { perIp: { perMin: 2, per: 'ip' } } },
        }).addApi('ping', { input: z.object({}), output: z.object({ ok: z.boolean() }), rateLimit: 'perIp' }, async (_ctx, res) => res.api({ ok: true })));

        assertApiSuccess(await app.visitor({ clientIp: '2001:db8:1:2::a' }).apiOutcome('ping', {}));
        assertApiSuccess(await app.visitor({ clientIp: '2001:db8:1:2::b' }).apiOutcome('ping', {}));
        assertApiFailure(await app.visitor({ clientIp: '2001:db8:1:2::c' }).apiOutcome('ping', {}), 'errorMessage', { status: 429 });
        assertApiSuccess(await app.visitor({ clientIp: '2001:db8:1:3::a' }).apiOutcome('ping', {}));
    });

    it('refuses an ipv6PrefixLength that is not a prefix', () => {
        expect(() => initLambder().create({ apiPath: '/api', rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: { p: { perMin: 1, per: 'ip' } }, ipv6PrefixLength: 0 } }))
            .toThrow(/ipv6PrefixLength must be a whole number from 1 to 128/);
    });
});
