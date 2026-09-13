/**
 * LambderInvokeCaller: a Lambder app called from another lambda.
 *
 * The callee is an unmodified Lambder instance; the caller synthesizes the
 * payload-format-2.0 event API Gateway would deliver and reads the response
 * object back. So most of these run real apps through the in-process
 * transport (LambderInvokeCaller.localTransport), and only the last groups
 * mock the Lambda SDK to check how an invoke's own failures classify.
 *
 * - The synthesized event: what the callee's ctx sees.
 * - Round trips: typed payloads and results, refusals, validation, crashes
 *   with their crash detail and logs, guards and guard inputs, null answers,
 *   an unknown API, an apiPath mismatch.
 * - Compression in both directions and the restore ceiling.
 * - onFailure as the single reporting point, for api() and apiOutcome().
 * - request() against routes.
 * - The SDK transport: FunctionError, a rejected send, timeouts, non-HTTP answers.
 * - LambderCaller and LambderInvokeCaller read the same envelope the same way.
 */

import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { brotliDecompressSync } from 'node:zlib';
import { getEventListeners } from 'node:events';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { initLambder } from '../src/core/Lambder.js';
import LambderInvokeCaller, {
    LambderInvokeError,
    isLambderInvokeError,
    compressPayloadBrotli,
    LAMBDER_INVOKE_HEADER,
    LAMBDER_INVOKED_BY_HEADER,
    LAMBDER_INVOKE_MAX_EVENT_BYTES,
    type LambderInvokeTransport,
    type LambderInvokeFailure,
} from '../src/invoke/LambderInvokeCaller.js';
import LambderCaller from '../src/client/LambderCaller.js';
import { describeCrash, errorFromCrashDetail } from '../src/shared/LambderCrashDetail.js';
import type { LambderValidationError } from '../src/shared/LambderApiOutcome.js';
import { lambderGuard } from '../src/policies/LambderApiGuards.js';
import { refuse, LAMBDER_REFUSAL_CODES } from '../src/shared/LambderApiError.js';
import { compressPayloadGzip } from '../src/shared/LambderRequestPayload.js';
import { createApiEvent, createMockContext, brotliBody, decodeBody } from './helpers.js';

/** A payload big and repetitive enough that Brotli is a large win. */
const bigPayload = (size = 400) => ({ notes: Array.from({ length: size }, (_, i) => `stop-${i} on the main line`) });

/**
 * The callee: an ordinary app with the shapes the caller has to handle. The
 * invokeOnly guard is the urbanly convention: a marker check, not security.
 */
const createCallee = () => initLambder().create({
    apiPath: '/api',
    guards: {
        invokeOnly: lambderGuard({ handler: async (ctx) => {
            if(ctx.header(LAMBDER_INVOKE_HEADER) !== '1') refuse('Not an invoke.');
        } }),
        captcha: lambderGuard({ guardInput: z.object({ token: z.string().min(3) }), handler: async () => {} }),
    },
})
    .addApi('echo', {
        input: z.object({ text: z.string() }),
        output: z.object({ text: z.string(), ip: z.string(), host: z.string(), invokedBy: z.string().nullable() }),
        guards: 'invokeOnly',
    }, (ctx, res) => res.api({
        text: ctx.apiPayload.text, ip: ctx.ip, host: ctx.host,
        invokedBy: ctx.header(LAMBDER_INVOKED_BY_HEADER) ?? null,
    }))
    .addApi('big', {
        input: z.object({ notes: z.array(z.string()) }),
        output: z.object({ notes: z.array(z.string()), count: z.number() }),
    }, (ctx, res) => res.api({ notes: ctx.apiPayload.notes, count: ctx.apiPayload.notes.length }))
    .addApi('plain', {
        input: z.object({ notes: z.array(z.string()) }),
        output: z.object({ count: z.number(), filler: z.string() }),
    }, (ctx, res) => res.api({ count: ctx.apiPayload.notes.length, filler: 'x'.repeat(2000) }, {}, { compress: false }))
    .addApi('refuse', { input: z.object({}), output: z.null() }, () => refuse('No.', { code: 'app/no', statusCode: 403 }))
    .addApi('logs', { input: z.object({}), output: z.object({ ok: z.boolean() }) }, (_ctx, res) => {
        res.logToApiResponse({ step: 1 });
        res.logToApiResponse({ step: 2 });
        return res.api({ ok: true });
    })
    .addApi('crash', { input: z.object({}), output: z.null() }, (_ctx, res) => {
        res.logToApiResponse({ before: 'the throw' });
        throw new Error('boom', { cause: new Error('root cause') });
    })
    .addApi('captchaed', { input: z.object({}), output: z.object({ ok: z.boolean() }), guards: 'captcha' }, (_ctx, res) => res.api({ ok: true }))
    .addApi('nullAnswer', { input: z.object({}), output: z.object({ n: z.number() }).nullable() }, (_ctx, res) => res.api(null))
    .addApi('whoami', {
        input: z.object({}),
        output: z.object({ cookie: z.record(z.string(), z.string()), token: z.string() }),
    }, (ctx, res) => res.api({ cookie: ctx.cookie, token: String(ctx.post.token ?? '') }))
    .addRoute('/hello', (ctx, res) => res.text(`hi ${ctx.get.name ?? 'nobody'}`, { headers: { 'X-Seen-Cookie': ctx.cookie.session ?? '' } }))
    .setGlobalErrorHandler((err, ctx, res, logList) =>
        res.api(null, { errorMessage: 'Internal server error.', crash: describeCrash(err, ctx), logList }, { statusCode: 500 }));

type Callee = ReturnType<typeof createCallee>;
type Contract = Callee['ApiContract'];

/** The in-process transport, plus a record of every event sent and every raw answer. */
const capturing = (callee: Callee) => {
    const seen: { event: APIGatewayProxyEventV2; result: any }[] = [];
    const inner = LambderInvokeCaller.localTransport(callee.getHandler());
    const transport: LambderInvokeTransport = async (event, options) => {
        const answer = await inner(event, options);
        seen.push({ event, result: answer.result });
        return answer;
    };
    return { transport, seen };
};

const callerFor = (callee: Callee, options: Partial<ConstructorParameters<typeof LambderInvokeCaller<Contract>>[0]> = {}) =>
    new LambderInvokeCaller<Contract>({
        functionName: 'callee-fn',
        transport: LambderInvokeCaller.localTransport(callee.getHandler()),
        ...options,
    });

describe('LambderInvokeCaller - the synthesized event', () => {
    it('createEvent builds the API Gateway v2 shape createContext expects', () => {
        const event = LambderInvokeCaller.createEvent({
            apiPath: '/api', apiName: 'echo', payload: { text: 'x' }, host: 'callee-host',
            apiVersion: '7', guardInputs: { captcha: { token: 'abc' } }, idempotencyKey: 'abcdefghijklmnop',
            clientIp: '203.0.113.7', headers: { 'X-Custom': 'yes' },
        });

        expect(event.version).toBe('2.0');
        expect(event.rawPath).toBe('/api');
        expect(event.requestContext.http.method).toBe('POST');
        expect(event.requestContext.http.sourceIp).toBe('203.0.113.7');
        expect(event.requestContext.domainName).toBe('callee-host');
        expect(event.isBase64Encoded).toBe(false);
        // Headers lowercased, as API Gateway delivers them.
        expect(event.headers.host).toBe('callee-host');
        expect(event.headers['content-type']).toBe('application/json');
        expect(event.headers['accept-encoding']).toBe('br, gzip');
        expect(event.headers[LAMBDER_INVOKE_HEADER]).toBe('1');
        expect(event.headers['x-forwarded-for']).toBe('203.0.113.7');
        expect(event.headers['x-custom']).toBe('yes');
        // The body is LambderCaller's envelope.
        const body = JSON.parse(event.body!);
        expect(body).toEqual({
            apiName: 'echo', version: '7', token: '', siteHost: 'callee-host',
            payload: { text: 'x' }, guardInputs: { captcha: { token: 'abc' } }, idempotencyKey: 'abcdefghijklmnop',
        });
        expect(event.cookies).toBeUndefined();
    });

    it('a session becomes the token cookie and the CSRF token in the body', () => {
        const event = LambderInvokeCaller.createEvent({ apiName: 'whoami', session: { token: 'tok-1', csrf: 'csrf-1' } });
        expect(event.cookies).toEqual(['LMDRSESSIONTKID=tok-1']);
        expect(JSON.parse(event.body!).token).toBe('csrf-1');

        const custom = LambderInvokeCaller.createEvent({
            apiName: 'whoami', session: { token: 'tok-2', csrf: 'csrf-2' }, sessionTokenCookieKey: 'SID',
        });
        expect(custom.cookies).toEqual(['SID=tok-2']);
    });

    it('names the invoking function when it runs in Lambda', () => {
        vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'caller-fn');
        try {
            const event = LambderInvokeCaller.createEvent({ apiName: 'echo' });
            expect(event.headers[LAMBDER_INVOKED_BY_HEADER]).toBe('caller-fn');
        } finally {
            vi.unstubAllEnvs();
        }
        expect(LambderInvokeCaller.createEvent({ apiName: 'echo' }).headers[LAMBDER_INVOKED_BY_HEADER]).toBeUndefined();
    });
});

describe('LambderInvokeCaller - round trips through a real Lambder app', () => {
    it('api() sends a typed payload and returns the typed answer; the callee sees the invoke as an HTTP request', async () => {
        const callee = createCallee();
        const caller = callerFor(callee);

        const answer = await caller.api('echo', { text: 'hello' }, { clientIp: '198.51.100.9' });

        expect(answer).toEqual({ text: 'hello', ip: '198.51.100.9', host: 'callee-fn', invokedBy: null });
        // The declared output, not `| null`: the resolver only lets a handler answer null for an output that allows it.
        expectTypeOf(answer).toEqualTypeOf<{ text: string; ip: string; host: string; invokedBy: string | null }>();
    });

    it('the host option is what the callee sees as ctx.host; the function name is the default', async () => {
        const callee = createCallee();
        expect((await callerFor(callee, { host: 'ig.internal' }).api('echo', { text: 'x' }))?.host).toBe('ig.internal');
        expect((await callerFor(callee).api('echo', { text: 'x' }))?.host).toBe('callee-fn');
    });

    it('the contract makes a wrong name or payload a compile error', async () => {
        const caller = callerFor(createCallee());
        // @ts-expect-error no API by this name
        void caller.api('nope', {}).catch(() => {});
        // @ts-expect-error text must be a string
        void caller.api('echo', { text: 1 }).catch(() => {});
        // @ts-expect-error captcha is a guardInput-mode guard: its value cannot be omitted
        void caller.api('captchaed', {}).catch(() => {});
        await expect(caller.api('captchaed', {}, { guardInputs: { captcha: { token: 'abc' } } })).resolves.toEqual({ ok: true });
    });

    it('a guardInputsProvider covers a guard for every call, per-call values on top', async () => {
        const callee = createCallee();
        const provider = vi.fn(() => ({ captcha: { token: 'from-provider' } }));
        const caller = new LambderInvokeCaller<Contract, 'captcha'>({
            functionName: 'callee-fn',
            transport: LambderInvokeCaller.localTransport(callee.getHandler()),
            guardInputsProvider: provider,
        });

        await expect(caller.api('captchaed', {})).resolves.toEqual({ ok: true });
        expect(provider).toHaveBeenCalledWith('captchaed');
        // A short per-call token overrides the provider's and the guard refuses it: validation, not a crash.
        const outcome = await caller.apiOutcome('captchaed', {}, { guardInputs: { captcha: { token: 'x' } } });
        expect(outcome.ok).toBe(false);
        if(!outcome.ok) expect(outcome.reason).toBe('validation');
    });

    it('apiOutcome() carries the answer and its logList; onLogList receives the entries', async () => {
        const callee = createCallee();
        const onLogList = vi.fn();
        const caller = callerFor(callee, { onLogList });

        const outcome = await caller.apiOutcome('logs', {});

        expect(outcome.ok).toBe(true);
        if(outcome.ok){
            expect(outcome.payload).toEqual({ ok: true });
            expect(outcome.logList).toEqual([{ step: 1 }, { step: 2 }]);
        }
        expect(onLogList).toHaveBeenCalledWith('logs', [{ step: 1 }, { step: 2 }]);
    });

    it('without onLogList the entries are printed with the function and API name', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await callerFor(createCallee()).api('logs', {});
            expect(log).toHaveBeenCalledWith('[lambder invoke] callee-fn logs', { step: 1 });
            expect(log).toHaveBeenCalledWith('[lambder invoke] callee-fn logs', { step: 2 });
        } finally {
            log.mockRestore();
        }
    });

    it('a refusal is reason errorMessage: apiOutcome() returns it, api() throws it', async () => {
        const callee = createCallee();
        const caller = callerFor(callee);

        const outcome = await caller.apiOutcome('refuse', {});
        expect(outcome.ok).toBe(false);
        if(outcome.ok) throw new Error('unreachable');
        expect(outcome.reason).toBe('errorMessage');
        expect(outcome.status).toBe(403);
        expect(outcome.errorMessage).toEqual({ type: 'warning', code: 'app/no', content: 'No.' });
        expect(outcome.error).toBeInstanceOf(LambderInvokeError);
        expect(outcome.error.outcome).toBe(outcome);

        const thrown = await caller.api('refuse', {}).then(() => null, (err: unknown) => err);
        expect(isLambderInvokeError(thrown)).toBe(true);
        if(!isLambderInvokeError(thrown)) throw new Error('unreachable');
        expect(thrown.message).toBe('callee-fn refuse failed (errorMessage): No.');
        expect(thrown.reason).toBe('errorMessage');
        expect(thrown.apiName).toBe('refuse');
        expect(thrown.functionName).toBe('callee-fn');
        expect(thrown.errorMessage.code).toBe('app/no');
    });

    it('a rejected input is reason validation with the zod issues', async () => {
        const outcome = await callerFor(createCallee()).apiOutcome('echo', { text: 42 as unknown as string });
        expect(outcome.ok).toBe(false);
        if(outcome.ok) throw new Error('unreachable');
        expect(outcome.reason).toBe('validation');
        expect(outcome.status).toBe(422);
        expect(outcome.zodError?.issues?.[0]?.path).toEqual(['text']);
        expect(outcome.error.message).toBe('callee-fn echo failed (validation): the callee rejected the input');
    });

    it('a crash inside the callee arrives as reason server with the crash detail, the logs, and a rebuilt cause', async () => {
        const callee = createCallee();
        const outcome = await callerFor(callee).apiOutcome('crash', {});

        expect(outcome.ok).toBe(false);
        if(outcome.ok) throw new Error('unreachable');
        expect(outcome.reason).toBe('server');
        expect(outcome.status).toBe(500);
        expect(outcome.errorMessage).toBe('Internal server error.');
        // The detail the callee's global error handler described.
        expect(outcome.crash?.name).toBe('Error');
        expect(outcome.crash?.message).toBe('boom');
        expect(outcome.crash?.stack).toContain('boom');
        expect(outcome.crash?.causeList).toEqual([expect.objectContaining({ name: 'Error', message: 'root cause' })]);
        expect(outcome.crash?.functionName).toBe('callee-fn');
        expect(typeof outcome.crash?.requestId).toBe('string');
        // What the handler logged before it threw.
        expect(outcome.logList).toEqual([{ before: 'the throw' }]);
        // The thrown error names everything and carries the callee's error as its cause.
        expect(outcome.error.message).toBe('callee-fn crash failed (server): boom');
        const cause = outcome.error.cause as Error;
        expect(cause).toBeInstanceOf(Error);
        expect(cause.message).toBe('boom');
        expect(cause.stack).toBe(outcome.crash?.stack);
        expect((cause.cause as Error).message).toBe('root cause');
    });

    it('a null answer is a success with a null payload, typed by the nullable output', async () => {
        const caller = callerFor(createCallee());
        const answer = await caller.api('nullAnswer', {});
        expectTypeOf(answer).toEqualTypeOf<{ n: number } | null>();
        expect(answer).toBe(null);
        const outcome = await caller.apiOutcome('nullAnswer', {});
        expect(outcome).toMatchObject({ ok: true, payload: null, logList: [] });
    });

    it('a session rides as the token cookie and the CSRF token', async () => {
        const answer = await callerFor(createCallee()).api('whoami', {}, { session: { token: 'tok-1', csrf: 'csrf-1' } });
        expect(answer).toEqual({ cookie: { LMDRSESSIONTKID: 'tok-1' }, token: 'csrf-1' });
    });

    it('an unknown API name is the callee\'s apiNotFound refusal', async () => {
        const outcome = await (callerFor(createCallee()) as LambderInvokeCaller).apiOutcome('nope', {});
        expect(outcome.ok).toBe(false);
        if(outcome.ok) throw new Error('unreachable');
        expect(outcome.reason).toBe('errorMessage');
        expect(outcome.errorMessage.code).toBe(LAMBDER_REFUSAL_CODES.apiNotFound);
    });

    it('an apiPath mismatch names the likely cause', async () => {
        const outcome = await callerFor(createCallee(), { apiPath: '/secure' }).apiOutcome('echo', { text: 'x' });
        expect(outcome.ok).toBe(false);
        if(outcome.ok) throw new Error('unreachable');
        expect(outcome.reason).toBe('server');
        expect(outcome.status).toBe(404);
        expect(outcome.error.message).toBe('callee-fn echo failed (server): no API at /secure on callee-fn (HTTP 404): does apiPath match the callee\'s?');
    });
});

describe('LambderInvokeCaller - compression', () => {
    it('answers come back Brotli-compressed by the callee\'s default and are restored', async () => {
        const callee = createCallee();
        const { transport, seen } = capturing(callee);
        const caller = new LambderInvokeCaller<Contract>({ functionName: 'callee-fn', transport });

        const answer = await caller.api('big', bigPayload());

        expect(answer?.count).toBe(400);
        expect(answer?.notes[399]).toBe('stop-399 on the main line');
        const raw = seen[0]!.result;
        expect(raw.headers['Content-Encoding']).toBe('br');
        expect(raw.isBase64Encoded).toBe(true);
        expect(JSON.parse(brotliBody(raw)).payload.count).toBe(400);
    });

    it('a handler that answers with compress: false sends its body plainly', async () => {
        const callee = createCallee();
        const { transport, seen } = capturing(callee);
        const caller = new LambderInvokeCaller<Contract>({ functionName: 'callee-fn', transport });

        await caller.api('plain', bigPayload(5));

        expect(seen[0]!.result.headers['Content-Encoding']).toBeUndefined();
        expect(seen[0]!.result.isBase64Encoded).toBe(false);
    });

    it('requestCompression sends a large payload as payloadBr and the callee restores it', async () => {
        const callee = createCallee();
        const { transport, seen } = capturing(callee);
        const caller = new LambderInvokeCaller<Contract>({ functionName: 'callee-fn', transport, requestCompression: true });
        const payload = bigPayload();

        const answer = await caller.api('big', payload);

        expect(answer?.count).toBe(400);
        const body = JSON.parse(seen[0]!.event.body!);
        expect(body.payload).toBeUndefined();
        expect(typeof body.payloadBr).toBe('string');
        expect(body.payloadBytes).toBe(Buffer.byteLength(JSON.stringify(payload)));
        expect(JSON.parse(brotliDecompressSync(Buffer.from(body.payloadBr, 'base64')).toString('utf8'))).toEqual(payload);
        // The routing fields stay plain.
        expect(body.apiName).toBe('big');
    });

    it('small payloads go plainly; compressRequest overrides the threshold both ways', async () => {
        const callee = createCallee();
        const { transport, seen } = capturing(callee);
        const on = new LambderInvokeCaller<Contract>({ functionName: 'callee-fn', transport, requestCompression: true });
        const off = new LambderInvokeCaller<Contract>({ functionName: 'callee-fn', transport });

        await on.api('big', bigPayload(3));
        await on.api('big', bigPayload(), { compressRequest: false });
        await off.api('big', bigPayload(20), { compressRequest: true });
        await off.api('big', bigPayload());

        const bodies = seen.map((s) => JSON.parse(s.event.body!));
        expect(bodies[0].payloadBr).toBeUndefined();
        expect(bodies[1].payloadBr).toBeUndefined();
        expect(bodies[2].payloadBr).toBeDefined();
        expect(bodies[3].payloadBr).toBeUndefined();
    });

    it('compressPayloadBrotli follows the browser rules: the threshold, and only when smaller', async () => {
        const json = JSON.stringify(bigPayload());
        expect(await compressPayloadBrotli(json, json.length + 1, 5)).toBeNull();
        const compressed = await compressPayloadBrotli(json, 0, 5);
        expect(compressed).not.toBeNull();
        expect(compressed!.payloadBytes).toBe(Buffer.byteLength(json));
        expect(compressed!.payloadBr.length).toBeLessThan(json.length / 3);
        // Both algorithms agree on the plain case: an incompressible body is never sent larger.
        const image = Buffer.from(Array.from({ length: 30_000 }, () => Math.floor(Math.random() * 256))).toString('base64');
        const imageJson = JSON.stringify({ photo: image });
        expect(await compressPayloadBrotli(imageJson, 0, 5)).toBeNull();
        expect(await compressPayloadGzip(imageJson, 0)).toBeNull();
        // And the threshold is measured in UTF-8 bytes on both sides.
        const multiByte = JSON.stringify({ notes: ['ünïcödé'.repeat(20)] });
        expect(multiByte.length).toBeLessThan(200);
        expect(await compressPayloadBrotli(multiByte, 200, 5)).not.toBeNull();
        expect(await compressPayloadGzip(multiByte, 200)).not.toBeNull();
    });

    it('an answer that would restore past maxResponsePayloadBytes is a protocol failure, not an allocation', async () => {
        const outcome = await callerFor(createCallee(), { maxResponsePayloadBytes: 200 }).apiOutcome('big', bigPayload());
        expect(outcome.ok).toBe(false);
        if(outcome.ok) throw new Error('unreachable');
        expect(outcome.reason).toBe('protocol');
        expect(outcome.error.message).toContain('could not be decompressed');
    });

    it('an event over the invoke cap is refused before anything is sent', async () => {
        const callee = createCallee();
        const { transport, seen } = capturing(callee);
        const caller = new LambderInvokeCaller<Contract>({ functionName: 'callee-fn', transport });

        const outcome = await caller.apiOutcome('big', { notes: ['x'.repeat(LAMBDER_INVOKE_MAX_EVENT_BYTES)] }, { compressRequest: false });

        expect(outcome.ok).toBe(false);
        if(outcome.ok) throw new Error('unreachable');
        expect(outcome.reason).toBe('payloadTooLarge');
        expect(outcome.bytes).toBeGreaterThan(LAMBDER_INVOKE_MAX_EVENT_BYTES);
        expect(seen).toHaveLength(0);
    });
});

describe('LambderInvokeCaller - onFailure is the single reporting point', () => {
    it('runs once, and is awaited, whether the site used api() or apiOutcome(); never for a success', async () => {
        const callee = createCallee();
        const order: string[] = [];
        const onFailure = vi.fn(async (failure: LambderInvokeFailure, info: { apiName: string; functionName: string }) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            order.push(`reported ${info.functionName}:${info.apiName}:${failure.reason}`);
        });
        const caller = callerFor(callee, { onFailure });

        await caller.api('echo', { text: 'fine' });
        expect(onFailure).not.toHaveBeenCalled();

        await caller.apiOutcome('refuse', {});
        await caller.api('crash', {}).catch(() => order.push('thrown'));

        expect(onFailure).toHaveBeenCalledTimes(2);
        expect(order).toEqual(['reported callee-fn:refuse:errorMessage', 'reported callee-fn:crash:server', 'thrown']);
        const [failure] = onFailure.mock.calls[1]!;
        expect(failure.crash?.message).toBe('boom');
        expect(failure.error).toBeInstanceOf(LambderInvokeError);
    });
});

describe('LambderInvokeCaller - request() for routes', () => {
    it('reaches any route with query, headers and cookies, and hands back the decoded answer', async () => {
        const caller = callerFor(createCallee());

        const hello = await caller.request({ path: '/hello', query: { name: 'Ada' }, cookies: ['session=abc'] });
        expect(hello.statusCode).toBe(200);
        expect(hello.text()).toBe('hi Ada');
        expect(hello.headers['x-seen-cookie']).toBe('abc');
        expect(hello.headers['content-type']).toContain('text/plain');

        const missing = await caller.request({ path: '/nowhere' });
        expect(missing.statusCode).toBe(404);
        expect(missing.text()).toBe('Not found.');
    });

    it('a large answer is restored like an API answer', async () => {
        const callee = initLambder().create({ apiPath: '/api' })
            .addRoute('/blob', (_ctx, res) => res.json({ notes: bigPayload().notes }));
        const caller = new LambderInvokeCaller({ functionName: 'callee-fn', transport: LambderInvokeCaller.localTransport(callee.getHandler()) });

        const answer = await caller.request({ path: '/blob' });
        expect((answer.json() as { notes: string[] }).notes).toHaveLength(400);
    });

    it('a compressed binary answer comes back byte for byte, not through a UTF-8 decode', async () => {
        // application/wasm is on Lambder's own compressible list, so a route
        // serving one is compressed without anyone asking; the bytes are not
        // text, and restoring them as text would silently replace every one
        // that is not a valid UTF-8 sequence.
        const wasm = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), Buffer.alloc(5000, 0xff)]);
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
        const callee = initLambder().create({ apiPath: '/api' })
            .addRoute('/mod.wasm', (_ctx, res) => res.raw({ statusCode: 200, headers: { 'Content-Type': 'application/wasm' }, body: wasm }))
            .addRoute('/forced.png', (_ctx, res) => res.raw({ statusCode: 200, headers: { 'Content-Type': 'image/png' }, body: png, compress: true }));
        const caller = new LambderInvokeCaller({ functionName: 'callee-fn', transport: LambderInvokeCaller.localTransport(callee.getHandler()) });

        const module = await caller.request({ path: '/mod.wasm' });
        expect(module.headers['content-encoding']).toBe('br');
        expect(module.body.equals(wasm)).toBe(true);

        const image = await caller.request({ path: '/forced.png' });
        expect(image.headers['content-encoding']).toBe('br');
        expect(image.body.equals(png)).toBe(true);
    });
});

describe('LambderInvokeCaller - the transport\'s own failures', () => {
    const lambdaMock = mockClient(LambdaClient);
    beforeEach(() => { lambdaMock.reset(); });
    afterEach(() => { lambdaMock.reset(); });

    /** A Lambda HTTP response object as the SDK hands it back. */
    const httpPayload = (body: unknown, statusCode = 200) => new TextEncoder().encode(JSON.stringify({
        statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), isBase64Encoded: false,
    }));

    it('invokes the named function with the event and reads the answer back', async () => {
        lambdaMock.on(InvokeCommand).resolves({ StatusCode: 200, Payload: httpPayload({ apiVersion: null, payload: { text: 'sdk' } }) as any });
        const caller = new LambderInvokeCaller({ functionName: 'remote-fn', clientConfig: { region: 'eu-west-1' } });

        await expect(caller.api('echo', { text: 'x' })).resolves.toEqual({ text: 'sdk' });

        const command = lambdaMock.commandCalls(InvokeCommand)[0]!.args[0].input;
        expect(command.FunctionName).toBe('remote-fn');
        expect(command.InvocationType).toBe('RequestResponse');
        const event = JSON.parse(Buffer.from(command.Payload as Uint8Array).toString('utf8'));
        expect(event.rawPath).toBe('/api');
        expect(JSON.parse(event.body).apiName).toBe('echo');
    });

    it('a FunctionError is reason crash, with Lambda\'s error payload as the cause', async () => {
        lambdaMock.on(InvokeCommand).resolves({
            StatusCode: 200, FunctionError: 'Unhandled',
            Payload: new TextEncoder().encode(JSON.stringify({ errorType: 'RangeError', errorMessage: 'out of memory', trace: ['RangeError: out of memory', '    at handler'] })) as any,
        });
        const caller = new LambderInvokeCaller({ functionName: 'remote-fn' });

        const outcome = await caller.apiOutcome('echo', {});
        expect(outcome.ok).toBe(false);
        if(outcome.ok) throw new Error('unreachable');
        expect(outcome.reason).toBe('crash');
        expect(outcome.functionError).toEqual({ errorType: 'RangeError', errorMessage: 'out of memory', trace: ['RangeError: out of memory', '    at handler'] });
        expect(outcome.error.message).toBe('remote-fn echo failed (crash): RangeError: out of memory');
        const cause = outcome.error.cause as Error;
        expect(cause.name).toBe('RangeError');
        expect(cause.stack).toBe('RangeError: out of memory\n    at handler');
    });

    it('a rejected send is reason network with the SDK error as the cause', async () => {
        const throttled = new Error('Rate Exceeded.');
        throttled.name = 'TooManyRequestsException';
        lambdaMock.on(InvokeCommand).rejects(throttled);
        const caller = new LambderInvokeCaller({ functionName: 'remote-fn' });

        const outcome = await caller.apiOutcome('echo', {});
        expect(outcome.ok).toBe(false);
        if(outcome.ok) throw new Error('unreachable');
        expect(outcome.reason).toBe('network');
        expect(outcome.error.cause).toBe(throttled);
        expect(outcome.error.message).toBe('remote-fn echo failed (network): Rate Exceeded.');
    });

    it('an answer that is not an HTTP response object is reason protocol', async () => {
        lambdaMock.on(InvokeCommand).resolves({ StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify({ hello: 'world' })) as any });
        const caller = new LambderInvokeCaller({ functionName: 'remote-fn' });

        const outcome = await caller.apiOutcome('echo', {});
        expect(outcome.ok).toBe(false);
        if(outcome.ok) throw new Error('unreachable');
        expect(outcome.reason).toBe('protocol');
        expect(outcome.error.message).toContain('did not answer with an HTTP response object');
    });

    it('timeoutMs aborts the wait with reason timeout; an already-aborted external signal is network', async () => {
        const hanging: LambderInvokeTransport = (_event, { signal }) => new Promise((_resolve, reject) => {
            if(signal?.aborted){ reject(new Error('aborted before sending')); return; }
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        const caller = new LambderInvokeCaller({ functionName: 'slow-fn', transport: hanging, timeoutMs: 20 });

        const timedOut = await caller.apiOutcome('echo', {});
        expect(timedOut.ok).toBe(false);
        if(!timedOut.ok) expect(timedOut.reason).toBe('timeout');

        const controller = new AbortController();
        controller.abort();
        const external = await caller.apiOutcome('echo', {}, { signal: controller.signal });
        expect(external.ok).toBe(false);
        if(!external.ok) expect(external.reason).toBe('network');
    });

    it('request() throws the same LambderInvokeError for a crash or a rejected send', async () => {
        lambdaMock.on(InvokeCommand).resolves({ StatusCode: 200, FunctionError: 'Unhandled', Payload: new TextEncoder().encode('{"errorType":"Error","errorMessage":"init failed"}') as any });
        const onFailure = vi.fn();
        const caller = new LambderInvokeCaller({ functionName: 'remote-fn', onFailure });

        const thrown = await caller.request({ path: '/hello' }).then(() => null, (err: unknown) => err);
        expect(isLambderInvokeError(thrown)).toBe(true);
        if(isLambderInvokeError(thrown)){
            expect(thrown.reason).toBe('crash');
            expect(thrown.apiName).toBe('GET /hello');
        }
        expect(onFailure).toHaveBeenCalledOnce();
    });
});

describe('describeCrash and errorFromCrashDetail', () => {
    it('describes an Error with its cause chain and where it happened', () => {
        const error = new TypeError('bad type', { cause: new Error('one', { cause: new Error('two', { cause: new Error('three', { cause: new Error('four') }) }) }) });
        const detail = describeCrash(error, { lambdaContext: { awsRequestId: 'req-1', functionName: 'fn-1' } });
        expect(detail.name).toBe('TypeError');
        expect(detail.message).toBe('bad type');
        expect(detail.stack).toContain('bad type');
        // Three levels, like the reporters that will store it.
        expect(detail.causeList?.map((c) => c.message)).toEqual(['one', 'two', 'three']);
        expect(detail.requestId).toBe('req-1');
        expect(detail.functionName).toBe('fn-1');
    });

    it('describes a thrown string or object, and copes with no context', () => {
        expect(describeCrash('plain text')).toMatchObject({ name: 'Error', message: 'plain text', stack: null, requestId: null, functionName: null });
        expect(describeCrash({ code: 7 }, null)).toMatchObject({ name: 'UnknownError', message: '{"code":7}' });
    });

    it('clamps a runaway message and stack', () => {
        const error = new Error('m'.repeat(5000));
        error.stack = 's'.repeat(20_000);
        const detail = describeCrash(error);
        expect(detail.message).toHaveLength(2000);
        expect(detail.stack).toHaveLength(8000);
    });

    it('rebuilds the Error chain from a detail', () => {
        const rebuilt = errorFromCrashDetail({ name: 'RangeError', message: 'top', stack: 'RangeError: top\n    at x', causeList: [{ name: 'Error', message: 'mid' }, { name: 'Error', message: 'bottom' }] });
        expect(rebuilt.name).toBe('RangeError');
        expect(rebuilt.stack).toBe('RangeError: top\n    at x');
        expect((rebuilt.cause as Error).message).toBe('mid');
        expect(((rebuilt.cause as Error).cause as Error).message).toBe('bottom');
        expect(((rebuilt.cause as Error).cause as Error).cause).toBeUndefined();
    });
});

describe('LambderCaller and LambderInvokeCaller read the same envelope the same way', () => {
    /** fetch, answered by the callee itself: the browser path to the same app. */
    const stubFetchWith = (callee: Callee) => {
        vi.stubGlobal('window', { location: { hostname: 'localhost' } });
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
            const result = await callee.render(createApiEvent(JSON.parse(init.body), {
                headers: { Host: 'localhost', [LAMBDER_INVOKE_HEADER]: '1' },
            }), createMockContext());
            const encoding = result.multiValueHeaders?.['Content-Encoding']?.[0];
            const text = encoding === 'br' ? brotliBody(result) : decodeBody(result);
            return {
                status: result.statusCode, statusText: '',
                headers: { get: (name: string) => result.multiValueHeaders?.[name]?.[0] ?? null },
                json: async () => JSON.parse(text),
                text: async () => text,
            };
        }));
    };
    afterEach(() => { vi.unstubAllGlobals(); });

    it.each([
        ['a success', 'echo', { text: 'same' }],
        ['a refusal', 'refuse', {}],
        ['a rejected input', 'echo', { text: 5 }],
        ['a crash', 'crash', {}],
        ['an unknown API', 'nope', {}],
    ] as const)('%s', async (_label, apiName, payload) => {
        const callee = createCallee();
        stubFetchWith(callee);
        const browser = new LambderCaller({ apiPath: '/api', isCorsEnabled: false });
        // The same Host as the browser path, so `echo` answers identically.
        const server = new LambderInvokeCaller({ functionName: 'callee-fn', host: 'localhost', transport: LambderInvokeCaller.localTransport(callee.getHandler()) });

        const fromBrowser = await browser.apiOutcome(apiName, payload);
        const fromServer = await server.apiOutcome(apiName, payload);

        expect(fromServer.ok).toBe(fromBrowser.ok);
        if(fromBrowser.ok && fromServer.ok){
            expect(fromServer.payload).toEqual(fromBrowser.payload);
        }else if(!fromBrowser.ok && !fromServer.ok){
            expect(fromServer.reason).toBe(fromBrowser.reason);
            expect(fromServer.status).toBe(fromBrowser.status);
            expect(fromServer.errorMessage).toEqual(fromBrowser.errorMessage);
            expect(fromServer.response?.crash?.message).toEqual(fromBrowser.response?.crash?.message);
            expect(fromServer.response?.logList).toEqual(fromBrowser.response?.logList);
        }
    });
});

describe('LambderInvokeCaller - hooks cannot break the call', () => {
    it('a throwing onFailure is logged; apiOutcome() still resolves and api() still throws the invoke error', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const caller = callerFor(createCallee(), { onFailure: async () => { throw new Error('reporter down'); } });

            const outcome = await caller.apiOutcome('refuse', {});
            expect(outcome.ok).toBe(false);
            if(!outcome.ok) expect(outcome.reason).toBe('errorMessage');

            const thrown = await caller.api('refuse', {}).then(() => null, (err: unknown) => err);
            expect(isLambderInvokeError(thrown)).toBe(true);
            if(isLambderInvokeError(thrown)) expect(thrown.reason).toBe('errorMessage');
            expect(consoleError).toHaveBeenCalledTimes(2);
            expect(String(consoleError.mock.calls[0]![0])).toContain('onFailure threw for callee-fn refuse');
        } finally {
            consoleError.mockRestore();
        }
    });

    it('a throwing onLogList is logged and the answer still arrives', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const caller = callerFor(createCallee(), { onLogList: () => { throw new Error('log sink down'); } });
            await expect(caller.api('logs', {})).resolves.toEqual({ ok: true });
            expect(consoleError).toHaveBeenCalledOnce();
        } finally {
            consoleError.mockRestore();
        }
    });
});

describe('LambderInvokeCaller - the event is serialized once', () => {
    it('the transport receives the event and its JSON, and the JSON is what the SDK sends', async () => {
        const seen: { event: APIGatewayProxyEventV2; eventJson: string }[] = [];
        const callee = createCallee();
        const inner = LambderInvokeCaller.localTransport(callee.getHandler());
        const transport: LambderInvokeTransport = async (event, options) => {
            seen.push({ event, eventJson: options.eventJson });
            return inner(event, options);
        };
        const caller = new LambderInvokeCaller<Contract>({ functionName: 'callee-fn', transport });

        await caller.api('echo', { text: 'x' });

        expect(seen).toHaveLength(1);
        expect(seen[0]!.eventJson).toBe(JSON.stringify(seen[0]!.event));
    });

    it('a plain payload is spliced into the envelope as the JSON it was already serialized to', async () => {
        const callee = createCallee();
        const { transport, seen } = capturing(callee);
        const caller = new LambderInvokeCaller<Contract>({ functionName: 'callee-fn', transport, requestCompression: true });
        // Characters that would break a naive splice: quotes, braces, escapes, multi-byte text.
        const payload = { text: 'say "hi" } \\ { ünïcödé 🚌 \n end' };

        const answer = await caller.api('echo', payload);

        expect(answer?.text).toBe(payload.text);
        const body = JSON.parse(seen[0]!.event.body!);
        expect(body.payload).toEqual(payload);
        expect(body.apiName).toBe('echo');
        expect(body.token).toBe('');
    });

    it('the SDK transport sends exactly the serialized event', async () => {
        const lambdaMock = mockClient(LambdaClient);
        try {
            lambdaMock.on(InvokeCommand).resolves({ StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify({
                statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiVersion: null, payload: { ok: true } }), isBase64Encoded: false,
            })) as any });
            const caller = new LambderInvokeCaller({ functionName: 'remote-fn' });

            await caller.api('echo', { text: 'x' });

            const command = lambdaMock.commandCalls(InvokeCommand)[0]!.args[0].input;
            const sentJson = Buffer.from(command.Payload as Uint8Array).toString('utf8');
            const event = JSON.parse(sentJson);
            // Round trip: what was sent is a serialization of an event whose body carries the call.
            expect(JSON.stringify(event)).toBe(sentJson);
            expect(JSON.parse(event.body).payload).toEqual({ text: 'x' });
        } finally {
            lambdaMock.restore();
        }
    });
});

describe('LambderInvokeCaller - validation issues are typed as what crosses the wire', () => {
    it('zodError is the plain name, message and issues, not a ZodError instance', async () => {
        const outcome = await callerFor(createCallee()).apiOutcome('echo', { text: 42 as unknown as string });
        expect(outcome.ok).toBe(false);
        if(outcome.ok) throw new Error('unreachable');
        expectTypeOf(outcome.zodError).toEqualTypeOf<LambderValidationError | undefined>();
        expect(outcome.zodError?.name).toBe('ZodError');
        expect(outcome.zodError?.issues[0]).toMatchObject({ code: 'invalid_type', path: ['text'] });
    });

    it('the browser caller hands its validation handler the same shape', async () => {
        const callee = createCallee();
        vi.stubGlobal('window', { location: { hostname: 'localhost' } });
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
            const result = await callee.render(createApiEvent(JSON.parse(init.body), {
                headers: { Host: 'localhost', [LAMBDER_INVOKE_HEADER]: '1' },
            }), createMockContext());
            const text = decodeBody(result);
            return { status: result.statusCode, statusText: '', headers: { get: () => null }, json: async () => JSON.parse(text), text: async () => text };
        }));
        try {
            const handler = vi.fn();
            const browser = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, apiInputValidationErrorHandler: handler });
            const outcome = await browser.apiOutcome('echo', { text: 42 });
            expect(outcome.ok).toBe(false);
            if(!outcome.ok) expect(outcome.reason).toBe('validation');
            expect(handler).toHaveBeenCalledOnce();
            const [received] = handler.mock.calls[0] as [LambderValidationError];
            expect(received.issues[0]?.path).toEqual(['text']);
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe('LambderInvokeCaller - a call that cannot be built is a failure, not a throw', () => {
    /** apiOutcome() promises an outcome and api() promises a LambderInvokeError; neither may leak what serialization threw. */
    const unserializable = () => {
        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;
        return circular;
    };

    it.each([
        ['a payload holding a cycle', unserializable],
        ['a payload holding a BigInt', () => ({ n: BigInt(1) })],
    ])('%s fails as unknown through apiOutcome(), api() and onFailure', async (_label, build) => {
        const reported: LambderInvokeFailure[] = [];
        const caller = callerFor(createCallee(), { onFailure: (failure) => { reported.push(failure); } });

        const outcome = await caller.apiOutcome('echo', build() as any);
        expect(outcome.ok).toBe(false);
        if(outcome.ok) throw new Error('unreachable');
        expect(outcome.reason).toBe('unknown');
        expect(outcome.error).toBeInstanceOf(LambderInvokeError);
        expect(outcome.error.message).toContain('callee-fn echo failed (unknown)');
        expect(outcome.logList).toEqual([]);

        const thrown = await caller.api('echo', build() as any).catch((err: unknown) => err);
        expect(isLambderInvokeError(thrown)).toBe(true);
        expect((thrown as LambderInvokeError).reason).toBe('unknown');

        expect(reported).toHaveLength(2);
    });

    it('a guardInputsProvider that throws still fails the same way', async () => {
        const caller = new LambderInvokeCaller<Contract, 'captcha'>({
            functionName: 'callee-fn',
            transport: LambderInvokeCaller.localTransport(createCallee().getHandler()),
            guardInputsProvider: () => { throw new Error('no captcha service'); },
        });
        const outcome = await caller.apiOutcome('captchaed', {});
        expect(outcome.ok).toBe(false);
        if(outcome.ok) throw new Error('unreachable');
        expect(outcome.reason).toBe('unknown');
        expect(outcome.error.message).toContain('no captcha service');
    });
});

describe('LambderInvokeCaller - an external abort signal is not accumulated on', () => {
    it('detaches its listener when a call ends, so a shared signal does not grow one per call', async () => {
        const controller = new AbortController();
        // timeoutMs is what makes the caller chain its own controller to the external signal.
        const caller = callerFor(createCallee(), { timeoutMs: 5000 });

        for(let i = 0; i < 20; i += 1){
            await caller.apiOutcome('echo', { text: `call ${i}` }, { signal: controller.signal });
        }
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    it('still aborts the call when the external signal fires', async () => {
        const controller = new AbortController();
        const caller = new LambderInvokeCaller<Contract>({
            functionName: 'callee-fn',
            timeoutMs: 5000,
            transport: (_event, { signal }) => new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
        });

        const pending = caller.apiOutcome('echo', { text: 'hi' }, { signal: controller.signal });
        controller.abort();
        const outcome = await pending;
        expect(outcome.ok).toBe(false);
        if(outcome.ok) throw new Error('unreachable');
        expect(outcome.reason).toBe('network');
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });
});
