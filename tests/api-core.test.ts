/**
 * The API core on its own: the answer header accumulator, the envelope
 * functions, reading and restoring a request, and the pipeline's step order
 * over a fake definition. The memory stores live in memory-stores.test.ts
 * and store-conformance.test.ts, the cookie jar in cookie-jar.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import zlib from 'zlib';
import { toHttpAnswer } from '../src/api/LambderApiAnswer.js';
import { LambderAnswerHeaders, getAnswerHeader, setAnswerHeader, addAnswerHeader } from '../src/shared/wire/LambderAnswerHeaders.js';
import {
    buildApiEnvelope, envelopeAnswer, refusalAnswer, validationAnswer, apiNotFoundAnswer,
    sessionExpiredAnswer, versionExpiredAnswer, invalidPayloadAnswer, crashAnswer,
} from '../src/api/LambderApiEnvelope.js';
import { readApiEnvelope, restoreCompressedPayload, type LambderApiRequest } from '../src/api/LambderApiRequest.js';
import { createApiCallContext, type LambderApiCallContext } from '../src/api/LambderApiCallContext.js';
import { LambderApiPipeline } from '../src/api/LambderApiPipeline.js';
import type { LambderApiDefinition } from '../src/api/LambderApiDefinition.js';
import { LambderApiPolicyEngine } from '../src/api/LambderApiPolicyEngine.js';
import { LambderApiValidationRefusal, isLambderApiValidationRefusal } from '../src/api/LambderApiValidationRefusal.js';
import { LambderApiRefusal, refuse, LAMBDER_REFUSAL_CODES } from '../src/shared/wire/LambderApiRefusal.js';
import { LambderMemoryRateLimiter } from '../src/stores/LambderMemoryRateLimiter.js';
import { LambderMemoryIdempotencyStore } from '../src/stores/LambderMemoryIdempotencyStore.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import LambderSessionManager from '../src/session/LambderSessionManager.js';

const request = (overrides: Partial<LambderApiRequest> = {}): LambderApiRequest => ({
    apiName: 'thing.do', version: null, signature: null, token: '', siteHost: 'localhost', payload: { value: 'x' }, compressedPayload: null,
    guardInputs: undefined, idempotencyKey: undefined, headers: {}, cookies: {}, ip: '1.2.3.4', host: 'localhost',
    ...overrides,
});

describe('LambderAnswerHeaders', () => {
    it('applies set and add in call order onto a map, case-insensitively, and keeps them', () => {
        const headers = new LambderAnswerHeaders();
        headers.add('X-A', '1');
        headers.set('x-a', '2');
        headers.add('X-A', '3');
        headers.set('Content-Type', 'text/plain');
        expect(headers.size).toBe(4);
        const target: Record<string, string[]> = { 'content-type': ['application/json'] };
        headers.applyInto(target);
        expect(target).toEqual({ 'x-a': ['2', '3'], 'Content-Type': ['text/plain'] });
        // Applying the same operations again onto the same target changes
        // nothing, and the operations are remembered rather than forgotten.
        expect(headers.size).toBe(4);
        headers.applyInto(target);
        expect(target).toEqual({ 'x-a': ['2', '3'], 'Content-Type': ['text/plain'] });
    });

    it('applies onto anything with getHeader, setHeader and addHeader', () => {
        const headers = new LambderAnswerHeaders();
        headers.set('A', '1'); headers.add('B', '2');
        const calls: string[] = [];
        const target = {
            getHeader: (_k: string): string[] | undefined => undefined,
            setHeader: (k: string, v: string | string[]) => calls.push(`set ${k}=${String(v)}`),
            addHeader: (k: string, v: string) => calls.push(`add ${k}=${v}`),
        };
        headers.applyTo(target);
        expect(calls).toEqual(['set A=1', 'add B=2']);
    });

    it('applies only the slice a mark opens, so one step\'s headers can be told from another\'s', () => {
        const headers = new LambderAnswerHeaders();
        headers.add('Set-Cookie', 'evicted=; Max-Age=0');
        const handlerFirstHeader = headers.size;
        headers.set('X-Handler', 'yes');
        const handlerOnly: Record<string, string[]> = {};
        headers.applyInto(handlerOnly, handlerFirstHeader);
        expect(handlerOnly).toEqual({ 'X-Handler': ['yes'] });
        const everything: Record<string, string[]> = {};
        headers.applyInto(everything);
        expect(everything).toEqual({ 'Set-Cookie': ['evicted=; Max-Age=0'], 'X-Handler': ['yes'] });
    });

    it('the map helpers read, replace and append under any casing', () => {
        const headers: Record<string, string[]> = { 'Set-Cookie': ['a=1'] };
        expect(getAnswerHeader(headers, 'set-cookie')).toEqual(['a=1']);
        addAnswerHeader(headers, 'set-cookie', 'b=2');
        expect(headers['Set-Cookie']).toEqual(['a=1', 'b=2']);
        setAnswerHeader(headers, 'SET-COOKIE', 'c=3');
        expect(Object.keys(headers)).toEqual(['SET-COOKIE']);
        expect(getAnswerHeader(headers, 'nope')).toBeUndefined();
    });
});

describe('The envelope', () => {
    it('buildApiEnvelope carries only the flags that are set and drops an empty logList', () => {
        expect(buildApiEnvelope('1', { a: 1 })).toEqual({ apiVersion: '1', payload: { a: 1 } });
        expect(buildApiEnvelope(undefined, null, { sessionExpired: true, logList: [] })).toEqual({ apiVersion: null, payload: null, sessionExpired: true });
        expect(buildApiEnvelope(null, null, { errorMessage: 'no', message: 'hi', logList: ['x'] })).toEqual({ apiVersion: null, payload: null, message: 'hi', errorMessage: 'no', logList: ['x'] });
    });

    it('each answer function renders its outcome with the right status, headers and body', () => {
        const ok = envelopeAnswer(buildApiEnvelope('1', { a: 1 }));
        expect(ok.statusCode).toBe(200);
        expect(ok.headers).toEqual({ 'Content-Type': ['application/json; charset=utf-8'] });
        expect(JSON.parse(ok.body)).toEqual({ apiVersion: '1', payload: { a: 1 } });

        const refusal = refusalAnswer(new LambderApiRefusal('Slow down', { errorMessage: { type: 'warning', content: 'Slow down' }, statusCode: 429, headers: { 'Retry-After': '9' }, notAuthorized: true }), '1', ['log']);
        expect(refusal.statusCode).toBe(429);
        expect(refusal.headers['Retry-After']).toEqual(['9']);
        expect(JSON.parse(refusal.body)).toEqual({ apiVersion: '1', payload: null, notAuthorized: true, errorMessage: { type: 'warning', content: 'Slow down' }, logList: ['log'] });

        const validation = validationAnswer(z.object({ v: z.string() }).safeParse({}).error!);
        expect(validation.statusCode).toBe(422);
        expect(JSON.parse(validation.body).zodError.issues[0].path).toEqual(['v']);
        expect(JSON.parse(validation.body).issueCount).toBeUndefined();

        expect(JSON.parse(apiNotFoundAnswer('1').body).errorMessage.code).toBe(LAMBDER_REFUSAL_CODES.apiNotFound);
        expect(JSON.parse(sessionExpiredAnswer('1').body).sessionExpired).toBe(true);
        expect(JSON.parse(versionExpiredAnswer('1').body).versionExpired).toBe(true);
        expect(invalidPayloadAnswer('1', 'bad').statusCode).toBe(400);
        expect(JSON.parse(invalidPayloadAnswer('1', 'bad').body).errorMessage.code).toBe(LAMBDER_REFUSAL_CODES.invalidRequestPayload);
        const crash = crashAnswer('1');
        expect(crash.statusCode).toBe(500);
        expect(JSON.parse(crash.body)).toEqual({ apiVersion: '1', payload: null, errorMessage: 'Internal server error.' });
    });


    it('counts validation issues past a point instead of echoing all of them', async () => {
        // A public API validates before any guard runs, so an unauthenticated
        // caller chose this body's size. zod re-serializes the whole issue
        // list into its own `message` too, so an uncapped answer shipped the
        // tree twice: a modest posted array came back as megabytes, which also
        // crosses the response size cap and turns the 422 into a crash.
        const schema = z.array(z.object({ n: z.number() }));
        const tooMany = schema.safeParse(Array.from({ length: 5000 }, () => ({ n: 'no' }))).error!;

        const answer = validationAnswer(tooMany);
        const body = JSON.parse(answer.body);

        expect(answer.statusCode).toBe(422);
        expect(body.zodError.issues.length).toBe(50);
        expect(body.issueCount).toBe(5000);
        expect(body.zodError.message).toContain('5000 validation issues');
        // The whole answer stays small enough to be an answer.
        expect(answer.body.length).toBeLessThan(20_000);
    });
    it('bounds the 422 body by BYTES, not by issue count, and never ships zod\'s own message', async () => {
        // The count cap bounds the wrong thing: ONE unrecognized_keys issue
        // carries every key the client posted, and zod's own message is the
        // whole tree serialized again. Measured before the fix: 988,903 bytes
        // in, 4,195,863 bytes out, unauthenticated and before any guard,
        // which also crosses the response cap and turns the 422 into a 500.
        const schema = z.strictObject({ value: z.string() });
        const posted: Record<string, unknown> = { value: 'x' };
        for(let i = 0; i < 20_000; i += 1) posted[`extra_${i}`] = i;

        const answer = validationAnswer(schema.safeParse(posted).error!);
        const body = JSON.parse(answer.body);

        expect(answer.statusCode).toBe(422);
        expect(answer.body.length).toBeLessThan(40_000);
        // The one issue is still there, with its own oversized list clamped.
        expect(body.zodError.issues[0].code).toBe('unrecognized_keys');
        expect(body.zodError.issues[0].keys.length).toBeLessThanOrEqual(20);
        // The answer says it was trimmed rather than pretending to be whole.
        expect(body.issueCount).toBe(1);
        expect(body.zodError.message).toContain('validation issue');
        expect(body.zodError.message).not.toContain('extra_1999');
    });

    it('carries the call\'s logList on a 422, as every other answer does', () => {
        const zodError = z.object({ v: z.string() }).safeParse({}).error!;
        expect(JSON.parse(validationAnswer(zodError, ['looked up the org']).body).logList).toEqual(['looked up the org']);
        expect(JSON.parse(validationAnswer(zodError, []).body).logList).toBeUndefined();
    });

    it('renders an errorMessage the app set to an empty value, since presence is the statement', () => {
        // Truthiness dropped exactly the refusals an app spells out as empty:
        // errorMessage: "" reached the caller as no errorMessage at all, and
        // its errorMessageHandler never ran.
        const refusal = refusalAnswer(new LambderApiRefusal('Denied.', { errorMessage: '' }), '1');
        expect(JSON.parse(refusal.body).errorMessage).toBe('');
        expect(JSON.parse(refusalAnswer(new LambderApiRefusal('Denied.'), '1').body).errorMessage).toBe('Denied.');
        expect(buildApiEnvelope('1', null, { message: '' })).toEqual({ apiVersion: '1', payload: null, message: '' });
    });

    it('toHttpAnswer gives the accessor view resolveApiOutcome reads, Set-Cookie values apart', async () => {
        const answer = refusalAnswer(new LambderApiRefusal('x', { headers: { 'Retry-After': '3' } }), null);
        answer.headers['Set-Cookie'] = ['a=1; Path=/', 'b=2; Path=/'];
        const http = toHttpAnswer(answer);
        expect(http.status).toBe(200);
        expect(http.header('retry-after')).toBe('3');
        expect(await http.json()).toEqual(JSON.parse(answer.body));
        expect(http.setCookies).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    });
});

describe('Reading and restoring a request', () => {
    const info = { headers: { host: 'h' }, cookies: {}, ip: '9.9.9.9', host: 'h' };

    it('readApiEnvelope takes the envelope fields as posted and answers null without an apiName', () => {
        expect(readApiEnvelope({}, info)).toBeNull();
        expect(readApiEnvelope({ apiName: 7 }, info)).toBeNull();
        const parsed = readApiEnvelope({ apiName: 'a', version: '2', token: 't', siteHost: 's', payload: { p: 1 }, guardInputs: { g: 1 }, idempotencyKey: 'k' }, info)!;
        expect(parsed).toMatchObject({ apiName: 'a', version: '2', token: 't', siteHost: 's', payload: { p: 1 }, guardInputs: { g: 1 }, idempotencyKey: 'k', ip: '9.9.9.9', host: 'h', compressedPayload: null });
        expect(readApiEnvelope({ apiName: 'a', guardInputs: 'nope', version: 3 }, info)).toMatchObject({ guardInputs: undefined, version: null, token: '' });
        // An array is an object, and it answers for its own properties, so a
        // guards map it is not: see the guard named "length" below.
        expect(readApiEnvelope({ apiName: 'a', guardInputs: ['nope'] }, info)).toMatchObject({ guardInputs: undefined });
        expect(readApiEnvelope({ apiName: 'a', payloadGz: 'zz', payloadBytes: 3 }, info)?.compressedPayload).toEqual({ gzip: 'zz', brotli: undefined, declaredBytes: 3 });
    });

    it('restoreCompressedPayload restores gzip and Brotli under the declared length, and refuses what it cannot vouch for', async () => {
        const payload = { notes: Array.from({ length: 50 }, (_, i) => `n${i}`) };
        const json = Buffer.from(JSON.stringify(payload), 'utf8');
        const gz = zlib.gzipSync(json).toString('base64');
        const br = zlib.brotliCompressSync(json).toString('base64');

        const gzipped = request({ payload: undefined, compressedPayload: { gzip: gz, brotli: undefined, declaredBytes: json.byteLength } });
        expect(await restoreCompressedPayload(gzipped, 1_000_000)).toEqual({ ok: true });
        expect(gzipped.payload).toEqual(payload);
        expect(gzipped.compressedPayload).toBeNull();

        const brotlied = request({ compressedPayload: { gzip: undefined, brotli: br, declaredBytes: json.byteLength } });
        expect(await restoreCompressedPayload(brotlied, 1_000_000)).toEqual({ ok: true });
        expect(brotlied.payload).toEqual(payload);

        expect(await restoreCompressedPayload(request(), 10)).toEqual({ ok: true });
        expect((await restoreCompressedPayload(request({ compressedPayload: { gzip: gz, brotli: br, declaredBytes: 1 } }), 10)).ok).toBe(false);
        expect((await restoreCompressedPayload(request({ compressedPayload: { gzip: 5, brotli: undefined, declaredBytes: 1 } }), 10)).ok).toBe(false);
        expect((await restoreCompressedPayload(request({ compressedPayload: { gzip: gz, brotli: undefined, declaredBytes: 'x' } }), 10)).ok).toBe(false);
        expect((await restoreCompressedPayload(request({ compressedPayload: { gzip: gz, brotli: undefined, declaredBytes: json.byteLength } }), 10))).toMatchObject({ ok: false, message: expect.stringContaining('exceeds') });
        expect((await restoreCompressedPayload(request({ compressedPayload: { gzip: gz, brotli: undefined, declaredBytes: json.byteLength + 1 } }), 1_000_000))).toMatchObject({ ok: false, message: expect.stringContaining('declared length') });
        expect((await restoreCompressedPayload(request({ compressedPayload: { gzip: 'not-gzip', brotli: undefined, declaredBytes: 5 } }), 1_000_000))).toMatchObject({ ok: false, message: expect.stringContaining('decompressed') });
    });
});

describe('LambderApiPipeline', () => {
    const okExec = async () => envelopeAnswer(buildApiEnvelope('1', { ran: true }));

    it('runs a bare definition: no configured step, just the handler', async () => {
        const pipeline = new LambderApiPipeline({ apiVersion: '1' });
        const { answer, replayed, guardsRun } = await pipeline.run(request(), createApiCallContext(), { name: 'thing.do', mode: 'public' }, okExec);
        expect(JSON.parse(answer.body)).toEqual({ apiVersion: '1', payload: { ran: true } });
        expect(replayed).toBe(false);
        expect(guardsRun).toEqual([]);
    });

    it('gates the signature first, then restores the payload, and refuses an unknown name with the call\'s own headers', async () => {
        // A source that knows one signature per known endpoint, as the
        // server's digests or the mock's map would.
        const signatures = { expectedSignatureOf: async (apiName: string, definition: LambderApiDefinition | null) => definition ? `sig-of-${apiName}` : null };
        const pipeline = new LambderApiPipeline({ apiVersion: '2', signatures });
        const definition: LambderApiDefinition = { name: 'thing.do', mode: 'public' };
        const stale = await pipeline.run(request({ signature: 'sig-of-an-older-shape' }), createApiCallContext(), definition, okExec);
        expect(JSON.parse(stale.answer.body)).toEqual({ apiVersion: '2', payload: null, versionExpired: true });
        const current = await pipeline.run(request({ signature: 'sig-of-thing.do' }), createApiCallContext(), definition, okExec);
        expect(JSON.parse(current.answer.body).payload).toEqual({ ran: true });
        // A request carrying no signature is never gated, and a signed request
        // for a name the adapter does not know is a stale client, not a typo.
        expect(await pipeline.prepare(request(), null)).toBeNull();
        expect(JSON.parse((await pipeline.prepare(request({ signature: 'anything' }), null))!.body).versionExpired).toBe(true);
        // Without a source every signature passes.
        expect(await new LambderApiPipeline().prepare(request({ signature: 'anything' }), null)).toBeNull();
        expect(JSON.parse(pipeline.answerUnknownApi(request()).body).errorMessage.code).toBe(LAMBDER_REFUSAL_CODES.apiNotFound);
        // Both adapters run prepare() with the definition the name resolved
        // to, or null, so a signed stale client has already been answered by
        // the time an unknown name is reported: the refusal carries the call's
        // headers instead of a second gate nothing can reach.
        const ctx = createApiCallContext();
        ctx.responseHeaders.set('X-Cors', 'yes');
        expect(pipeline.answerUnknownApi(request(), ctx).headers['X-Cors']).toEqual(['yes']);

        const bad = await pipeline.run(request({ compressedPayload: { gzip: 5, brotli: undefined, declaredBytes: 1 } }), createApiCallContext(), definition, okExec);
        expect(bad.answer.statusCode).toBe(400);
    });

    it('validates the input when the definition carries a schema, through onInvalidInput when set', async () => {
        const definition = { name: 'thing.do', mode: 'public' as const, input: z.object({ value: z.string() }) };
        const standard = await new LambderApiPipeline().run(request({ payload: {} }), createApiCallContext(), definition, okExec);
        expect(standard.answer.statusCode).toBe(422);
        expect(JSON.parse(standard.answer.body).zodError.issues[0].path).toEqual(['value']);

        const custom = new LambderApiPipeline({ onInvalidInput: async (zodError) => envelopeAnswer(buildApiEnvelope(null, null, { errorMessage: `bad ${zodError.issues[0]?.path.join('.')}` }), { statusCode: 400 }) });
        const answered = await custom.run(request({ payload: {} }), createApiCallContext(), definition, okExec);
        expect(answered.answer.statusCode).toBe(400);
        expect(JSON.parse(answered.answer.body).errorMessage).toBe('bad value');

        // The handler sees the PARSED payload: the schema's output, unknown
        // keys stripped and coercions applied, not what the client posted.
        // Read off the request the pipeline mutated; building a fresh request
        // here and reading THAT compared a literal to itself, so deleting the
        // assignment the assertion is about left the test green.
        const coercing = { name: 'thing.do', mode: 'public' as const, input: z.object({ value: z.string(), count: z.coerce.number() }) };
        const posted = request({ payload: { value: 'v', count: '42', extra: 1 } });
        const seen: unknown[] = [];
        await new LambderApiPipeline().run(posted, createApiCallContext(), coercing, async () => { seen.push(posted.payload); return okExec(); });
        expect(seen).toEqual([{ value: 'v', count: 42 }]);
    });

    it('reports the guards that ran, the refusing one last, when a later one refuses', async () => {
        // The mock's call log reads this. Reporting "no guards ran" for the
        // one call a developer is looking at, because a guard denied it, is
        // exactly backwards, and so is leaving out the guard that actually
        // said no: it is recorded before it runs, so the trace ends on the
        // name of the refusal and the guards after it never appear.
        const pipeline = new LambderApiPipeline({ guards: {
            first: { handler: async () => ({ ok: true }) },
            second: { handler: async () => { refuse('No.', { code: 'app/no' }); } },
            third: { handler: async () => ({ ok: true }) },
        } });
        const definition = { name: 'thing.do', mode: 'public' as const, guards: ['first', 'second', 'third'] };

        const result = await pipeline.run(request(), createApiCallContext(), definition, okExec);

        expect(JSON.parse(result.answer.body).errorMessage.code).toBe('app/no');
        expect(result.guardsRun).toEqual(['first', 'second']);
    });

    it('calls a replay a replay on either path that answers from the store', async () => {
        const store = new LambderMemoryIdempotencyStore();
        const pipeline = new LambderApiPipeline({ idempotency: { store } });
        const definition = { name: 'thing.do', mode: 'public' as const, idempotency: true };
        const key = 'k-1-abcdefabcdefabcdef';
        await pipeline.run(request({ idempotencyKey: key }), createApiCallContext(), definition, okExec);

        // The peek fast path.
        expect((await pipeline.run(request({ idempotencyKey: key }), createApiCallContext(), definition, okExec)).replayed).toBe(true);

        // And the race the "done" claim exists for: the original settles
        // between this request's peek and its claim, so peek misses and begin
        // answers. No handler runs either way.
        const racing = new LambderApiPipeline({ idempotency: { store: {
            peek: async () => null,
            begin: (scopeKey, options) => store.begin(scopeKey, options),
            complete: (scopeKey, owner, record) => store.complete(scopeKey, owner, record),
            abandon: (scopeKey, owner) => store.abandon(scopeKey, owner),
        } } });
        let runs = 0;
        const result = await racing.run(request({ idempotencyKey: key }), createApiCallContext(), definition, async () => { runs += 1; return okExec(); });
        expect(runs).toBe(0);
        expect(result.replayed).toBe(true);
    });

    it('renders refusals thrown anywhere, applies written headers onto the answer, and lets crashes through', async () => {
        const pipeline = new LambderApiPipeline({ apiVersion: '1' });
        const ctx = createApiCallContext();
        ctx.responseHeaders.set('X-Before', 'yes');
        const refused = await pipeline.run(request(), ctx, { name: 'thing.do', mode: 'public' }, async () => refuse('No.', { code: 'app/no' }));
        expect(JSON.parse(refused.answer.body).errorMessage).toEqual({ type: 'warning', code: 'app/no', content: 'No.' });
        expect(refused.answer.headers['X-Before']).toEqual(['yes']);
        // The call keeps its headers rather than forgetting them: the server
        // adapter applies them again onto whatever response its afterRender
        // hooks produced, and applying twice changes nothing.
        expect(ctx.responseHeaders.size).toBe(1);
        ctx.responseHeaders.applyInto(refused.answer.headers);
        expect(refused.answer.headers['X-Before']).toEqual(['yes']);

        const validation = await pipeline.run(request(), createApiCallContext(), { name: 'thing.do', mode: 'public' }, async () => { throw new LambderApiValidationRefusal(z.string().safeParse(1).error!); });
        expect(validation.answer.statusCode).toBe(422);
        expect(isLambderApiValidationRefusal(new LambderApiValidationRefusal(z.string().safeParse(1).error!))).toBe(true);

        await expect(pipeline.run(request(), createApiCallContext(), { name: 'thing.do', mode: 'public' }, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    });

    it('runs guards over the request and writes guardData; a session definition needs a session', async () => {
        const pipeline = new LambderApiPipeline({
            guards: {
                stamp: { handler: (_ctx: unknown, _payload: undefined, param: string) => ({ param }) },
                token: { guardInput: z.object({ t: z.string() }), handler: (_ctx: unknown, { t }: { t: string }) => t },
            },
        });
        const ctx = createApiCallContext();
        const result = await pipeline.run(request({ guardInputs: { token: { t: 'abc' } } }), ctx, { name: 'thing.do', mode: 'public', guards: { stamp: 'p', token: true } }, async () => {
            expect(ctx.guardData).toEqual({ stamp: { param: 'p' }, token: 'abc' });
            return okExec();
        });
        expect(result.guardsRun).toEqual(['stamp', 'token']);

        await expect(pipeline.run(request(), createApiCallContext(), { name: 'thing.do', mode: 'session' }, okExec)).rejects.toThrow(/no session store was configured/);
        expect(() => pipeline.assertRegistration({ name: 'x', mode: 'public', guards: 'nope' })).toThrow(/unknown guard "nope"/);
        // Each subsystem reports its own absence, the way idempotency does.
        expect(() => new LambderApiPipeline().assertRegistration({ name: 'x', mode: 'public', guards: 'nope' })).toThrow(/declares guards but no guards option was configured at creation/);
        expect(() => new LambderApiPipeline().assertRegistration({ name: 'x', mode: 'public', rateLimit: 'nope' })).toThrow(/declares rateLimit but no rateLimits option was configured at creation/);
        expect(() => new LambderApiPipeline().assertRegistration({ name: 'x', mode: 'public', idempotency: true })).toThrow(/declares idempotency but no idempotency store was configured at creation/);
    });

    it('fetches the session on session definitions and answers sessionExpired without one', async () => {
        const store = new LambderMemorySessionStore();
        const manager = new LambderSessionManager({ store, sessionSalt: 's' });
        const pipeline = new LambderApiPipeline({ sessions: { manager } });
        const { sessionToken, csrfToken } = await manager.createSession('u1', { role: 'x' });

        const missing = await pipeline.run(request(), createApiCallContext(), { name: 'thing.do', mode: 'session' }, okExec);
        expect(JSON.parse(missing.answer.body).sessionExpired).toBe(true);

        const ctx = createApiCallContext();
        const present = await pipeline.run(request({ cookies: { LMDRSESSIONTKID: [sessionToken] }, token: csrfToken }), ctx, { name: 'thing.do', mode: 'session' }, async () => {
            expect(ctx.session?.sessionKey).toBe('u1');
            return okExec();
        });
        expect(present.answer.statusCode).toBe(200);
        expect(pipeline.hasSessions).toBe(true);
        expect(() => new LambderApiPipeline().sessionManager).toThrow(/Session is not enabled/);
    });

    it('replays through the idempotency store, before the session-keyed limits, with the drained headers stored', async () => {
        const limiter = new LambderMemoryRateLimiter();
        const store = new LambderMemoryIdempotencyStore();
        // A custom key handler runs after the session read, which is where
        // the replay fast path sits: a retry answers without charging it.
        const pipeline = new LambderApiPipeline({
            rateLimits: { limiter, policies: { perValue: { perMin: 1, per: { handler: () => 'one-bucket' } } } },
            idempotency: { store },
        });
        const definition = { name: 'thing.do', mode: 'public' as const, rateLimit: 'perValue', idempotency: true };
        let runs = 0;
        const exec = async (ctx: ReturnType<typeof createApiCallContext>) => { runs += 1; ctx.responseHeaders.set('X-Run', String(runs)); return okExec(); };
        const key = 'k-1-abcdefabcdefabcdef';

        const first = await pipeline.run(request({ idempotencyKey: key }), createApiCallContext(), definition, exec);
        const second = await pipeline.run(request({ idempotencyKey: key }), createApiCallContext(), definition, exec);
        expect(runs).toBe(1);
        expect(second.replayed).toBe(true);
        expect(second.answer.body).toBe(first.answer.body);
        expect(second.answer.headers['X-Run']).toEqual(['1']);
        // A new key is rate limited: the budget of one was spent by the first
        // run, and the replay in between was not charged.
        const third = await pipeline.run(request({ idempotencyKey: 'k-2-abcdefabcdefabcdef' }), createApiCallContext(), definition, exec);
        expect(third.answer.statusCode).toBe(429);
        // A malformed key is a 400 refusal.
        const malformed = await pipeline.run(request({ idempotencyKey: 'short' }), createApiCallContext(), definition, exec);
        expect(malformed.answer.statusCode).toBe(400);
    });

    it('writes into the trace the adapter handed it, so a crashed call still reports its guards', async () => {
        // The mock runtime reports the guards a call ran even when the
        // handler threw. The pipeline rethrows a crash, so a trace it created
        // itself went with the throw and the call log showed no guards on
        // exactly the calls someone opens a log for.
        const pipeline = new LambderApiPipeline({ guards: { first: { handler: async () => {} } } });
        const trace = { guardsRun: [] as string[], replayed: false };

        await expect(pipeline.run(
            request(), createApiCallContext(), { name: 'thing.do', mode: 'public', guards: 'first' },
            async () => { throw new Error('boom'); },
            trace,
        )).rejects.toThrow('boom');

        expect(trace.guardsRun).toEqual(['first']);
    });

    it('a guard named after an inherited property reads back as absent when it returned nothing', async () => {
        // guardData is the app's namespace: guard names are the app's to
        // choose, and on a plain object a check-only guard named "toString"
        // read back as the inherited function.
        const pipeline = new LambderApiPipeline({ guards: { toString: { handler: async () => undefined } } });
        const ctx = createApiCallContext();
        let seen: unknown = 'unset';

        await pipeline.run(request(), ctx, { name: 'thing.do', mode: 'public', guards: 'toString' }, async () => {
            seen = (ctx.guardData as Record<string, unknown>).toString;
            return okExec();
        });

        expect(seen).toBeUndefined();
    });

    it('a guard named "length" reads as absent when the client posted an ARRAY of guard inputs', async () => {
        // Arrays are objects and answer for their own properties, so without
        // the array clause in readApiEnvelope a client that sent no guard
        // input at all handed a guard named "length" the array's length, and
        // a number is a perfectly good z.number() input: the guard passed on
        // data nobody sent. The map is client data, and is read as data.
        const envelopeInfo = { headers: {}, cookies: {}, ip: '1.2.3.4', host: 'localhost' };
        const posted = readApiEnvelope({ apiName: 'thing.do', payload: { value: 'x' }, guardInputs: [7, 8] }, envelopeInfo)!;
        expect(posted.guardInputs).toBeUndefined();

        let seen: unknown = 'unset';
        const pipeline = new LambderApiPipeline({ guards: { length: { guardInput: z.number(), handler: async (_ctx: LambderApiCallContext, payload: number) => { seen = payload; } } } });
        const result = await pipeline.run(posted, createApiCallContext(), { name: 'thing.do', mode: 'public', guards: 'length' }, okExec);

        // Refused as a missing guard input, through the ordinary validation
        // answer, and the handler never ran on the array's own length.
        expect(result.answer.statusCode).toBe(422);
        expect(JSON.parse(result.answer.body).zodError.issues[0].path).toEqual([]);
        expect(seen).toBe('unset');
    });

    it('drives pendingTtlSeconds through the engine: the default, the config, then the API override', async () => {
        const windows: number[] = [];
        const store = new LambderMemoryIdempotencyStore();
        const recording = {
            peek: async () => null,
            begin: (scopeKey: string, options: { pendingTtlSeconds: number }) => { windows.push(options.pendingTtlSeconds); return store.begin(scopeKey, options); },
            complete: (scopeKey: string, owner: string, record: Parameters<LambderMemoryIdempotencyStore['complete']>[2]) => store.complete(scopeKey, owner, record),
            abandon: (scopeKey: string, owner: string) => store.abandon(scopeKey, owner),
        };
        const call = async (pipeline: LambderApiPipeline<ReturnType<typeof createApiCallContext>>, idempotency: boolean | { pendingTtlSeconds: number }, key: string) =>
            await pipeline.run(request({ idempotencyKey: key }), createApiCallContext(), { name: 'thing.do', mode: 'public', idempotency }, okExec);

        await call(new LambderApiPipeline({ idempotency: { store: recording } }), true, 'k-1-abcdefabcdefabcdef');
        await call(new LambderApiPipeline({ idempotency: { store: recording, defaultPendingTtlSeconds: 900 } }), true, 'k-2-abcdefabcdefabcdef');
        await call(new LambderApiPipeline({ idempotency: { store: recording, defaultPendingTtlSeconds: 900 } }), { pendingTtlSeconds: 30 }, 'k-3-abcdefabcdefabcdef');

        expect(windows).toEqual([300, 900, 30]);
    });

    it('refuses a pending window a store cannot act on, at creation and at registration', () => {
        const store = new LambderMemoryIdempotencyStore();
        expect(() => new LambderApiPipeline({ idempotency: { store, defaultPendingTtlSeconds: 0 } }))
            .toThrow(/defaultPendingTtlSeconds .* must be a positive integer/);
        expect(() => new LambderApiPipeline({ idempotency: { store } })
            .assertRegistration({ name: 'thing.do', mode: 'public', idempotency: { pendingTtlSeconds: NaN } }))
            .toThrow(/pendingTtlSeconds .* must be a positive integer/);
    });

    it('hands the store a copy of the answer, so the call\'s own headers cannot land in the record', async () => {
        // The pipeline applies the call's headers onto the answer AFTER the
        // engine has stored it. A store that keeps the object it was given
        // (the interface asks for a copy; a custom store is under no
        // compiler's supervision) would have this call's Set-Cookie in the
        // record and replay it to everyone.
        let kept: { headers: Record<string, string[]> } | null = null;
        const store = new LambderMemoryIdempotencyStore();
        const keepingStore = {
            peek: async () => null,
            begin: (scopeKey: string, options: { pendingTtlSeconds: number }) => store.begin(scopeKey, options),
            complete: async (_scopeKey: string, _owner: string, record: { statusCode: number; headers: Record<string, string[]>; body: string; ttlSeconds: number }) => {
                kept = record;
                return "stored" as const;
            },
            abandon: async () => {},
        };
        const pipeline = new LambderApiPipeline({ idempotency: { store: keepingStore } });
        const ctx = createApiCallContext();
        ctx.responseHeaders.add('Set-Cookie', 'evicted=; Max-Age=0');

        const result = await pipeline.run(request({ idempotencyKey: 'k-1-abcdefabcdefabcdef' }), ctx, { name: 'thing.do', mode: 'public', idempotency: true }, okExec);

        // The call's cookie still reaches this caller.
        expect(result.answer.headers['Set-Cookie']).toEqual(['evicted=; Max-Age=0']);
        // And never the record.
        expect(kept!.headers['Set-Cookie']).toBeUndefined();
    });

    it('resolves callerIdentity once per keyed call, not once per lookup', async () => {
        // It is app code: it may verify a token or read a store, and running
        // it at the replay lookup and again at the claim is a cost the app
        // never asked for and cannot see.
        let identityRuns = 0;
        const pipeline = new LambderApiPipeline({ idempotency: {
            store: new LambderMemoryIdempotencyStore(),
            callerIdentity: () => { identityRuns += 1; return 'device-one'; },
        } });
        const definition = { name: 'thing.do', mode: 'public' as const, idempotency: true };

        await pipeline.run(request({ idempotencyKey: 'k-1-abcdefabcdefabcdef' }), createApiCallContext(), definition, okExec);
        expect(identityRuns).toBe(1);

        // A replay is one lookup of its own, on its own context.
        const replay = await pipeline.run(request({ idempotencyKey: 'k-1-abcdefabcdefabcdef' }), createApiCallContext(), definition, okExec);
        expect(replay.replayed).toBe(true);
        expect(identityRuns).toBe(2);
    });

    it('fails open on a broken idempotency store, says so once, and refuses instead when told to', async () => {
        // Failing open is right, and being silent about it is not: the
        // failure class includes a missing table and a missing IAM action, so
        // an app can run for months executing every retry twice with nothing
        // in its logs.
        const broken = {
            peek: async () => { throw new Error('table missing'); },
            begin: async () => { throw new Error('table missing'); },
            complete: async () => "stored" as const,
            abandon: async () => {},
        };
        const definition = { name: 'thing.do', mode: 'public' as const, idempotency: true };
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            let runs = 0;
            const open = new LambderApiPipeline({ idempotency: { store: broken } });
            const result = await open.run(request({ idempotencyKey: 'k-1-abcdefabcdefabcdef' }), createApiCallContext(), definition, async () => { runs += 1; return okExec(); });

            expect(runs).toBe(1);
            expect(result.answer.statusCode).toBe(200);
            // The peek and the claim both failed; each says so, and each names
            // the API rather than the scope key, which carries the caller's
            // identity and their posted key.
            expect(errors).toHaveBeenCalledTimes(2);
            for(const call of errors.mock.calls){
                expect(String(call[0])).toContain('"thing.do"');
                expect(String(call[0])).not.toContain('k-1-abcdefabcdefabcdef');
            }

            const closed = new LambderApiPipeline({ idempotency: { store: broken, failOpen: false } });
            await expect(closed.run(request({ idempotencyKey: 'k-1-abcdefabcdefabcdef' }), createApiCallContext(), definition, okExec))
                .rejects.toThrow('table missing');
        } finally {
            errors.mockRestore();
        }
    });

    it('refuses an empty guards map and an empty rateLimits.policies map at creation', () => {
        expect(() => new LambderApiPipeline({ guards: {} }))
            .toThrow(/the guards option was declared with no guards in it/);
        expect(() => new LambderApiPipeline({ rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: {} } }))
            .toThrow(/the rateLimits option was declared with no policies in it/);
        // And a second configuration is refused rather than merged, the way
        // the other two engines already refused one.
        expect(() => {
            const policies = new LambderApiPolicyEngine();
            policies.configureGuards({ one: { handler: async () => {} } });
            policies.configureGuards({ two: { handler: async () => {} } });
        }).toThrow(/guards were already configured/);
    });
});
