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
import {
    LambderInvokeError,
    isLambderInvokeError,
    type LambderInvokeFailure,
    type LambderInvokeFunctionError,
} from '../src/invoke/LambderInvokeOutcome.js';
import { z } from 'zod';
import { decodeLambdaHttpResult } from '../src/invoke/LambderLambdaEvent.js';
import { brotliDecompressSync } from 'node:zlib';
import { getEventListeners } from 'node:events';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { mockClient } from 'aws-sdk-client-mock';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import Lambder, { initLambder } from '../src/core/Lambder.js';
import { isV2HttpEvent } from '../src/core/LambderContext.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import LambderInvokeCaller, {
    LAMBDER_INVOKE_MAX_EVENT_BYTES,
    type LambderInvokeTransport,
} from '../src/invoke/LambderInvokeCaller.js';
import { LAMBDER_INVOKE_HEADER, LAMBDER_INVOKED_BY_HEADER, synthesizeLambdaHttpEvent } from '../src/invoke/LambderLambdaEvent.js';
import { LAMBDER_INVOKE_API_ID, LAMBDER_LOCAL_API_ID } from '../src/shared/wire/LambderInvokeApiId.js';
import LambderCaller from '../src/client/LambderCaller.js';
import { describeCrash, errorFromCrashDetail } from '../src/shared/wire/LambderCrashDetail.js';
import type { LambderValidationError } from '../src/shared/wire/LambderApiOutcome.js';
import type { LambderApiEnvelopeBody } from '../src/shared/wire/LambderApiContract.js';
import { lambderGuard } from '../src/core/LambderPolicyBuilders.js';
import { refuse, LAMBDER_REFUSAL_CODES, type LambderAppRefusalMessage } from '../src/shared/wire/LambderApiRefusal.js';
import { compressPayloadBrotli, compressPayloadGzip } from '../src/shared/wire/LambderRequestPayload.js';
import { LambderTransportFailure } from '../src/shared/transport/LambderApiTransport.js';
import { assertApiFailure } from '../src/shared/wire/LambderOutcomeAssertions.js';
import { createApiEvent, createMockContext, brotliBody, decodeBody, DEFAULT_GATEWAY_SOURCE_IP } from './helpers.js';

/** A payload big and repetitive enough that Brotli is a large win. */
const bigPayload = (size = 400) => ({ notes: Array.from({ length: size }, (_, i) => `stop-${i} on the main line`) });

/**
 * The callee: an ordinary app with the shapes the caller has to handle. The
 * invokeOnly guard is an app's own convention: a marker check, not security.
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
    .setGlobalErrorHandler((err, ctx, res) =>
        res.api(null, { errorMessage: 'Internal server error.', crash: describeCrash(err, ctx), logList: ctx?.logList }, { statusCode: 500 }));

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
            clientIp: '203.0.113.7', headers: { 'X-Custom': 'yes', 'Content-Type': 'application/x-www-form-urlencoded' },
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
        // The address rides in requestContext.http.sourceIp and nowhere else:
        // no forwarding header is the event's own to write.
        expect(event.headers['x-forwarded-for']).toBeUndefined();
        // What tells the callee this is a direct invoke: an id no gateway writes.
        expect(event.requestContext.apiId).toBe('lambder-invoke');
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

    it('owns the invoke markers and the forwarded address whatever the caller passed as headers', () => {
        // Forwarding an incoming browser request's headers into `headers` is
        // an ordinary gateway-lambda pattern. The markers say what the event
        // is, so the caller's copies go, and an invoke's address is its
        // clientIp alone, so a forwarded one goes too.
        const event = LambderInvokeCaller.createEvent({
            apiName: 'echo',
            clientIp: '203.0.113.7',
            headers: {
                'X-Forwarded-For': '198.51.100.9',
                [LAMBDER_INVOKE_HEADER]: '1',
                [LAMBDER_INVOKED_BY_HEADER]: 'not-this-function',
                'X-Custom': 'kept',
            },
        });
        expect(event.headers['x-forwarded-for']).toBeUndefined();
        expect(event.requestContext.http.sourceIp).toBe('203.0.113.7');
        expect(event.headers[LAMBDER_INVOKE_HEADER]).toBe('1');
        // Not running in Lambda, so nothing names an invoking function: the
        // caller's claim to be one is dropped rather than passed on.
        expect(event.headers[LAMBDER_INVOKED_BY_HEADER]).toBeUndefined();
        // Everything else the caller sent still travels.
        expect(event.headers['x-custom']).toBe('kept');
        expect(event.requestContext.apiId).toBe(LAMBDER_INVOKE_API_ID);
    });

    it('hands a callee that reads x-forwarded-for on any event no forwarded address, from api() or request()', async () => {
        // Regression: a gateway lambda forwarding a browser's headers passed
        // its x-forwarded-for on, and a callee on Lambder 7.x trusting that
        // header reads it whatever the event is, so the browser chose its
        // ctx.ip. This handler reads the header the way such a callee does.
        const forwardedSeen: (string | undefined)[] = [];
        const readsForwardedFor = async (event: APIGatewayProxyEventV2) => {
            forwardedSeen.push(event.headers['x-forwarded-for']);
            return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiVersion: null, payload: null }) };
        };
        const caller = new LambderInvokeCaller<Contract>({ functionName: 'old-callee', transport: LambderInvokeCaller.localTransport(readsForwardedFor) });
        const browserHeaders = { 'X-Forwarded-For': '6.6.6.6', 'User-Agent': 'a browser' };

        await caller.apiOutcome('nullAnswer', {}, { clientIp: '198.51.100.9', headers: browserHeaders });
        await caller.request({ path: '/hello', clientIp: '198.51.100.9', headers: browserHeaders });

        expect(forwardedSeen).toEqual([undefined, undefined]);
    });

    it('passes every header of a browser-shaped request on as it came, a forwarded address included, but never the invoke markers', () => {
        // A browser-shaped request stands for what a gateway delivered, so a
        // test that writes a forwarding header on one exercises the app's own
        // trustedClientIpHeaders. It cannot be made to claim it is an invoke.
        const browserShaped = synthesizeLambdaHttpEvent({
            method: 'POST', path: '/api', host: 'localhost',
            headers: { [LAMBDER_INVOKE_HEADER]: '1', [LAMBDER_INVOKED_BY_HEADER]: 'caller-fn', 'X-Forwarded-For': '198.51.100.9' },
        }, { invoke: false });
        expect(browserShaped.headers['x-forwarded-for']).toBe('198.51.100.9');
        expect(browserShaped.headers[LAMBDER_INVOKE_HEADER]).toBeUndefined();
        expect(browserShaped.headers[LAMBDER_INVOKED_BY_HEADER]).toBeUndefined();
        expect(browserShaped.requestContext.apiId).toBe(LAMBDER_LOCAL_API_ID);
    });

    it('synthesizes the REST API shape on request, with the same ownership of headers and address', () => {
        const event = synthesizeLambdaHttpEvent({
            method: 'POST', path: '/orders', host: 'shop.test', query: { page: '2' },
            headers: { 'X-Custom': 'kept', 'X-Forwarded-For': '198.51.100.9' },
            clientIp: '203.0.113.7', cookies: ['a=1', 'b=2'], body: '{"sku":"kettle"}',
        }, { invoke: false, eventFormat: 'v1' });

        expect(Lambder.isHttpEvent(event)).toBe(true);
        expect(isV2HttpEvent(event)).toBe(false);
        expect(event.httpMethod).toBe('POST');
        expect(event.path).toBe('/orders');
        expect(event.queryStringParameters).toEqual({ page: '2' });
        expect(event.multiValueQueryStringParameters).toEqual({ page: ['2'] });
        // A REST API has no cookies array: they ride in the Cookie header, once per delivery form.
        expect(event.headers.cookie).toBe('a=1; b=2');
        expect(event.multiValueHeaders.cookie).toEqual(['a=1; b=2']);
        expect(event.headers.host).toBe('shop.test');
        expect(event.headers['x-custom']).toBe('kept');
        // The asserted address is the gateway's observation here too; the
        // caller's forwarding header stands for one a proxy delivered.
        expect(event.headers['x-forwarded-for']).toBe('198.51.100.9');
        expect(event.requestContext.identity.sourceIp).toBe('203.0.113.7');
        expect(event.body).toBe('{"sku":"kettle"}');
        expect(event.isBase64Encoded).toBe(false);

        const bare = synthesizeLambdaHttpEvent({ method: 'GET', path: '/', host: 'shop.test' }, { invoke: false, eventFormat: 'v1' });
        expect(bare.queryStringParameters).toBeNull();
        expect(bare.body).toBeNull();
        expect(bare.headers.cookie).toBeUndefined();
    });

    it('sends an API call as JSON whatever Content-Type a caller forwards', async () => {
        // A gateway lambda forwarding a form post's headers: the envelope is
        // still JSON, and a server reads a POST to its API path as an API
        // call only when it says so.
        const app = initLambder().create({ apiPath: '/api' })
            .addApi('echo', { input: z.object({ text: z.string() }), output: z.object({ text: z.string() }) }, async (ctx, res) => res.api({ text: ctx.apiPayload.text }));
        const caller = new LambderInvokeCaller<typeof app.ApiContract>({ functionName: 'callee', transport: LambderInvokeCaller.localTransport(app.getHandler()) });
        expect(await caller.api('echo', { text: 'hi' }, { headers: { 'content-type': 'application/x-www-form-urlencoded' } })).toEqual({ text: 'hi' });
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

    it('reads ctx.ip and ctx.host from clientIp and host alone, whatever forwarding headers the callee trusts', async () => {
        // Regression: a gateway lambda forwarding a browser's headers let the
        // browser choose ctx.ip ("6.6.6.6") and ctx.host ("evil.example") on
        // a callee that trusts those headers behind its own CloudFront: a
        // per-IP limit, an IP allowlist, the cookie domain and host routing
        // all became the end user's to pick. A header is trusted because a
        // proxy in front of the function writes it, and an invoke has none.
        const callee = initLambder().create({
            trustedClientIpHeaders: ['x-real-ip'],
            trustedHostHeaders: ['x-forwarded-host'],
        }).addApi('whereFrom', { input: z.object({}), output: z.object({ ip: z.string(), host: z.string() }) },
            (ctx, res) => res.api({ ip: ctx.ip, host: ctx.host }))
            .addRoute('/where-from', (ctx, res) => res.json({ ip: ctx.ip, host: ctx.host }));
        const caller = new LambderInvokeCaller<typeof callee.ApiContract>({
            functionName: 'callee-fn',
            host: 'shop.internal',
            transport: LambderInvokeCaller.localTransport(callee.getHandler()),
        });
        const forwarded = { 'X-Real-IP': '6.6.6.6', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-For': '6.6.6.6' };

        expect(await caller.api('whereFrom', {}, { clientIp: '198.51.100.9', headers: forwarded }))
            .toEqual({ ip: '198.51.100.9', host: 'shop.internal' });
        const route = await caller.request({ path: '/where-from', clientIp: '198.51.100.9', headers: forwarded });
        expect(route.json()).toEqual({ ip: '198.51.100.9', host: 'shop.internal' });

        // The same headers on a request that came through a gateway are read,
        // as the callee asked.
        const throughGateway = await callee.render(
            synthesizeLambdaHttpEvent({ method: 'GET', path: '/where-from', host: 'abc.lambda-url.us-east-1.on.aws', clientIp: '198.51.100.9', headers: forwarded }, { invoke: false }),
            createMockContext(),
        );
        expect(JSON.parse(decodeBody(throughGateway))).toEqual({ ip: '6.6.6.6', host: 'evil.example' });
    });

    it('decodes the path once whatever host the invoke names, a Function URL\'s included', async () => {
        // Regression: the event arrives with its path decoded, and a callee
        // told a Function URL's event (which carries the path encoded) by its
        // domain alone decoded it again when the invoke named a lambda-url
        // host: `/%2561dmin`, decoded to `/%61dmin`, reached `/admin`.
        const seenPaths: string[] = [];
        const callee = initLambder().create({})
            .addRoute('/admin', (ctx, res) => res.text('admin'))
            .setRouteFallbackHandler((ctx, res) => { seenPaths.push(ctx.path); return res.text('other', { statusCode: 404 }); });
        for (const host of ['abc.lambda-url.us-east-1.on.aws', 'shop.internal']) {
            const caller = new LambderInvokeCaller({ functionName: 'callee-fn', host, transport: LambderInvokeCaller.localTransport(callee.getHandler()) });
            const answer = await caller.request({ path: '/%2561dmin' });
            expect(answer.statusCode).toBe(404);
            expect(answer.text()).toBe('other');
        }
        expect(seenPaths).toEqual(['/%2561dmin', '/%2561dmin']);
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
        assertApiFailure(outcome, 'validation');
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
        expect(thrown.errorMessage?.code).toBe('app/no');
    });

    it('a rejected input is reason validation with the zod issues', async () => {
        const outcome = await callerFor(createCallee()).apiOutcome('echo', { text: 42 as unknown as string });
        expect(outcome.ok).toBe(false);
        if(outcome.ok || outcome.reason !== 'validation') throw new Error('unreachable');
        expect(outcome.status).toBe(422);
        // No optional read: the validation arm carries the issues.
        expect(outcome.zodError.issues[0]?.path).toEqual(['text']);
        expect(outcome.error.message).toBe('callee-fn echo failed (validation): the callee rejected the input');
    });

    it('a crash inside the callee arrives as reason server with the crash detail, the logs, and a rebuilt cause', async () => {
        const callee = createCallee();
        const outcome = await callerFor(callee).apiOutcome('crash', {});

        expect(outcome.ok).toBe(false);
        if(outcome.ok || outcome.reason !== 'server') throw new Error('unreachable');
        expect(outcome.status).toBe(500);
        expect(outcome.errorMessage).toEqual({ type: 'error', content: 'Internal server error.' });
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
        expect(outcome.errorMessage?.code).toBe(LAMBDER_REFUSAL_CODES.apiNotFound);
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

describe('LambderInvokeCaller - the logs of an answer that failed', () => {
    /** A transport that answers with one HTTP result, whatever the call. */
    const answering = (statusCode: number, body: unknown): LambderInvokeTransport => async () => ({
        functionError: null,
        result: { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    });

    it.each([
        ['a 500 envelope', 500, { apiVersion: null, payload: null, errorMessage: 'Internal server error.', logList: [{ step: 'before the crash' }] }],
        ['a 422 validation body', 422, { error: 'Input validation failed', zodError: { name: 'ZodError', message: '', issues: [] }, logList: [{ step: 'before the crash' }] }],
    ] as const)('%s carries its logList to onLogList, like every other answer', async (_label, statusCode, body) => {
        const seen: unknown[][] = [];
        const caller = new LambderInvokeCaller<Contract>({
            functionName: 'callee-fn',
            transport: answering(statusCode, body),
            onLogList: (apiName, logList) => { seen.push([apiName, logList]); },
        });

        const outcome = await caller.apiOutcome('echo', { text: 'hi' });

        assertApiFailure(outcome);
        expect(seen).toEqual([['echo', [{ step: 'before the crash' }]]]);
        expect(outcome.logList).toEqual([{ step: 'before the crash' }]);
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
        if(outcome.ok || outcome.reason !== 'payloadTooLarge') throw new Error('unreachable');
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
        expect(failure.reason === 'server' && failure.crash?.message).toBe('boom');
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

    it('refuses an event over the invoke cap, as an API call does: the cap is on the delivery path', async () => {
        // Sent unchecked, a large body would come back as the SDK's
        // RequestEntityTooLargeException classified `protocol`, which is the
        // outcome the cap exists to avoid.
        let transportCalls = 0;
        const caller = new LambderInvokeCaller<Contract>({
            functionName: 'callee-fn',
            transport: async () => {
                transportCalls += 1;
                return { functionError: null, result: { statusCode: 200, headers: {}, body: '{}' } };
            },
        });

        const thrown = await caller.request({ method: 'POST', path: '/upload', body: 'x'.repeat(LAMBDER_INVOKE_MAX_EVENT_BYTES) })
            .catch((err: unknown) => err);

        expect(isLambderInvokeError(thrown)).toBe(true);
        expect((thrown as LambderInvokeError).reason).toBe('payloadTooLarge');
        expect((thrown as LambderInvokeError).bytes).toBeGreaterThan(LAMBDER_INVOKE_MAX_EVENT_BYTES);
        expect((thrown as LambderInvokeError).message).toContain('over the 5500000 byte invoke cap');
        expect(transportCalls).toBe(0);
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
        if(outcome.ok || outcome.reason !== 'crash') throw new Error('unreachable');
        // No optional read: the crash arm carries Lambda's error payload.
        expect(outcome.functionError).toEqual({ errorType: 'RangeError', errorMessage: 'out of memory', trace: ['RangeError: out of memory', '    at handler'] });
        expect(outcome.error.message).toBe('remote-fn echo failed (crash): RangeError: out of memory');
        const cause = outcome.error.cause as Error;
        expect(cause.name).toBe('RangeError');
        expect(cause.stack).toBe('RangeError: out of memory\n    at handler');
    });

    it('a rejected send keeps the SDK error as the cause, and a connectivity failure is reason network', async () => {
        // No $fault and no "...Exception" name: nothing came back at all,
        // which is the one case that really is the network.
        const offline = new TypeError('fetch failed');
        lambdaMock.on(InvokeCommand).rejects(offline);
        const caller = new LambderInvokeCaller({ functionName: 'remote-fn' });

        const outcome = await caller.apiOutcome('echo', {});
        expect(outcome.ok).toBe(false);
        if(outcome.ok) throw new Error('unreachable');
        expect(outcome.reason).toBe('network');
        expect(outcome.error.cause).toBe(offline);
        expect(outcome.error.message).toBe('remote-fn echo failed (network): fetch failed');
    });

    it('a service exception is reason protocol, not network: the invoke was answered, by the service', async () => {
        // AccessDenied and ResourceNotFound are a missing IAM grant and a
        // wrong function name, which are wiring faults to go and fix.
        // Reported as `network`, they would send whoever reads them to look
        // at their connection instead.
        for(const [name, message] of [
            ['AccessDeniedException', 'User is not authorized to perform: lambda:InvokeFunction'],
            ['ResourceNotFoundException', 'Function not found'],
            ['RequestEntityTooLargeException', 'Request must be smaller than 6291456 bytes'],
            ['TooManyRequestsException', 'Rate Exceeded.'],
        ]){
            const refused = Object.assign(new Error(message), { name, $fault: 'client' });
            lambdaMock.reset();
            lambdaMock.on(InvokeCommand).rejects(refused);

            const outcome = await new LambderInvokeCaller({ functionName: 'remote-fn' }).apiOutcome('echo', {});

            expect(outcome.ok).toBe(false);
            if(outcome.ok) throw new Error('unreachable');
            expect(outcome.reason).toBe('protocol');
            expect(outcome.error.cause).toBe(refused);
        }
    });

    it('believes a transport that names its own reason, as the transport contract says', async () => {
        const failing = (reason: 'network' | 'protocol'): LambderInvokeTransport =>
            async () => { throw new LambderTransportFailure(reason, `the transport says ${reason}`, { cause: new Error('underneath') }); };

        for(const reason of ['network', 'protocol'] as const){
            const outcome = await new LambderInvokeCaller({ functionName: 'remote-fn', transport: failing(reason) }).apiOutcome('echo', {});
            expect(outcome.ok).toBe(false);
            if(outcome.ok) throw new Error('unreachable');
            expect(outcome.reason).toBe(reason);
            expect((outcome.error.cause as Error).message).toBe(`the transport says ${reason}`);
        }
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
        assertApiFailure(timedOut, 'timeout');

        const controller = new AbortController();
        controller.abort();
        const external = await caller.apiOutcome('echo', {}, { signal: controller.signal });
        assertApiFailure(external, 'network');
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
        vi.stubGlobal('location', { hostname: 'localhost' });
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
        // The same address the browser path's gateway event reports, so
        // `echo`, which answers with ctx.ip, answers identically too.
        const fromServer = await server.apiOutcome(apiName, payload, { clientIp: DEFAULT_GATEWAY_SOURCE_IP });

        expect(fromServer.ok).toBe(fromBrowser.ok);
        if(fromBrowser.ok && fromServer.ok){
            expect(fromServer.payload).toEqual(fromBrowser.payload);
        }else if(!fromBrowser.ok && !fromServer.ok){
            expect(fromServer.reason).toBe(fromBrowser.reason);
            expect(fromServer.status).toBe(fromBrowser.status);
            expect(fromServer.errorMessage).toEqual(fromBrowser.errorMessage);
            // Both sides answered a 5xx here, which is the arm that keeps the
            // envelope beside its Error.
            if(fromBrowser.reason === 'server' && fromServer.reason === 'server'){
                expect(fromServer.response?.crash?.message).toEqual(fromBrowser.response?.crash?.message);
                expect(fromServer.response?.logList).toEqual(fromBrowser.response?.logList);
            }
        }
    });
});

describe('LambderInvokeCaller - hooks cannot break the call', () => {
    it('a throwing onFailure is logged; apiOutcome() still resolves and api() still throws the invoke error', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const caller = callerFor(createCallee(), { onFailure: async () => { throw new Error('reporter down'); } });

            const outcome = await caller.apiOutcome('refuse', {});
            assertApiFailure(outcome, 'errorMessage');

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
        if(outcome.ok || outcome.reason !== 'validation') throw new Error('unreachable');
        expectTypeOf(outcome.zodError).toEqualTypeOf<LambderValidationError>();
        expect(outcome.zodError.name).toBe('ZodError');
        expect(outcome.zodError.issues[0]).toMatchObject({ code: 'invalid_type', path: ['text'] });
    });

    it('the browser caller hands its validation handler the same shape', async () => {
        const callee = createCallee();
        vi.stubGlobal('location', { hostname: 'localhost' });
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
            assertApiFailure(outcome, 'validation');
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

    it('leaves no pending timer once a call settles, so a timeoutMs does not outlive its call', async () => {
        // detach() clears the timeout as well as releasing the signal. The
        // test above pins only the listener half; this one catches a missing
        // clearTimeout, which would leave a timer per call behind.
        vi.useFakeTimers();
        try {
            const caller = new LambderInvokeCaller<Contract>({
                functionName: 'callee-fn', timeoutMs: 30_000,
                transport: async () => ({
                    functionError: null,
                    result: { statusCode: 200, headers: {}, body: JSON.stringify({ apiVersion: null, payload: { text: 'hi', ip: '', host: 'callee-fn', invokedBy: null } }) },
                }),
            });

            const outcome = await caller.apiOutcome('echo', { text: 'hi' });

            expect(outcome.ok).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
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

describe('LambderInvokeCaller - an answer that arrives after the call was given up on', () => {
    it('reports timeout rather than a success, through localTransport and through a custom transport', async () => {
        // As in the browser caller: otherwise a 20ms timeoutMs would report
        // ok: true at 300ms, and the call site would act on data it had
        // already abandoned. localTransport runs the handler to completion
        // whatever the signal says, so the caller enforces timeoutMs itself.
        // Set when the 300ms handler finishes: the caller must have answered
        // before that.
        let slowHandlerFinished = false;
        const slowCallee = initLambder().create({ apiPath: '/api' })
            .addApi('slow', { input: z.object({}), output: z.object({ ok: z.boolean() }) },
                async (_ctx, res) => {
                    await new Promise((resolve) => setTimeout(resolve, 300));
                    slowHandlerFinished = true;
                    return res.api({ ok: true });
                });

        const local = new LambderInvokeCaller<typeof slowCallee.ApiContract>({
            functionName: 'callee-fn', timeoutMs: 20,
            transport: LambderInvokeCaller.localTransport(slowCallee.getHandler()),
        });
        const fromLocal = await local.apiOutcome('slow', {});
        assertApiFailure(fromLocal, 'timeout');
        // And the wait ended with the timeout rather than with the handler:
        // the handler is still running, which is what a timeout buys here. An
        // elapsed-milliseconds bound says the same thing less reliably on a
        // loaded machine.
        expect(slowHandlerFinished).toBe(false);

        // A transport that answers late without ever looking at the signal:
        // the caller cannot assume every transport honours it.
        const deafToAbort: LambderInvokeTransport = async () => {
            await new Promise((resolve) => setTimeout(resolve, 60));
            return { functionError: null, result: { statusCode: 200, headers: {}, body: JSON.stringify({ apiVersion: null, payload: { ok: true } }) } };
        };
        const custom = new LambderInvokeCaller<typeof slowCallee.ApiContract>({ functionName: 'callee-fn', timeoutMs: 10, transport: deafToAbort });
        const fromCustom = await custom.apiOutcome('slow', {});
        assertApiFailure(fromCustom, 'timeout');
    });

    it('refuses a call whose signal had already aborted, without reaching the transport', async () => {
        // Through a transport that never looks at the signal, because that is
        // what makes this the CALLER's guard under test: driven through
        // localTransport, its own throwIfAborted produces the same outcome,
        // so the caller's check could be deleted with the suite still green.
        let transportCalls = 0;
        const controller = new AbortController();
        controller.abort();
        const caller = new LambderInvokeCaller<Contract>({
            functionName: 'callee-fn',
            transport: async () => {
                transportCalls += 1;
                return { functionError: null, result: { statusCode: 200, headers: {}, body: '{"apiVersion":null,"payload":null}' } };
            },
        });

        const outcome = await caller.apiOutcome('echo', { text: 'hi' }, { signal: controller.signal });

        assertApiFailure(outcome, 'network');
        expect(transportCalls).toBe(0);
    });

    it('refuses a call whose signal had already aborted, without running the callee', async () => {
        let handlerRan = false;
        const callee = createCallee();
        const handler = callee.getHandler();
        const controller = new AbortController();
        controller.abort();
        const caller = new LambderInvokeCaller<Contract>({
            functionName: 'callee-fn',
            transport: LambderInvokeCaller.localTransport(async (event, context) => { handlerRan = true; return handler(event, context); }),
        });

        const outcome = await caller.apiOutcome('echo', { text: 'hi' }, { signal: controller.signal });

        assertApiFailure(outcome, 'network');
        expect(handlerRan).toBe(false);
    });
});

describe('LambderInvokeCaller - the answer\'s cookies', () => {
    it('surfaces them on a success and on a failure, so a rotated or cleared session is visible', async () => {
        const callee = initLambder<{ userId: string }>().create({
            apiPath: '/api',
            session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
        })
            .addApi('login', { input: z.object({ user: z.string() }), output: z.object({ ok: z.boolean() }) },
                async (ctx, res) => { await callee.getSessionController(ctx).createSession(ctx.apiPayload.user, { userId: ctx.apiPayload.user }); return res.api({ ok: true }); })
            .addSessionApi('me', { input: z.object({}), output: z.object({ userId: z.string() }) },
                async (ctx, res) => res.api({ userId: ctx.session.data.userId }))
            .addSessionApi('signOut', { input: z.object({}), output: z.null() }, async (ctx, res) => {
                await callee.getSessionController(ctx).endSession();
                return res.api(null, { errorMessage: { type: 'info', content: 'Signed out.' } });
            });
        const caller = new LambderInvokeCaller<typeof callee.ApiContract>({
            functionName: 'callee-fn',
            transport: LambderInvokeCaller.localTransport(callee.getHandler()),
        });

        const signedIn = await caller.apiOutcome('login', { user: 'ada' });
        expect(signedIn.ok).toBe(true);
        // The two session cookies the callee set: a caller carrying a user's
        // session is the browser for that call, and nothing else is.
        expect(signedIn.cookies.map((cookie) => cookie.split('=')[0]).sort()).toEqual(['LMDRSESSIONCSTK', 'LMDRSESSIONTKID']);

        // Carrying the session forward is what the cookies are for: the two
        // values a browser would have stored come straight off the answer.
        const cookieValue = (cookies: string[], name: string) =>
            cookies.map((cookie) => cookie.split(';')[0]!.split('='))
                .find(([key]) => key === name)?.[1] ?? '';
        const session = {
            token: cookieValue(signedIn.cookies, 'LMDRSESSIONTKID'),
            csrf: cookieValue(signedIn.cookies, 'LMDRSESSIONCSTK'),
        };
        expect(await caller.api('me', {}, { session })).toEqual({ userId: 'ada' });

        // A failure carries them too, which is the case that matters: the
        // answer that CLEARS a session is a refusal, and a caller that cannot
        // see its Set-Cookie keeps sending a token the callee has dropped.
        const signedOut = await caller.apiOutcome('signOut', {}, { session });
        expect(signedOut.ok).toBe(false);
        if(signedOut.ok) throw new Error('unreachable');
        expect(signedOut.reason).toBe('errorMessage');
        expect(signedOut.cookies.map((cookie) => cookie.split('=')[0]).sort()).toEqual(['LMDRSESSIONCSTK', 'LMDRSESSIONTKID']);

        // And a failure with no answer at all reports an empty list rather
        // than leaving the field missing.
        const noAnswer = await new LambderInvokeCaller({
            functionName: 'callee-fn',
            transport: async () => { throw new Error('offline'); },
        }).apiOutcome('login', { user: 'ada' });
        assertApiFailure(noAnswer);
        expect(noAnswer.cookies).toEqual([]);
    });
});

describe('LambderInvokeCaller - a failure narrows to what its reason carries', () => {
    it('narrowing on reason narrows the fields, with no optional reads', () => {
        const failure = {} as LambderInvokeFailure;

        if(failure.reason === 'validation'){
            expectTypeOf(failure.zodError).toEqualTypeOf<LambderValidationError>();
        }else if(failure.reason === 'crash'){
            expectTypeOf(failure.functionError).toEqualTypeOf<LambderInvokeFunctionError>();
        }else if(failure.reason === 'payloadTooLarge'){
            expectTypeOf(failure.bytes).toEqualTypeOf<number>();
        }else if(failure.reason === 'errorMessage'){
            // An envelope refusal always comes with the envelope, and this
            // one with the message it is about.
            expectTypeOf(failure.response).toEqualTypeOf<LambderApiEnvelopeBody<any>>();
            expectTypeOf(failure.errorMessage).toEqualTypeOf<LambderAppRefusalMessage>();
        }else if(failure.reason === 'notAuthorized'){
            expectTypeOf(failure.response).toEqualTypeOf<LambderApiEnvelopeBody<any>>();
            expectTypeOf(failure.errorMessage).toEqualTypeOf<LambderAppRefusalMessage | undefined>();
        }else{
            // A delivery failure may or may not have got an answer at all.
            expectTypeOf(failure.response).toEqualTypeOf<LambderApiEnvelopeBody<any> | undefined>();
        }
        // And what one reason has, another does not.
        expectTypeOf(failure.error).toEqualTypeOf<LambderInvokeError>();
        expectTypeOf(failure.logList).toEqualTypeOf<unknown[]>();
        expectTypeOf(failure.cookies).toEqualTypeOf<string[]>();
    });

    it('does not offer another reason\'s evidence', () => {
        const failure = {} as LambderInvokeFailure;
        if(failure.reason === 'crash'){
            // @ts-expect-error Lambda's FunctionError is not a rejected input
            void failure.zodError;
        }
        if(failure.reason === 'validation'){
            // @ts-expect-error a rejected input has issues, not a crash detail
            void failure.crash;
        }
        if(failure.reason === 'network'){
            // @ts-expect-error nothing was measured: bytes belongs to payloadTooLarge
            void failure.bytes;
        }
    });
});

describe('LambderInvokeCaller - an idempotent API demands its key at the call site', () => {
    type KeyedContract = {
        'orders.place': { input: { sku: string }; output: { orderId: string }; mode: 'public'; idempotency: true };
        'orders.list': { input: undefined; output: { orderId: string }; mode: 'public' };
        'orders.draft': { input: { sku: string }; output: { orderId: string }; mode: 'public'; idempotency: false };
    };

    it('requires idempotencyKey exactly where the contract declares idempotency', async () => {
        const caller = new LambderInvokeCaller<KeyedContract>({
            functionName: 'callee-fn',
            transport: async () => ({
                functionError: null,
                result: { statusCode: 200, headers: {}, body: JSON.stringify({ apiVersion: null, payload: { orderId: 'o-1' } }) },
            }),
        });

        expect(await caller.api('orders.place', { sku: 'a' }, { idempotencyKey: 'k-abcdefabcdefabcdef' })).toEqual({ orderId: 'o-1' });
        // @ts-expect-error a declared-idempotent API cannot be called without a key
        await caller.api('orders.place', { sku: 'a' });
        // @ts-expect-error nor with options that leave it out
        await caller.apiOutcome('orders.place', { sku: 'a' }, { timeoutMs: 50 });
        // An API that declares none, or declares it off, is unaffected.
        await caller.api('orders.list');
        await caller.api('orders.draft', { sku: 'a' });
    });
});

describe('LambderInvokeCaller - what the contract decides at the call site', () => {
    it('computes the output from the contract, and requires the payload the input demands', async () => {
        const caller = callerFor(createCallee());

        const answer = await caller.api('echo', { text: 'hi' });
        expectTypeOf(answer).toEqualTypeOf<{ text: string; ip: string; host: string; invokedBy: string | null }>();

        // @ts-expect-error the contract's output is not { madeUp: number }
        const wrong: { madeUp: number } = await caller.api('echo', { text: 'hi' });
        void wrong;
        // @ts-expect-error a required input cannot be omitted
        void caller.api('echo').catch(() => {});
        // @ts-expect-error nor on the outcome form
        void caller.apiOutcome('echo').catch(() => {});
        // @ts-expect-error a header value is a string
        void caller.api('echo', { text: 'hi' }, { headers: { count: 123 } }).catch(() => {});
    });
});

describe('decodeLambdaHttpResult', () => {
    it('accepts Content-Encoding: identity as no encoding', async () => {
        // A legal value meaning "not encoded", which a hook or a proxy may
        // set; reading it as an unsupported encoding would turn the whole
        // invoke into a protocol failure.
        const decoded = await decodeLambdaHttpResult({
            statusCode: 200,
            headers: { 'content-type': 'application/json', 'content-encoding': 'identity' },
            body: '{"a":1}',
            isBase64Encoded: false,
        }, 1_000_000);
        expect(decoded.text()).toBe('{"a":1}');
        expect(decoded.json()).toEqual({ a: 1 });
        await expect(decodeLambdaHttpResult({
            statusCode: 200, headers: { 'content-encoding': 'deflate' }, body: 'x', isBase64Encoded: false,
        }, 1_000_000)).rejects.toThrow(/unsupported Content-Encoding/);
    });
});
