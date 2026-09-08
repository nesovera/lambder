/**
 * Compressed request payloads: the caller's gzip + base64 envelope field and
 * the server's bounded restore.
 *
 * - LambderCaller compresses a payload over the threshold and leaves smaller
 *   ones (and disabled/overridden calls) plain.
 * - The server restores it before rate-limit key slices, guards and input
 *   validation, so nothing downstream knows the wire format.
 * - Malformed, mismatched, corrupt and over-sized bodies refuse with 400
 *   rather than crashing or expanding without limit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import Lambder, { initLambder } from '../src/core/Lambder.js';
import LambderCaller from '../src/client/LambderCaller.js';
import {
    compressPayloadJson,
    decompressPayloadJson,
    DEFAULT_REQUEST_COMPRESSION_SETTINGS,
} from '../src/shared/LambderRequestPayload.js';
import { resolveCompressionOption } from '../src/shared/LambderCompressionOption.js';
import { LAMBDER_REFUSAL_CODES } from '../src/shared/LambderApiError.js';
import { lambderGuard } from '../src/policies/LambderApiGuards.js';
import { lambderRateLimitKey } from '../src/policies/LambderApiRateLimits.js';
import { createApiEvent, createMockContext, createMockEventV2, decodeBody } from './helpers.js';

/** A payload big and repetitive enough that gzip is a large win. */
const bigPayload = (size = 400) => ({ notes: Array.from({ length: size }, (_, i) => `stop-${i} on the main line`) });

/** Builds the envelope exactly as a compressing caller would; the payload must be one that shrinks. */
const compressedApiEvent = async (apiName: string, payload: unknown, extra: Record<string, unknown> = {}) => {
    const compressed = await compressPayloadJson(JSON.stringify(payload), 0);
    if(!compressed) throw new Error('test payload did not compress; use a larger or more repetitive one');
    return createApiEvent({ apiName, ...compressed, ...extra });
};

const echoApi = () => initLambder().create({ apiPath: '/api' })
    .addApi('echo', {
        input: z.object({ notes: z.array(z.string()) }),
        output: z.object({ count: z.number() }),
    }, (ctx, res) => res.api({ count: ctx.apiPayload.notes.length }));

describe('Request compression - the caller side', () => {
    beforeEach(() => { vi.stubGlobal('window', { location: { hostname: 'localhost' } }); });
    afterEach(() => { vi.unstubAllGlobals(); });

    /** Captures the request body the caller would send. */
    const captureBody = () => {
        const bodies: any[] = [];
        vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
            bodies.push(JSON.parse(init.body));
            return {
                status: 200,
                statusText: 'OK',
                headers: { get: () => 'application/json' },
                json: async () => ({ apiVersion: '1', payload: null }),
                text: async () => '{}',
            };
        }));
        return bodies;
    };

    it('compresses a payload over the threshold and sends it as payloadGz', async () => {
        const bodies = captureBody();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, requestCompression: true });
        const payload = bigPayload();

        await caller.api('echo', payload);

        expect(bodies[0].payload).toBeUndefined();
        expect(typeof bodies[0].payloadGz).toBe('string');
        expect(bodies[0].payloadBytes).toBe(new TextEncoder().encode(JSON.stringify(payload)).length);
        // Round-trips to the original payload.
        await expect(decompressPayloadJson(bodies[0].payloadGz)).resolves.toEqual(payload);
        // And is meaningfully smaller, base64 overhead included.
        expect(bodies[0].payloadGz.length).toBeLessThan(bodies[0].payloadBytes / 3);
    });

    it('leaves the routing fields of a compressed call in plain text', async () => {
        const bodies = captureBody();
        const caller = new LambderCaller({ apiPath: '/api', apiVersion: '7', isCorsEnabled: false, requestCompression: true });

        await caller.api('echo', bigPayload(), { idempotencyKey: 'abcdefghijklmnop' });

        expect(bodies[0].apiName).toBe('echo');
        expect(bodies[0].version).toBe('7');
        expect(bodies[0].idempotencyKey).toBe('abcdefghijklmnop');
        expect(bodies[0].siteHost).toBe('localhost');
    });

    it('sends small payloads plainly', async () => {
        const bodies = captureBody();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, requestCompression: true });

        await caller.api('echo', { notes: ['one'] });

        expect(bodies[0].payload).toEqual({ notes: ['one'] });
        expect(bodies[0].payloadGz).toBeUndefined();
    });

    it('sends everything plainly when the option is off (the default)', async () => {
        const bodies = captureBody();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false });

        await caller.api('echo', bigPayload());

        expect(bodies[0].payload).toBeDefined();
        expect(bodies[0].payloadGz).toBeUndefined();
    });

    it('compressRequest overrides the threshold in both directions', async () => {
        const bodies = captureBody();
        const on = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, requestCompression: true });
        const off = new LambderCaller({ apiPath: '/api', isCorsEnabled: false });

        // Well under the default threshold, but repetitive enough to shrink.
        const small = bigPayload(20);
        expect(new TextEncoder().encode(JSON.stringify(small)).length).toBeLessThan(DEFAULT_REQUEST_COMPRESSION_SETTINGS.minBytes);

        await on.api('echo', bigPayload(), { compressRequest: false });
        await off.api('echo', small, { compressRequest: true });

        expect(bodies[0].payloadGz).toBeUndefined();
        expect(bodies[1].payloadGz).toBeDefined();
        expect(bodies[1].payload).toBeUndefined();
    });

    it('sends no payload field at all when the call has no payload', async () => {
        const bodies = captureBody();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, requestCompression: true });

        await caller.api('echo');

        expect('payload' in bodies[0]).toBe(false);
        expect('payloadGz' in bodies[0]).toBe(false);
    });

    it('sends an incompressible payload plainly rather than larger', async () => {
        // A base64 image gzips to nearly its own size and base64 then inflates
        // it: the plain JSON is the smaller request, so that is what goes.
        const bodies = captureBody();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, requestCompression: true });
        const image = Buffer.from(Array.from({ length: 30_000 }, () => Math.floor(Math.random() * 256))).toString('base64');

        await caller.api('upload', { photo: image });
        // Forcing it does not override that: a request is never made larger.
        await caller.api('echo', { notes: ['tiny'] }, { compressRequest: true });

        expect(bodies[0].payloadGz).toBeUndefined();
        expect(bodies[0].payload).toEqual({ photo: image });
        expect(bodies[1].payloadGz).toBeUndefined();
        expect(bodies[1].payload).toEqual({ notes: ['tiny'] });
    });

    it('honours a custom minBytes', async () => {
        const bodies = captureBody();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, requestCompression: { minBytes: 10 } });

        await caller.api('echo', bigPayload(8));

        expect(bodies[0].payloadGz).toBeDefined();
    });

    it('measures the threshold in UTF-8 bytes, not string length', async () => {
        // 30 characters of 3-byte text is 90 bytes: over the threshold by
        // bytes, under it by string length.
        const payload = { notes: ['ünïcödé'.repeat(20)] };
        const json = JSON.stringify(payload);
        expect(json.length).toBeLessThan(200);
        expect(new TextEncoder().encode(json).length).toBeGreaterThan(200);

        expect(await compressPayloadJson(json, 200)).not.toBeNull();
    });

    it('resolves through the shared compression resolver, defaulting to off', () => {
        const resolve = (option: any) => resolveCompressionOption(option ?? false, DEFAULT_REQUEST_COMPRESSION_SETTINGS);

        expect(resolve(undefined)).toBeNull();
        expect(resolve(false)).toBeNull();
        expect(resolve(true)).toEqual(DEFAULT_REQUEST_COMPRESSION_SETTINGS);
        expect(resolve({ minBytes: 0 })).toEqual({ minBytes: 0 });
        expect(() => resolve({ minBytes: -1 })).toThrow(/non-negative/);
        expect(() => resolve({ minBytes: 1.5 })).toThrow(/non-negative/);
    });

    it('rejects a bad threshold at construction, like every other compression option', () => {
        expect(() => new LambderCaller({ apiPath: '/api', isCorsEnabled: false, requestCompression: { minBytes: -1 } }))
            .toThrow(/non-negative/);
    });
});

describe('Request compression - the server side', () => {
    it('restores a compressed payload for the handler', async () => {
        const payload = bigPayload();
        const result = await echoApi().render(await compressedApiEvent('echo', payload), createMockContext());

        expect(JSON.parse(decodeBody(result)).payload).toEqual({ count: payload.notes.length });
    });

    it('still accepts a plain payload on the same API', async () => {
        const result = await echoApi().render(
            createApiEvent({ apiName: 'echo', payload: { notes: ['a', 'b'] } }),
            createMockContext(),
        );

        expect(JSON.parse(decodeBody(result)).payload).toEqual({ count: 2 });
    });

    it('leaves the restored payload on ctx.post for preflight consumers', async () => {
        let seenPost: any;
        const lambder = initLambder().create({ apiPath: '/api' })
            .addApi('inspect', { input: z.object({ notes: z.array(z.string()) }), output: z.object({ ok: z.boolean() }) },
                (ctx, res) => { seenPost = ctx.post; return res.api({ ok: true }); });

        await lambder.render(await compressedApiEvent('inspect', bigPayload(10)), createMockContext());

        expect(seenPost.payload).toEqual(bigPayload(10));
        // The wire fields are consumed, not left lying around.
        expect(seenPost.payloadGz).toBeUndefined();
        expect(seenPost.payloadBytes).toBeUndefined();
    });

    it('restores before guards and rate-limit key slices read the payload', async () => {
        const seen: string[] = [];
        const lambder = initLambder().create({
            apiPath: '/api',
            guards: {
                inspectPayload: lambderGuard({
                    apiInput: z.object({ notes: z.array(z.string()) }),
                    handler: (ctx, payload) => { seen.push(`guard:${payload.notes.length}`); },
                }),
            },
        }).addApi('guarded', {
            input: z.object({ notes: z.array(z.string()) }),
            output: z.object({ ok: z.boolean() }),
            guards: 'inspectPayload',
        }, (ctx, res) => res.api({ ok: true }));

        const result = await lambder.render(await compressedApiEvent('guarded', bigPayload(4)), createMockContext());

        expect(seen).toEqual(['guard:4']);
        expect(JSON.parse(decodeBody(result)).payload).toEqual({ ok: true });
    });

    it('validates the restored payload against the input schema', async () => {
        const result = await echoApi().render(
            await compressedApiEvent('echo', { notes: 'not-an-array, '.repeat(30) }),
            createMockContext(),
        );

        expect(result.statusCode).toBe(422);
    });

    it('refuses a payloadGz that is not a string', async () => {
        const result = await echoApi().render(
            createApiEvent({ apiName: 'echo', payloadGz: 42, payloadBytes: 10 }),
            createMockContext(),
        );

        expect(result.statusCode).toBe(400);
        expect(JSON.parse(decodeBody(result)).errorMessage.code).toBe(LAMBDER_REFUSAL_CODES.invalidRequestPayload);
    });

    it('refuses a missing or invalid payloadBytes', async () => {
        const compressed = await compressPayloadJson(JSON.stringify(bigPayload()), 0);
        for(const bytes of [undefined, 0, -5, 1.5, '100']){
            const result = await echoApi().render(
                createApiEvent({ apiName: 'echo', payloadGz: compressed!.payloadGz, payloadBytes: bytes }),
                createMockContext(),
            );
            expect(result.statusCode).toBe(400);
            expect(JSON.parse(decodeBody(result)).errorMessage.content).toMatch(/byte length/);
        }
    });

    it('rejects a nonsense ceiling at construction', () => {
        for(const bad of [0, -1, 1.5, Number.NaN]){
            expect(() => initLambder().create({ apiPath: '/api', maxRequestPayloadBytes: bad })).toThrow(/positive integer/);
        }
    });

    it('refuses a payload declared over the configured ceiling without decompressing it', async () => {
        const lambder = initLambder().create({ apiPath: '/api', maxRequestPayloadBytes: 1000 })
            .addApi('echo', { input: z.object({ notes: z.array(z.string()) }), output: z.object({ count: z.number() }) },
                (ctx, res) => res.api({ count: ctx.apiPayload.notes.length }));

        const result = await lambder.render(await compressedApiEvent('echo', bigPayload()), createMockContext());

        expect(result.statusCode).toBe(400);
        expect(JSON.parse(decodeBody(result)).errorMessage.content).toMatch(/exceeds the 1000 byte limit/);
    });

    it('refuses a body that decompresses to a different length than declared (zip bomb guard)', async () => {
        // A body that expands far past what it declares: gunzip is bounded by
        // the declared length, so it fails instead of allocating the rest.
        const bomb = gzipSync(Buffer.alloc(5_000_000, 0x61)).toString('base64');
        const result = await echoApi().render(
            createApiEvent({ apiName: 'echo', payloadGz: bomb, payloadBytes: 100 }),
            createMockContext(),
        );

        expect(result.statusCode).toBe(400);
        expect(JSON.parse(decodeBody(result)).errorMessage.content).toMatch(/could not be decompressed|does not match/);
    });

    it('refuses a truncated body', async () => {
        const compressed = await compressPayloadJson(JSON.stringify(bigPayload()), 0);
        const truncated = Buffer.from(compressed!.payloadGz, 'base64').subarray(0, 40).toString('base64');
        const result = await echoApi().render(
            createApiEvent({ apiName: 'echo', payloadGz: truncated, payloadBytes: compressed!.payloadBytes }),
            createMockContext(),
        );

        expect(result.statusCode).toBe(400);
        expect(JSON.parse(decodeBody(result)).errorMessage.content).toMatch(/could not be decompressed/);
    });

    it('refuses bytes that are not gzip at all', async () => {
        const result = await echoApi().render(
            createApiEvent({ apiName: 'echo', payloadGz: Buffer.from('plain text').toString('base64'), payloadBytes: 10 }),
            createMockContext(),
        );

        expect(result.statusCode).toBe(400);
        expect(JSON.parse(decodeBody(result)).errorMessage.content).toMatch(/could not be decompressed/);
    });

    it('refuses a body that decompresses to invalid JSON', async () => {
        const notJson = Buffer.from('{ this is not json');
        const result = await echoApi().render(
            createApiEvent({
                apiName: 'echo',
                payloadGz: gzipSync(notJson).toString('base64'),
                payloadBytes: notJson.length,
            }),
            createMockContext(),
        );

        expect(result.statusCode).toBe(400);
        expect(JSON.parse(decodeBody(result)).errorMessage.content).toMatch(/not valid JSON/);
    });

    it('lets a compressed payload win over a plain one sent alongside it', async () => {
        const compressed = await compressPayloadJson(JSON.stringify(bigPayload(5)), 0);
        const result = await echoApi().render(
            createApiEvent({ apiName: 'echo', payload: { notes: ['plain', 'plain'] }, ...compressed }),
            createMockContext(),
        );

        expect(JSON.parse(decodeBody(result)).payload).toEqual({ count: 5 });
    });

    it('does not stringify the payload twice when compression is off', async () => {
        // A payload whose toJSON counts its serializations: an ordinary call
        // must not pay for a feature it did not turn on.
        vi.stubGlobal('window', { location: { hostname: 'localhost' } });
        vi.stubGlobal('fetch', vi.fn(async () => ({
            status: 200, statusText: 'OK',
            headers: { get: () => 'application/json' },
            json: async () => ({ apiVersion: '1', payload: null }),
            text: async () => '{}',
        })));
        let serializations = 0;
        const payload = { toJSON(){ serializations += 1; return { notes: [] }; } };

        await new LambderCaller({ apiPath: '/api', isCorsEnabled: false }).api('echo', payload as any);

        expect(serializations).toBe(1);
        vi.unstubAllGlobals();
    });

    it('does not touch non-API requests carrying a payloadGz-shaped body', async () => {
        const lambder = new Lambder({ apiPath: '/api' })
            .addRoute('/hook', (ctx, res) => res.text(ctx.rawBody));
        const event = createApiEvent({ payloadGz: 'not-base64!!', payloadBytes: -1 });
        event.path = '/hook';

        const result = await lambder.render(event, createMockContext());

        expect(result.statusCode).toBe(200);
        expect(decodeBody(result)).toContain('payloadGz');
    });
});

describe('Request compression - the deployment shape (HTTP API v2 + CORS)', () => {
    /** What urbanly and any Function URL deployment actually delivers. */
    const corsApi = () => initLambder().create({ apiPath: '/api', cors: true })
        .addApi('echo', {
            input: z.object({ notes: z.array(z.string()) }),
            output: z.object({ count: z.number() }),
        }, (ctx, res) => res.api({ count: ctx.apiPayload.notes.length }));

    const v2ApiEvent = (body: Record<string, unknown>) => createMockEventV2('/api', {
        headers: { host: 'api.example.com', origin: 'https://example.com', 'content-type': 'application/json' },
        requestContext: { ...createMockEventV2('/api').requestContext, http: { method: 'POST', path: '/api', protocol: 'HTTP/1.1', sourceIp: '9.9.9.9', userAgent: 'test' } },
        body: JSON.stringify(body),
    });

    it('restores a compressed payload from a v2 event', async () => {
        const compressed = await compressPayloadJson(JSON.stringify(bigPayload(7)), 0);

        const result = await corsApi().render(v2ApiEvent({ apiName: 'echo', ...compressed }), createMockContext());

        expect(JSON.parse(decodeBody(result)).payload).toEqual({ count: 7 });
    });

    it('sends the refusal with CORS headers, so a browser can read it', async () => {
        // Without them a cross-origin caller sees an opaque network failure
        // instead of the coded refusal, and cannot tell why the call failed.
        const result = await corsApi().render(
            v2ApiEvent({ apiName: 'echo', payloadGz: Buffer.from('not gzip').toString('base64'), payloadBytes: 8 }),
            createMockContext(),
        );

        expect(result.statusCode).toBe(400);
        expect((result.headers as Record<string, string>)['Access-Control-Allow-Origin']).toBeDefined();
        expect(JSON.parse(decodeBody(result)).errorMessage.code).toBe(LAMBDER_REFUSAL_CODES.invalidRequestPayload);
    });
});

describe('Request compression - round trip through the real pipeline', () => {
    it('a compressing caller reaches a rate-limited, validated API', async () => {
        const lambder = initLambder().create({ apiPath: '/api' })
            .addApi('import', {
                input: z.object({ notes: z.array(z.string()) }),
                output: z.object({ received: z.number() }),
            }, (ctx, res) => res.api({ received: ctx.apiPayload.notes.length }));

        // The caller builds the envelope; the server consumes it verbatim.
        vi.stubGlobal('window', { location: { hostname: 'localhost' } });
        let capturedBody = '';
        vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
            capturedBody = init.body;
            const result = await lambder.render(createApiEvent(JSON.parse(capturedBody)), createMockContext());
            const text = decodeBody(result);
            return {
                status: result.statusCode,
                statusText: 'OK',
                headers: { get: () => 'application/json' },
                json: async () => JSON.parse(text),
                text: async () => text,
            };
        }));

        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, requestCompression: true });
        const payload = bigPayload(250);
        const outcome = await caller.apiOutcome('import', payload);

        expect(JSON.parse(capturedBody).payloadGz).toBeDefined();
        expect(outcome.ok).toBe(true);
        expect(outcome.ok && outcome.payload).toEqual({ received: 250 });
        vi.unstubAllGlobals();
    });

    it('keys a rate limit off a payload slice that only exists after restoring', async () => {
        const keys: string[] = [];
        const lambder = initLambder().create({
            apiPath: '/api',
            rateLimits: {
                limiter: { isRateLimited: async (key: string) => { keys.push(key); return null; } } as any,
                policies: {
                    perTenant: {
                        perMin: 10, budget: 'perApi',
                        per: lambderRateLimitKey({
                            apiInput: z.object({ tenant: z.string() }),
                            handler: (ctx, payload) => payload.tenant,
                        }),
                    },
                },
            },
        }).addApi('ingest', {
            input: z.object({ tenant: z.string(), notes: z.array(z.string()) }),
            output: z.object({ ok: z.boolean() }),
            rateLimit: 'perTenant',
        }, (ctx, res) => res.api({ ok: true }));

        const result = await lambder.render(
            await compressedApiEvent('ingest', { tenant: 'acme', ...bigPayload(50) }),
            createMockContext(),
        );

        expect(keys).toEqual(['api|ingest|perTenant|custom:acme']);
        expect(JSON.parse(decodeBody(result)).payload).toEqual({ ok: true });
    });
});
