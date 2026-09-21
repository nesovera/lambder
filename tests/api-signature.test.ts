/**
 * The per-endpoint signature gate: how an endpoint's shape is digested, how
 * the map a client ships with is built, what the server does with the
 * signature a call carries, and how a stale bundle is kept from reloading
 * itself forever.
 */
import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { testPublicFiles, createApiEvent, createMockContext, decodeBody } from './helpers.js';
import { initLambder } from '../src/core/Lambder.js';
import { lambderGuard } from '../src/core/LambderPolicyBuilders.js';
import LambderCaller from '../src/client/LambderCaller.js';
import LambderInvokeCaller from '../src/invoke/LambderInvokeCaller.js';
import { lambderHandlerTransport } from '../src/invoke/lambderHandlerTransport.js';
import { assertApiFailure } from '../src/shared/wire/LambderOutcomeAssertions.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import { apiSignatureOf } from '../src/api/LambderApiSignature.js';
import { apiNameKeyOf, lookupApiSignature, readApiSignature, extensibleEnum, API_SIGNATURE_HEX_LENGTH, type LambderApiSignatureMap } from '../src/shared/wire/LambderApiSignature.js';
import { LambderReloadLoopBreaker, RELOAD_LOOP_WINDOW_MS } from '../src/client/LambderReloadLoopBreaker.js';
import { compareDottedVersions, isDottedVersion } from '../src/shared/wire/LambderVersionOrder.js';
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

    it('hashes shape, not values: a default\'s value and the order of fields change nothing, and a function default is stable', async () => {
        // zod writes what a function default returned at conversion under
        // `default`; left in, the same endpoint digested differently on every
        // computation and the generated map never matched the server.
        const fromTheClock = () => z.object({ at: z.number().default(() => Date.now()), n: z.number().prefault(() => Math.random()), c: z.number().catch(() => Math.random()) });
        const first = await apiSignatureOf(definition({ input: fromTheClock() }), guards);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(await apiSignatureOf(definition({ input: fromTheClock() }), guards)).toBe(first);
        expect(await apiSignatureOf(definition({ input: z.object({ page: z.number().default(1) }) }), guards))
            .toBe(await apiSignatureOf(definition({ input: z.object({ page: z.number().default(2) }) }), guards));
        // That the field may be omitted is shape, and stays.
        expect(await apiSignatureOf(definition({ input: z.object({ page: z.number().default(1) }) }), guards))
            .not.toBe(await apiSignatureOf(definition({ input: z.object({ page: z.number() }) }), guards));
        expect(await apiSignatureOf(definition({ input: z.object({ a: z.string(), b: z.string() }) }), guards))
            .toBe(await apiSignatureOf(definition({ input: z.object({ b: z.string(), a: z.string() }) }), guards));
        // A field that happens to be called "default" is a field.
        expect(await apiSignatureOf(definition({ input: z.object({ default: z.string() }) }), guards))
            .not.toBe(await apiSignatureOf(definition({ input: z.object({ other: z.string() }) }), guards));
    });

    it('reads a map by the hashed name, and says what is missing', async () => {
        const map = { [await apiNameKeyOf('user.get')]: 'abc' };
        expect(await lookupApiSignature(map, 'user.get')).toBe('abc');
        expect(await lookupApiSignature(map, 'user.list')).toBeNull();
        expect(await readApiSignature(map, 'user.get')).toBe('abc');
        await expect(readApiSignature(map, 'user.list')).rejects.toThrow(/no signature for API "user.list"/);
    });

    it('resolves a name on the spot every time, keeping nothing between calls', async () => {
        // Nothing is memoized by name, and this is the assertion that says so:
        // on the server the name comes off the wire before anything has
        // checked that it is an endpoint, so a cache keyed by it would grow by
        // an entry for every name a request cared to invent. The digest the
        // gate actually rests on is the generator's, computed at build time.
        const map = { [await apiNameKeyOf('user.get')]: 'abc' };
        const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
        try {
            expect(await lookupApiSignature(map, 'user.get')).toBe('abc');
            expect(await lookupApiSignature(map, 'user.get')).toBe('abc');
            expect(await lookupApiSignature(map, 'invented-by-a-request')).toBeNull();
            expect(digest).toHaveBeenCalledTimes(3);
        } finally {
            digest.mockRestore();
        }
    });
});

describe('extensibleEnum', () => {
    const roles = ['admin', 'member'] as const;
    const moreRoles = ['admin', 'member', 'guest'] as const;
    // Nested the way a session nests one: an array, in an object, behind a nullable.
    const returning = (role: z.ZodType) => apiSignatureOf(definition({ output: z.object({ id: z.string(), user: z.object({ roles: z.array(role) }).nullable() }) }), guards);
    const accepting = (role: z.ZodType) => apiSignatureOf(definition({ input: z.object({ id: z.string(), role }) }), guards);

    it('leaves its values out of an output, so the list growing or shrinking reloads no reader', async () => {
        const base = await returning(extensibleEnum(z.enum(roles)));
        expect(await returning(extensibleEnum(z.enum(moreRoles)))).toBe(base);
        expect(await returning(extensibleEnum(z.enum(['admin'])))).toBe(base);
        // Still a string, so a change of type is still a change of shape.
        expect(await returning(z.number())).not.toBe(base);
        // Unmarked, the values count as they always have.
        expect(await returning(z.enum(moreRoles))).not.toBe(await returning(z.enum(roles)));
    });

    it('keeps its values in an input, where a value dropped from the list is a request the server now refuses', async () => {
        expect(await accepting(extensibleEnum(z.enum(moreRoles)))).not.toBe(await accepting(extensibleEnum(z.enum(roles))));
    });

    it('changes no input digest by being marked', async () => {
        expect(await accepting(extensibleEnum(z.enum(roles)))).toBe(await accepting(z.enum(roles)));
    });

    it('keeps the mark through a description, which clones the schema', async () => {
        // A clone keeps its parent's metadata in zod's registry. If that ever
        // stopped, the enum would quietly count in full again: this is the line
        // that notices.
        const described = (values: readonly [string, ...string[]]) => extensibleEnum(z.enum(values)).describe('a role');
        expect(await returning(described(moreRoles))).toBe(await returning(described(roles)));
    });

    it('is the same schema otherwise: the same type, the same validation', () => {
        const role = extensibleEnum(z.enum(roles));
        expectTypeOf(role).toEqualTypeOf<z.ZodEnum<{ admin: 'admin'; member: 'member' }>>();
        expect(role.parse('admin')).toBe('admin');
        expect(role.safeParse('guest').success).toBe(false);
    });
});

/** The server, given the map a previous instance generated, as a deployed server is given the file its own build generated. */
const createServer = (apiSignatures?: LambderApiSignatureMap) => {
    const app = initLambder<{ userId: string }>().create({
        files: testPublicFiles(),
        apiPath: '/api',
        apiVersion: '7',
        apiSignatures,
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
        const map = await createServer().apiSignatures();
        const keys = await Promise.all(['user.get', 'org.get', 'me'].map(apiNameKeyOf));
        expect(Object.keys(map).sort()).toEqual([...keys].sort());
        expect(Object.keys(map)).toEqual([...Object.keys(map)].sort());
        expect(map[keys[0]!]).toBe(await apiSignatureOf({ name: 'user.get', mode: 'public', input: userInput, output: userOutput }, guards));
        expect(map[keys[1]!]).toBe(await apiSignatureOf({ name: 'org.get', mode: 'public', input: z.object({}), output: z.object({ ok: z.boolean() }), guards: 'org' }, guards));
        // Nothing in the file names an endpoint.
        expect(JSON.stringify(map)).not.toContain('user.get');
    });

    it('lists the same signatures with the name behind each key, so a generator can diff by endpoint', async () => {
        const server = createServer();
        const map = await server.apiSignatures();
        const entries = await server.apiSignatureEntries();

        // The names the map does not carry, which is the whole point of this.
        expect(entries.map((entry) => entry.name).sort()).toEqual(['me', 'org.get', 'user.get']);
        // Same data, same order: the map is these entries with the names dropped.
        expect(Object.fromEntries(entries.map(({ key, signature }) => [key, signature]))).toEqual(map);
        expect(entries.map((entry) => entry.key)).toEqual(Object.keys(map));
        for(const entry of entries) expect(entry.key).toBe(await apiNameKeyOf(entry.name));
    });

    it('runs a matching signature, refuses a stale one and an unknown signed name, and gates nothing that carries none', async () => {
        const map = await createServer().apiSignatures();
        const server = createServer(map);
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
        const map = await createServer().apiSignatures();
        const server = createServer(map);
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

describe('compareDottedVersions', () => {
    it('compares segment by segment as numbers, pads a missing segment with zero, and reads an unreadable one as zero', () => {
        expect(compareDottedVersions('1.2.10', '1.2.9')).toBe(1);
        expect(compareDottedVersions('1.2.9', '1.2.10')).toBe(-1);
        expect(compareDottedVersions('1.2', '1.2.0')).toBe(0);
        expect(compareDottedVersions('1.10', '1.9')).toBe(1);
        expect(compareDottedVersions('2', '1.99.99')).toBe(1);
        expect(compareDottedVersions('dev', '0.0.1')).toBe(-1);
        expect(isDottedVersion('7')).toBe(true);
        expect(isDottedVersion('1.2.10')).toBe(true);
        expect(isDottedVersion('1.2.')).toBe(false);
        expect(isDottedVersion('v1.2')).toBe(false);
        expect(isDottedVersion('')).toBe(false);
    });
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
        assertApiFailure(missing, 'unknown');
        expect((missing.error.cause as Error).message).toMatch(/no signature for API "user.list"/);
        expect(bodies.length).toBe(1);

        // createEvent carries it too, for a boot check that hands a package an event file.
        const event = LambderInvokeCaller.createEvent({ apiName: 'user.get', signature: 'callee-shape' });
        expect(JSON.parse(event.body ?? '{}')).toMatchObject({ apiName: 'user.get', signature: 'callee-shape' });
    });
});
