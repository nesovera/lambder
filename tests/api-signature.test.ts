/**
 * The per-endpoint signature gate: how an endpoint's shape is digested, how
 * the map a client ships with is built, what the server does with the
 * signature a call carries, and how a stale bundle is kept from reloading
 * itself forever.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { testPublicFiles, createApiEvent, createMockContext, decodeBody } from './helpers.js';
import { initLambder } from '../src/core/Lambder.js';
import { lambderGuard } from '../src/core/LambderPolicyBuilders.js';
import LambderCaller from '../src/client/LambderCaller.js';
import LambderInvokeCaller from '../src/invoke/LambderInvokeCaller.js';
import { lambderHandlerTransport } from '../src/invoke/lambderHandlerTransport.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import { apiSignatureOf, LambderApiSignatureDigests } from '../src/api/LambderApiSignature.js';
import { apiNameKeyOf, lookupApiSignature, readApiSignature, API_SIGNATURE_HEX_LENGTH } from '../src/shared/wire/LambderApiSignature.js';
import { LambderReloadLoopBreaker, RELOAD_LOOP_WINDOW_MS } from '../src/client/LambderReloadLoopBreaker.js';
import type { LambderApiDefinition } from '../src/api/LambderApiDefinition.js';
import type { LambderApiTransport } from '../src/shared/transport/LambderApiTransport.js';

const userInput = z.object({ id: z.string() });
const userOutput = z.object({ id: z.string(), name: z.string() });
const definition = (overrides: Partial<LambderApiDefinition> = {}): LambderApiDefinition =>
    ({ name: 'user.get', mode: 'public', input: userInput, output: userOutput, ...overrides });

const guards = {
    org: lambderGuard({ guardInput: z.object({ organizationId: z.string() }), handler: () => {} }),
    owner: lambderGuard({ apiInput: z.object({ id: z.string() }), handler: () => {} }),
    plain: lambderGuard({ handler: () => {} }),
};

describe('The signature digest', () => {
    it('keys the map by sha256 of the prefixed name, cut to the shared length, frozen against node:crypto', async () => {
        // Frozen rather than computed with the code under test: the generated
        // file a frontend ships with must keep matching what a server derives.
        const expected = createHash('sha256').update('lambder-api-name:user.get').digest('hex').slice(0, API_SIGNATURE_HEX_LENGTH);
        expect(await apiNameKeyOf('user.get')).toBe(expected);
        expect(API_SIGNATURE_HEX_LENGTH).toBe(16);
    });

    it('is the same for the same shape built twice, and hex of the shared length', async () => {
        const a = await apiSignatureOf(definition(), guards);
        const b = await apiSignatureOf({ name: 'user.get', mode: 'public', input: z.object({ id: z.string() }), output: z.object({ id: z.string(), name: z.string() }) }, guards);
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{16}$/);
    });

    it('changes with everything a client can see, and with nothing else', async () => {
        const base = await apiSignatureOf(definition(), guards);
        const changed = await Promise.all([
            apiSignatureOf(definition({ name: 'user.fetch' }), guards),
            apiSignatureOf(definition({ mode: 'session' }), guards),
            apiSignatureOf(definition({ input: z.object({ id: z.string(), full: z.boolean() }) }), guards),
            apiSignatureOf(definition({ output: z.object({ id: z.string() }) }), guards),
            apiSignatureOf(definition({ guards: 'org' }), guards),
            apiSignatureOf(definition({ guards: 'owner' }), guards),
            apiSignatureOf(definition({ idempotency: true }), guards),
            // A description is part of what zod emits, so it is part of the shape.
            apiSignatureOf(definition({ input: z.object({ id: z.string().describe('the id') }) }), guards),
        ]);
        for(const other of changed) expect(other).not.toBe(base);
        expect(new Set(changed).size).toBe(changed.length);

        // A guard with no schema, a rate limit and an explicit idempotency
        // opt-out add nothing a client sends or receives.
        expect(await apiSignatureOf(definition({ guards: 'plain' }), guards)).toBe(await apiSignatureOf(definition({ guards: { plain: true } }), guards));
        expect(await apiSignatureOf(definition({ rateLimit: 'tight' }), guards)).toBe(base);
        expect(await apiSignatureOf(definition({ idempotency: false }), guards)).toBe(base);
        // The guard schema is what counts, not the parameter beside its name.
        expect(await apiSignatureOf(definition({ guards: { org: 'READ' } }), guards)).toBe(await apiSignatureOf(definition({ guards: { org: 'WRITE' } }), guards));
    });

    it('digests each definition once and answers null for an unknown endpoint', async () => {
        const digests = new LambderApiSignatureDigests(guards);
        const def = definition();
        expect(digests.signatureOf(def)).toBe(digests.signatureOf(def));
        expect(await digests.expectedSignatureOf('user.get', def)).toBe(await apiSignatureOf(def, guards));
        expect(await digests.expectedSignatureOf('nope', null)).toBeNull();
    });

    it('reads a map by the hashed name, and says what is missing', async () => {
        const map = { [await apiNameKeyOf('user.get')]: 'abc' };
        expect(await lookupApiSignature(map, 'user.get')).toBe('abc');
        expect(await lookupApiSignature(map, 'user.list')).toBeNull();
        expect(await readApiSignature(map, 'user.get')).toBe('abc');
        await expect(readApiSignature(map, 'user.list')).rejects.toThrow(/no signature for API "user.list"/);
    });
});

const createServer = () => {
    const app = initLambder<{ userId: string }>().create({
        files: testPublicFiles(),
        apiPath: '/api',
        apiVersion: '7',
        session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
        guards,
    });
    return app
        .addApi('user.get', { input: userInput, output: userOutput }, async (ctx, res) => res.api({ id: ctx.apiPayload.id, name: 'Ada' }))
        .addApi('org.get', { input: z.object({}), output: z.object({ ok: z.boolean() }), guards: 'org' }, async (_ctx, res) => res.api({ ok: true }))
        .addSessionApi('me', { input: z.void(), output: z.object({ userId: z.string() }) }, async (ctx, res) => res.api({ userId: ctx.session.data.userId }));
};

describe('The server and its map', () => {
    it('apiSignatures() lists every registered endpoint under its hashed name, sorted, with the digest the gate compares against', async () => {
        const server = createServer();
        const map = await server.apiSignatures();
        const keys = await Promise.all(['user.get', 'org.get', 'me'].map(apiNameKeyOf));
        expect(Object.keys(map).sort()).toEqual([...keys].sort());
        expect(Object.keys(map)).toEqual([...Object.keys(map)].sort());
        expect(map[keys[0]!]).toBe(await apiSignatureOf({ name: 'user.get', mode: 'public', input: userInput, output: userOutput }, guards));
        expect(map[keys[1]!]).toBe(await apiSignatureOf({ name: 'org.get', mode: 'public', input: z.object({}), output: z.object({ ok: z.boolean() }), guards: 'org' }, guards));
        // Nothing in the file names an endpoint.
        expect(JSON.stringify(map)).not.toContain('user.get');
    });

    it('runs a matching signature, refuses a stale one and an unknown signed name, and gates nothing that carries none', async () => {
        const server = createServer();
        const map = await server.apiSignatures();
        const bodyOf = async (body: Record<string, unknown>) => JSON.parse(decodeBody(await server.render(createApiEvent(body), createMockContext())));
        const signature = await readApiSignature(map, 'user.get');

        expect(await bodyOf({ apiName: 'user.get', payload: { id: '1' }, signature })).toEqual({ apiVersion: '7', payload: { id: '1', name: 'Ada' } });
        expect(await bodyOf({ apiName: 'user.get', payload: { id: '1' }, signature: 'an-older-shape' })).toEqual({ apiVersion: '7', payload: null, versionExpired: true });
        expect(await bodyOf({ apiName: 'user.get', payload: { id: '1' } })).toEqual({ apiVersion: '7', payload: { id: '1', name: 'Ada' } });
        // The version the caller names decides nothing any more.
        expect(await bodyOf({ apiName: 'user.get', payload: { id: '1' }, version: '1', signature })).toMatchObject({ payload: { id: '1', name: 'Ada' } });
        expect(await bodyOf({ apiName: 'gone', payload: {}, signature: 'from-another-contract' })).toEqual({ apiVersion: '7', payload: null, versionExpired: true });
        expect((await bodyOf({ apiName: 'gone', payload: {} })).errorMessage.code).toBe('lambder/api-not-found');
        // Ahead of the session read: a stale signed-out client hears "reload", not "log in".
        expect(await bodyOf({ apiName: 'me', signature: 'an-older-shape' })).toEqual({ apiVersion: '7', payload: null, versionExpired: true });
    });
});

/** An answer in the accessor form a transport resolves to. */
const answerWith = (envelope: Record<string, unknown>) => ({
    status: 200, statusText: 'OK', header: () => null, json: async () => envelope, text: async () => JSON.stringify(envelope),
});

/**
 * A fresh, empty sessionStorage for one test. The loop breaker keeps its
 * record there, and the test environment's storage would otherwise carry
 * one test's record into the next, as a real tab carries it across reloads.
 */
const withFreshSessionStorage = async (run: (store: Map<string, string>) => Promise<void> | void) => {
    const store = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
    try { await run(store); }
    finally { vi.unstubAllGlobals(); }
};

describe('LambderCaller with a signature map', () => {
    it('sends the endpoint\'s signature with every call, and nothing when it has no map', async () => {
        const server = createServer();
        const map = await server.apiSignatures();
        const seen: unknown[] = [];
        const observing = (inner: LambderApiTransport): LambderApiTransport => async (request) => { seen.push(request.signature); return await inner(request); };

        const signed = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, apiSignatures: map, transport: observing(lambderHandlerTransport(server.getHandler())) });
        expect(await signed.api('user.get', { id: '1' })).toEqual({ id: '1', name: 'Ada' });
        expect(seen).toEqual([await readApiSignature(map, 'user.get')]);

        const unsigned = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, transport: observing(lambderHandlerTransport(server.getHandler())) });
        expect(await unsigned.api('user.get', { id: '1' })).toEqual({ id: '1', name: 'Ada' });
        expect(seen.at(-1)).toBeUndefined();
    });

    it('fails a call for a name the map does not hold before anything is sent', async () => {
        const errors: Error[] = [];
        const transport = vi.fn<LambderApiTransport>(async () => answerWith({ apiVersion: '7', payload: 'ok' }));
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, apiSignatures: {}, transport, errorHandler: (err) => { errors.push(err); } });

        const outcome = await caller.apiOutcome('user.get', { id: '1' });

        expect(outcome).toMatchObject({ ok: false, reason: 'unknown' });
        expect(transport).not.toHaveBeenCalled();
        expect(errors.map((err) => err.message).join()).toMatch(/no signature for API "user.get"/);
    });

    it('calls versionExpiredHandler once for a stale signature, and reports a repeat instead of reloading again', () => withFreshSessionStorage(async () => {
        const map = { [await apiNameKeyOf('user.get')]: 'stale', [await apiNameKeyOf('org.get')]: 'stale-too' };
        const versionExpiredHandler = vi.fn();
        const errors: Error[] = [];
        const caller = new LambderCaller({
            apiPath: '/api', isCorsEnabled: false, apiSignatures: map, versionExpiredHandler,
            errorHandler: (err) => { errors.push(err); },
            transport: async () => answerWith({ apiVersion: '8', payload: null, versionExpired: true }),
        });

        // The first is the ordinary case: a reload is the right answer.
        expect(await caller.apiOutcome('user.get', { id: '1' })).toMatchObject({ ok: false, reason: 'versionExpired' });
        expect(versionExpiredHandler).toHaveBeenCalledOnce();
        expect(errors).toEqual([]);
        // The same endpoint failing with the same signature is the reload
        // having changed nothing: the handler stays quiet, the error says why,
        // and the outcome still names the reason.
        expect(await caller.apiOutcome('user.get', { id: '1' })).toMatchObject({ ok: false, reason: 'versionExpired' });
        expect(versionExpiredHandler).toHaveBeenCalledOnce();
        expect(errors.length).toBe(1);
        expect(errors[0]!.message).toMatch(/Version expired again for API "user.get"/);
        // Once confirmed, another endpoint of the same stale bundle does not
        // earn a reload of its own either.
        expect(await caller.apiOutcome('org.get', {}, { guardInputs: { org: { organizationId: 'o' } } })).toMatchObject({ ok: false, reason: 'versionExpired' });
        expect(versionExpiredHandler).toHaveBeenCalledOnce();
        expect(errors.length).toBe(2);
    }));
});

describe('LambderReloadLoopBreaker', () => {
    it('counts the same endpoint and signature inside the window as a repeat, then everything until the window passes', () => withFreshSessionStorage(() => {
        const breaker = new LambderReloadLoopBreaker();
        const t0 = 1_000_000;
        expect(breaker.isRepeat('a', 'sig-1', t0)).toBe(false);
        // A different signature for the same endpoint is a bundle that changed it: a real update, not a loop.
        expect(breaker.isRepeat('a', 'sig-2', t0 + 1_000)).toBe(false);
        expect(breaker.isRepeat('a', 'sig-2', t0 + 2_000)).toBe(true);
        // Confirmed: any endpoint within the window from the first event counts.
        expect(breaker.isRepeat('b', 'other', t0 + 3_000)).toBe(true);
        // The window runs from the first event of the loop, not from the last repeat.
        expect(breaker.isRepeat('b', 'other', t0 + 1_000 + RELOAD_LOOP_WINDOW_MS)).toBe(false);
        expect(breaker.isRepeat('b', 'other', t0 + 1_500 + RELOAD_LOOP_WINDOW_MS)).toBe(true);
    }));

    it('keeps its record in sessionStorage when there is one, so the next page instance sees it', () => withFreshSessionStorage((store) => {
        expect(new LambderReloadLoopBreaker().isRepeat('a', 'sig', 5_000)).toBe(false);
        // A fresh instance, as after a reload.
        expect(new LambderReloadLoopBreaker().isRepeat('a', 'sig', 6_000)).toBe(true);
        expect(store.size).toBe(1);
    }));

    it('keeps the record in memory for the page when there is no sessionStorage', () => {
        vi.stubGlobal('sessionStorage', undefined);
        try {
            const breaker = new LambderReloadLoopBreaker();
            expect(breaker.isRepeat('a', 'sig', 5_000)).toBe(false);
            expect(breaker.isRepeat('a', 'sig', 6_000)).toBe(true);
            expect(new LambderReloadLoopBreaker().isRepeat('a', 'sig', 7_000)).toBe(false);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('LambderInvokeCaller with a signature map', () => {
    it('sends the callee\'s signature for the endpoint, and fails a name the map lacks before invoking', async () => {
        const map = { [await apiNameKeyOf('user.get')]: 'callee-shape' };
        const bodies: Record<string, unknown>[] = [];
        const caller = new LambderInvokeCaller({
            functionName: 'callee', apiSignatures: map,
            transport: async (event) => {
                bodies.push(JSON.parse(event.body ?? '{}'));
                return { functionError: null, result: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiVersion: '1', payload: 'ok' }), isBase64Encoded: false } };
            },
        });

        expect(await caller.api('user.get', { id: '1' })).toBe('ok');
        expect(bodies[0]).toMatchObject({ apiName: 'user.get', signature: 'callee-shape' });

        const missing = await caller.apiOutcome('user.list', {});
        expect(missing.ok).toBe(false);
        if(!missing.ok){
            expect(missing.reason).toBe('unknown');
            expect((missing.error.cause as Error).message).toMatch(/no signature for API "user.list"/);
        }
        expect(bodies.length).toBe(1);

        // createEvent carries it too, for a boot check that hands a package an event file.
        const event = LambderInvokeCaller.createEvent({ apiName: 'user.get', signature: 'callee-shape' });
        expect(JSON.parse(event.body ?? '{}')).toMatchObject({ apiName: 'user.get', signature: 'callee-shape' });
    });
});
