/**
 * LambderCaller: outcome semantics, per-call handler overrides, timeout.
 *
 * - apiOutcome() resolves to a discriminated { ok } union and never throws.
 * - api() keeps its payload-shortcut shape (undefined on failure).
 * - Per-call handlers override the constructor handlers.
 * - timeoutMs aborts the fetch and reports reason 'timeout'.
 * - What the contract decides at the call site: the output, the payload and
 *   the header types, none of which an annotation may replace.
 * - A stale bundle asks for one reload at a time per page, however many
 *   callers the page builds, asks again when the page outlives the ask, and
 *   a reload that brings it back is a loop, however many endpoints it is
 *   stale for.
 */

import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import LambderCaller from '../src/client/LambderCaller.js';
import { initLambder } from '../src/core/Lambder.js';
import { lambderHandlerTransport } from '../src/invoke/lambderHandlerTransport.js';
import { apiNameKeyOf } from '../src/shared/wire/LambderApiSignature.js';
import { createIdempotencyKey, createIdempotencyKeyScope } from '../src/shared/wire/LambderIdempotencyKeyScope.js';
import { resolveApiOutcome, type LambderApiHttpAnswer, type LambderApiOutcome } from '../src/shared/wire/LambderApiOutcome.js';
import type { LambderApiTransport } from '../src/shared/transport/LambderApiTransport.js';

/** Minimal Response stand-in: enough surface for the caller's dispatch. */
const mockResponse = (body: any, init: { status?: number, statusText?: string, rawText?: string, invalidJson?: boolean } = {}) => ({
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { get: () => 'application/json' },
    json: async () => {
        if(init.invalidJson) throw new SyntaxError('Unexpected token');
        return init.rawText !== undefined ? JSON.parse(init.rawText) : body;
    },
    text: async () => (init.rawText !== undefined ? init.rawText : JSON.stringify(body)),
});

const stubFetch = (impl: (url: any, init: any) => any) => {
    const fetchMock = vi.fn(impl);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
};

beforeEach(() => {
    vi.stubGlobal('location', { hostname: 'localhost' });
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('LambderCaller - outcomes', () => {
    it('success: apiOutcome is ok and api() returns the payload', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: { name: 'Ada' } }));
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false });

        const outcome = await caller.apiOutcome('getUser', {});
        expect(outcome).toMatchObject({ ok: true, payload: { name: 'Ada' } });

        expect(await caller.api('getUser', {})).toEqual({ name: 'Ada' });
    });

    it('a null payload is a success, not a failure', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: null }));
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false });

        const outcome = await caller.apiOutcome('maybeGet', {});
        expect(outcome.ok).toBe(true);
        if(outcome.ok) expect(outcome.payload).toBe(null);
    });

    it('errorMessage envelope: reason errorMessage, handler called, envelope kept on the outcome', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: null, errorMessage: { type: 'warning', content: 'Denied.' } }));
        const errorMessageHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, errorMessageHandler });

        const outcome = await caller.apiOutcome('doThing', {});
        expect(outcome).toMatchObject({ ok: false, reason: 'errorMessage', errorMessage: { type: 'warning', content: 'Denied.' } });
        expect(errorMessageHandler).toHaveBeenCalledWith({ type: 'warning', content: 'Denied.' });
        // An envelope refusal always carries the envelope, so the narrowed
        // outcome needs no optional read to reach it.
        if(!outcome.ok && outcome.reason === 'errorMessage') expect(outcome.response.errorMessage).toEqual({ type: 'warning', content: 'Denied.' });

        expect(await caller.api('doThing', {})).toBe(null);
    });

    it('a refusal an app spelled out as the empty string is still a refusal', async () => {
        // The envelope keeps errorMessage: "" on purpose: an app that refuses
        // with a lookup that came back empty still meant to refuse. A
        // truthiness test would drop it and resolve ok: true with a null
        // payload. It reads as a message object, like any plain-string one.
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: null, errorMessage: '' }));
        const errorMessageHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, errorMessageHandler });

        const outcome = await caller.apiOutcome('doThing', {});

        expect(outcome).toMatchObject({ ok: false, reason: 'errorMessage', errorMessage: { type: 'error', content: '' } });
        expect(errorMessageHandler).toHaveBeenCalledWith({ type: 'error', content: '' });
    });

    it('a message an app spelled out as the empty string still reaches messageHandler', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: 'ok', message: '' }));
        const messageHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, messageHandler });

        const outcome = await caller.apiOutcome('doThing', {});

        expect(outcome.ok).toBe(true);
        expect(messageHandler).toHaveBeenCalledWith('');
    });

    it('sessionExpired envelope: reason sessionExpired, handler called, api() null', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', sessionExpired: true }));
        const sessionExpiredHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, sessionExpiredHandler });

        const outcome = await caller.apiOutcome('secure.thing', {});
        expect(outcome).toMatchObject({ ok: false, reason: 'sessionExpired' });
        expect(sessionExpiredHandler).toHaveBeenCalledOnce();
        expect(await caller.api('secure.thing', {})).toBe(undefined);
    });

    it('notAuthorized envelope: reason notAuthorized, handler called', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: null, notAuthorized: true, errorMessage: 'Permission denied.' }));
        const notAuthorizedHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, notAuthorizedHandler });

        const outcome = await caller.apiOutcome('admin.thing', {});
        expect(outcome).toMatchObject({ ok: false, reason: 'notAuthorized', errorMessage: { type: 'error', content: 'Permission denied.' } });
        expect(notAuthorizedHandler).toHaveBeenCalledOnce();
    });

    it('versionExpired envelope: reason versionExpired, handler called', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '2', versionExpired: true }));
        const versionExpiredHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', apiVersion: '1', isCorsEnabled: false, versionExpiredHandler });

        const outcome = await caller.apiOutcome('anything', {});
        expect(outcome).toMatchObject({ ok: false, reason: 'versionExpired' });
        expect(versionExpiredHandler).toHaveBeenCalledOnce();
    });

    it('HTTP 500 with a JSON envelope: reason server, errorMessage extracted, errorHandler called', async () => {
        stubFetch(async () => mockResponse(null, {
            status: 500, statusText: 'Internal Server Error',
            rawText: JSON.stringify({ apiVersion: '1', payload: null, errorMessage: 'Internal server error.' }),
        }));
        const errorHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, errorHandler });

        const outcome = await caller.apiOutcome('crash', {});
        expect(outcome).toMatchObject({ ok: false, reason: 'server', status: 500, errorMessage: { type: 'error', content: 'Internal server error.' } });
        expect(errorHandler).toHaveBeenCalledOnce();
        expect(await caller.api('crash', {})).toBe(undefined);
    });

    it('HTTP 500 with an HTML body: reason server, no errorMessage', async () => {
        stubFetch(async () => mockResponse(null, { status: 500, statusText: 'Internal Server Error', rawText: '<h1>dead</h1>' }));
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false });

        const outcome = await caller.apiOutcome('crash', {});
        expect(outcome).toMatchObject({ ok: false, reason: 'server', status: 500 });
        if(!outcome.ok) expect(outcome.errorMessage).toBe(undefined);
    });

    it('a non-JSON 200 body is a server failure, not a success', async () => {
        stubFetch(async () => mockResponse(null, { invalidJson: true }));
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false });

        const outcome = await caller.apiOutcome('weird', {});
        expect(outcome).toMatchObject({ ok: false, reason: 'server', status: 200 });
    });

    it('HTTP 422: reason validation, zodError forwarded to the validation handler', async () => {
        const zodError = { issues: [{ path: ['email'], message: 'Invalid email' }] };
        stubFetch(async () => mockResponse({ error: 'Input validation failed', zodError }, { status: 422 }));
        const apiInputValidationErrorHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, apiInputValidationErrorHandler });

        const outcome = await caller.apiOutcome('register', { email: 'nope' });
        expect(outcome).toMatchObject({ ok: false, reason: 'validation', status: 422 });
        expect(apiInputValidationErrorHandler).toHaveBeenCalledWith(zodError);
    });

    it('HTTP 422 with a non-JSON body: reason server, validation handler untouched', async () => {
        stubFetch(async () => mockResponse(null, { status: 422, statusText: 'Unprocessable Entity', invalidJson: true }));
        const apiInputValidationErrorHandler = vi.fn();
        const errorHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, apiInputValidationErrorHandler, errorHandler });

        const outcome = await caller.apiOutcome('register', { email: 'nope' });
        expect(outcome).toMatchObject({ ok: false, reason: 'server', status: 422 });
        expect(apiInputValidationErrorHandler).not.toHaveBeenCalled();
        expect(errorHandler).toHaveBeenCalledOnce();
    });

    it('network failure: reason network, errorHandler called, api() resolves without throwing', async () => {
        stubFetch(async () => { throw new TypeError('Failed to fetch'); });
        const errorHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, errorHandler });

        const outcome = await caller.apiOutcome('anything', {});
        expect(outcome).toMatchObject({ ok: false, reason: 'network' });
        expect(errorHandler).toHaveBeenCalledOnce();
        await expect(caller.api('anything', {})).resolves.toBe(undefined);
    });

    it('no handlers configured: still resolves to an outcome without throwing', async () => {
        stubFetch(async () => { throw new TypeError('Failed to fetch'); });
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false });

        const outcome = await caller.apiOutcome('anything', {});
        expect(outcome).toMatchObject({ ok: false, reason: 'network' });
    });
});

describe('createIdempotencyKey and createIdempotencyKeyScope', () => {
    const V4_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    it('produces unique v4-shaped keys', () => {
        const a = createIdempotencyKey();
        const b = createIdempotencyKey();
        expect(a).toMatch(V4_SHAPE);
        expect(b).toMatch(V4_SHAPE);
        expect(a).not.toBe(b);
    });

    it('falls back to getRandomValues when randomUUID is unavailable (insecure contexts)', () => {
        const realCrypto = globalThis.crypto;
        vi.stubGlobal('crypto', { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
        const key = createIdempotencyKey();
        expect(key).toMatch(V4_SHAPE);
    });

    it('refuses to invent a key on a runtime with no random source at all', () => {
        // The key is what scopes the replay record for a logged-out client, so
        // a Math.random fallback would hand that client's stored response to
        // whoever guessed the key. Every browser with crypto at all has
        // getRandomValues (only randomUUID is secure-context gated), so this
        // is a runtime that cannot have an idempotency key rather than one
        // that gets a weaker one.
        vi.stubGlobal('crypto', undefined);
        expect(() => createIdempotencyKey()).toThrow(/unguessable/);
    });

    it('createIdempotencyKeyScope keeps one key per operation and rotates to a fresh one', () => {
        const scope = createIdempotencyKeyScope();
        const first = scope.current;
        expect(first).toMatch(V4_SHAPE);
        // Stable across attempts of the same operation.
        expect(scope.current).toBe(first);
        // A confirmed success starts a new intent.
        const rotated = scope.rotate();
        expect(rotated).toMatch(V4_SHAPE);
        expect(rotated).not.toBe(first);
        expect(scope.current).toBe(rotated);
        // Scopes are independent of each other.
        expect(createIdempotencyKeyScope().current).not.toBe(rotated);
    });
});

describe('LambderCaller - guardInputs transport', () => {
    it('includes guardInputs in the POST body when provided, omits them otherwise', async () => {
        const fetchMock = stubFetch(async () => mockResponse({ apiVersion: '1', payload: 'ok' }));
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false });

        await caller.api('doThing', { a: 1 }, { guardInputs: { captcha: { token: 't-1' } } });
        await caller.api('doThing', { a: 1 });

        const firstBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
        const secondBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
        expect(firstBody.guardInputs).toEqual({ captcha: { token: 't-1' } });
        expect('guardInputs' in secondBody).toBe(false);
    });
});

describe('LambderCaller - idempotency key transport', () => {
    it('includes idempotencyKey in the POST body when provided, omits it otherwise', async () => {
        const fetchMock = stubFetch(async () => mockResponse({ apiVersion: '1', payload: 'ok' }));
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false });

        await caller.api('doThing', { a: 1 }, { idempotencyKey: 'key-123' });
        await caller.api('doThing', { a: 1 });

        const firstBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
        const secondBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
        expect(firstBody.idempotencyKey).toBe('key-123');
        expect('idempotencyKey' in secondBody).toBe(false);
    });
});

describe('LambderCaller - timeout and abort', () => {
    it('timeoutMs aborts the request with reason timeout', async () => {
        stubFetch((url: any, init: any) => new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        }));
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, timeoutMs: 20 });

        const outcome = await caller.apiOutcome('slow', {});
        expect(outcome).toMatchObject({ ok: false, reason: 'timeout' });
    });

    it('a per-call timeoutMs overrides the constructor default', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: 'fast' }));
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, timeoutMs: 1 });

        // The mock resolves immediately, so only the wiring is exercised;
        // a generous per-call override must not abort.
        const outcome = await caller.apiOutcome('fast', {}, { timeoutMs: 10000 });
        expect(outcome.ok).toBe(true);
    });

    it('lets go of a shared external signal when the call settles', async () => {
        // One controller per page or per view is the normal shape, so it
        // outlives the calls made under it. A listener left behind per call
        // pins that call's own AbortController for as long as the signal
        // lives, and they accumulate.
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: 'ok' }));
        const controller = new AbortController();
        let listeners = 0;
        const { addEventListener, removeEventListener } = controller.signal;
        controller.signal.addEventListener = ((...args: Parameters<typeof addEventListener>) => {
            listeners += 1;
            return addEventListener.apply(controller.signal, args);
        }) as typeof addEventListener;
        controller.signal.removeEventListener = ((...args: Parameters<typeof removeEventListener>) => {
            listeners -= 1;
            return removeEventListener.apply(controller.signal, args);
        }) as typeof removeEventListener;
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, timeoutMs: 5000 });

        for(let i = 0; i < 10; i += 1) await caller.apiOutcome('thing', {}, { signal: controller.signal });

        expect(listeners).toBe(0);
    });

    it('refuses a call whose signal had already aborted, without reaching the transport', async () => {
        // No timeoutMs, so nothing chains a controller: the caller itself has
        // to notice. Honouring the signal is the transport's obligation and
        // not every transport does, and a call already given up on should
        // never leave.
        const fetchMock = stubFetch(async () => mockResponse({ apiVersion: '1', payload: 'ok' }));
        const controller = new AbortController();
        controller.abort();
        const errors: Error[] = [];
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, errorHandler: (err) => { errors.push(err); } });

        const outcome = await caller.apiOutcome('anything', {}, { signal: controller.signal });

        expect(outcome).toMatchObject({ ok: false, reason: 'network' });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(errors.length).toBe(1);
    });

    it('an already-aborted external signal fails as network, not timeout', async () => {
        stubFetch((url: any, init: any) => new Promise((_, reject) => {
            if(init.signal?.aborted) reject(new DOMException('The operation was aborted.', 'AbortError'));
            init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        }));
        const controller = new AbortController();
        controller.abort();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, timeoutMs: 5000 });

        const outcome = await caller.apiOutcome('anything', {}, { signal: controller.signal });
        expect(outcome).toMatchObject({ ok: false, reason: 'network' });
    });
});

describe('LambderCaller - the answer\'s logList', () => {
    it('goes to logListHandler when there is one, and to console.log when there is not', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: 'ok', logList: [{ step: 1 }, { step: 2 }] }));
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
            await new LambderCaller({ apiPath: '/api', isCorsEnabled: false }).api('thing', {});
            expect(consoleLog).toHaveBeenCalledTimes(2);
            expect(consoleLog).toHaveBeenCalledWith('[lambder]', { step: 1 });

            consoleLog.mockClear();
            const seen: unknown[] = [];
            const caller = new LambderCaller({
                apiPath: '/api', isCorsEnabled: false,
                logListHandler: (apiName, logList) => { seen.push([apiName, logList]); },
            });
            await caller.api('thing', {});
            expect(seen).toEqual([['thing', [{ step: 1 }, { step: 2 }]]]);
            // The handler replaces the printing rather than adding to it.
            expect(consoleLog).not.toHaveBeenCalled();

            // And, like every other handler, it can be overridden per call.
            const perCall: unknown[] = [];
            await caller.api('thing', {}, { logListHandler: (_apiName, logList) => { perCall.push(logList); } });
            expect(perCall).toEqual([[{ step: 1 }, { step: 2 }]]);
            expect(seen.length).toBe(1);
        } finally {
            consoleLog.mockRestore();
        }
    });
});

describe('LambderCaller - the logs of an answer that failed', () => {
    it('reach the handler for a 500 and for a 422, not only for an answer the caller read on', async () => {
        // A failed answer's logs are the ones worth the most, so a 500 that
        // a global error handler gave the crash and the log trail surfaces
        // them just as a success does.
        const seen: unknown[][] = [];
        const caller = new LambderCaller({
            apiPath: '/api', isCorsEnabled: false,
            logListHandler: (apiName, logList) => { seen.push([apiName, logList]); },
        });

        stubFetch(async () => mockResponse(null, {
            status: 500, statusText: 'Internal Server Error',
            rawText: JSON.stringify({ apiVersion: '1', payload: null, errorMessage: 'Internal server error.', logList: [{ step: 'before the crash' }] }),
        }));
        expect((await caller.apiOutcome('crash', {})).ok).toBe(false);

        // The callee writes the call's logList onto the 422 body as it does
        // onto a success, so the reader surfaces it there too.
        stubFetch(async () => mockResponse({
            error: 'Input validation failed',
            zodError: { name: 'ZodError', message: '', issues: [] },
            logList: [{ step: 'before the rejection' }],
        }, { status: 422 }));
        expect((await caller.apiOutcome('register', { email: 'nope' })).ok).toBe(false);

        expect(seen).toEqual([
            ['crash', [{ step: 'before the crash' }]],
            ['register', [{ step: 'before the rejection' }]],
        ]);
    });
});

describe('LambderCaller - what the contract decides at the call site', () => {
    type Contract = {
        'user.get': { input: { id: string }, output: { name: string } },
        'ping': { input: undefined, output: string },
    };

    it('computes the output from the contract, so an annotation cannot replace it', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: { name: 'Ada' } }));
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false });

        const out = await caller.api('user.get', { id: '1' });
        expectTypeOf(out).toEqualTypeOf<{ name: string } | null | undefined>();

        // @ts-expect-error the contract's output is not { madeUp: number }
        const wrong: { madeUp: number } | null | undefined = await caller.api('user.get', { id: '1' });
        void wrong;

        const outcome = await caller.apiOutcome('user.get', { id: '1' });
        // @ts-expect-error the same holds for the full outcome
        const wrongOutcome: LambderApiOutcome<{ madeUp: number }> = outcome;
        void wrongOutcome;
    });

    it('requires the payload unless the API\'s input accepts undefined', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: 'ok' }));
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false });

        await caller.api('user.get', { id: '1' });
        // @ts-expect-error a required input cannot be omitted
        await caller.api('user.get');
        // @ts-expect-error nor on the outcome form
        await caller.apiOutcome('user.get');
        // An input that accepts undefined keeps the one-argument call.
        await caller.api('ping');
        await caller.apiOutcome('ping');
    });

    it('requires an idempotencyKey exactly where the contract declares idempotency', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: 'ok' }));
        type KeyedContract = {
            'order.create': { input: { qty: number }, output: { orderId: string }, idempotency: true },
            'order.list': { input: undefined, output: string[] },
            'order.draft': { input: { qty: number }, output: null, idempotency: false },
            'order.gift': { input: { qty: number }, output: null, idempotency: true, guardInputs: { turnstile: { token: string } } },
        };
        const caller = new LambderCaller<KeyedContract>({ apiPath: '/api', isCorsEnabled: false });

        await caller.api('order.create', { qty: 1 }, { idempotencyKey: 'k-abcdefabcdefabcdef' });
        // @ts-expect-error a declared-idempotent API cannot be called without a key
        await caller.api('order.create', { qty: 1 });
        // @ts-expect-error nor with options that leave it out
        await caller.apiOutcome('order.create', { qty: 1 }, { timeoutMs: 50 });
        // The requirement composes with the guardInputs one, on the same argument.
        await caller.api('order.gift', { qty: 1 }, { idempotencyKey: 'k-abcdefabcdefabcdef', guardInputs: { turnstile: { token: 't' } } });
        // @ts-expect-error the key is missing beside the guard input that is there
        await caller.api('order.gift', { qty: 1 }, { guardInputs: { turnstile: { token: 't' } } });
        // An API that declares none, or declares it off, is unaffected.
        await caller.api('order.list');
        await caller.api('order.draft', { qty: 1 });
    });

    it('types per-call headers as strings, since that is what a header is', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: 'ok' }));
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false });

        await caller.api('ping', undefined, { headers: { 'X-Count': '123' } });
        // @ts-expect-error a header value is a string, and a number must not compile and reach fetch
        await caller.api('ping', undefined, { headers: { count: 123 } });
    });
});

describe('LambderCaller - per-call handler overrides', () => {
    it('a per-call errorHandler wins over the constructor handler', async () => {
        stubFetch(async () => mockResponse(null, { status: 500, statusText: 'Internal Server Error', rawText: 'dead' }));
        const constructorHandler = vi.fn();
        const perCallHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, errorHandler: constructorHandler });

        await caller.apiOutcome('crash', {}, { errorHandler: perCallHandler });
        expect(perCallHandler).toHaveBeenCalledOnce();
        expect(constructorHandler).not.toHaveBeenCalled();
    });

    it('a per-call errorMessageHandler wins over the constructor handler', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: null, errorMessage: 'Denied.' }));
        const constructorHandler = vi.fn();
        const perCallHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, errorMessageHandler: constructorHandler });

        await caller.apiOutcome('doThing', {}, { errorMessageHandler: perCallHandler });
        expect(perCallHandler).toHaveBeenCalledWith({ type: 'error', content: 'Denied.' });
        expect(constructorHandler).not.toHaveBeenCalled();
    });

    it('a per-call sessionExpiredHandler wins over the constructor handler', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', sessionExpired: true }));
        const constructorHandler = vi.fn();
        const perCallHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, sessionExpiredHandler: constructorHandler });

        await caller.apiOutcome('secure.thing', {}, { sessionExpiredHandler: perCallHandler });
        expect(perCallHandler).toHaveBeenCalledOnce();
        expect(constructorHandler).not.toHaveBeenCalled();
    });
});

describe('LambderCaller - lifecycle handlers and resilience', () => {
    it('fetchStarted/fetchEnded fire, and fetchEnded receives the Error on 500', async () => {
        stubFetch(async () => mockResponse(null, { status: 500, statusText: 'Internal Server Error', rawText: 'dead' }));
        const started: string[] = [];
        let endedWith: any = 'unset';
        const caller = new LambderCaller({
            apiPath: '/api', isCorsEnabled: false,
            fetchStartedHandler: ({ fetchParams }) => { started.push(fetchParams.apiName); },
            fetchEndedHandler: ({ fetchResult }) => { endedWith = fetchResult; },
        });

        await caller.apiOutcome('crash', {});
        expect(started).toEqual(['crash']);
        expect(endedWith).toBeInstanceOf(Error);
    });

    it('fetchEnded receives the parsed envelope on success', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: 'ok' }));
        let endedWith: any = 'unset';
        const caller = new LambderCaller({
            apiPath: '/api', isCorsEnabled: false,
            fetchEndedHandler: ({ fetchResult }) => { endedWith = fetchResult; },
        });

        await caller.apiOutcome('fine', {});
        expect(endedWith).toMatchObject({ payload: 'ok' });
    });

    it('an app handler that throws yields reason unknown instead of propagating', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: null, errorMessage: 'Denied.' }));
        const caller = new LambderCaller({
            apiPath: '/api', isCorsEnabled: false,
            errorMessageHandler: () => { throw new Error('handler bug'); },
        });

        const outcome = await caller.apiOutcome('doThing', {});
        expect(outcome).toMatchObject({ ok: false, reason: 'unknown' });
        if(!outcome.ok && outcome.reason === 'unknown') expect(outcome.error.message).toBe('handler bug');
    });
});

describe('LambderCaller - guardInputsProvider', () => {
    it('sends the provider\'s guardInputs on every call, per-call inputs merged on top', async () => {
        const fetchMock = stubFetch(async () => mockResponse({ apiVersion: '1', payload: 'ok' }));
        const provider = vi.fn((apiName: string) => ({ orgPermission: { orgSlug: `org-for-${apiName}` } }));
        const caller = new LambderCaller<any, 'orgPermission'>({ apiPath: '/api', isCorsEnabled: false, guardInputsProvider: provider });

        await caller.api('doThing', { a: 1 });
        await caller.api('doThing', { a: 1 }, { guardInputs: { captcha: { token: 't-1' } } });
        await caller.api('doThing', { a: 1 }, { guardInputs: { orgPermission: { orgSlug: 'explicit' } } });

        const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1]?.body as string));
        expect(provider).toHaveBeenCalledWith('doThing');
        expect(bodies[0].guardInputs).toEqual({ orgPermission: { orgSlug: 'org-for-doThing' } });
        expect(bodies[1].guardInputs).toEqual({ orgPermission: { orgSlug: 'org-for-doThing' }, captcha: { token: 't-1' } });
        expect(bodies[2].guardInputs).toEqual({ orgPermission: { orgSlug: 'explicit' } });
    });

    it('accepts an async provider', async () => {
        const fetchMock = stubFetch(async () => mockResponse({ apiVersion: '1', payload: 'ok' }));
        const caller = new LambderCaller<any, 'orgPermission'>({
            apiPath: '/api', isCorsEnabled: false,
            guardInputsProvider: async () => ({ orgPermission: { orgSlug: 'async-org' } }),
        });

        await caller.api('doThing', { a: 1 });

        expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).guardInputs).toEqual({ orgPermission: { orgSlug: 'async-org' } });
    });

    it('a throwing provider fails the call before anything is sent', async () => {
        const fetchMock = stubFetch(async () => mockResponse({ apiVersion: '1', payload: 'ok' }));
        const errorHandler = vi.fn();
        const caller = new LambderCaller<any, 'orgPermission'>({
            apiPath: '/api', isCorsEnabled: false, errorHandler,
            guardInputsProvider: () => { throw new Error('no organization selected'); },
        });

        const outcome = await caller.apiOutcome('doThing', { a: 1 });

        expect(outcome.ok).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(errorHandler).toHaveBeenCalledOnce();
    });

    it('typed contract: provided guards drop the options requirement, uncovered guards keep it', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: 'ok' }));
        type Contract = {
            'org.list': { input: { page: number }, output: string[], guardInputs: { orgPermission: { orgSlug: string } } },
            'org.contact': { input: { text: string }, output: null, guardInputs: { orgPermission: { orgSlug: string }, turnstile: { turnstileToken: string } } },
            'public.ping': { input: undefined, output: string },
        };
        const caller = new LambderCaller<Contract, 'orgPermission'>({
            apiPath: '/api', isCorsEnabled: false,
            guardInputsProvider: () => ({ orgPermission: { orgSlug: 'acme' } }),
        });

        // Fully provided: options optional, and the provided guard may still be overridden.
        await caller.api('org.list', { page: 1 });
        await caller.api('org.list', { page: 1 }, { guardInputs: { orgPermission: { orgSlug: 'other' } } });
        // Partly provided: the uncovered guard is still mandatory, the covered one optional.
        await caller.api('org.contact', { text: 'hi' }, { guardInputs: { turnstile: { turnstileToken: 't' } } });
        // @ts-expect-error the turnstile token cannot be omitted
        await caller.api('org.contact', { text: 'hi' });
        // @ts-expect-error the turnstile token cannot be omitted even with the provided guard given explicitly
        await caller.api('org.contact', { text: 'hi' }, { guardInputs: { orgPermission: { orgSlug: 'x' } } });
        await caller.api('public.ping');

        // Naming guards makes the provider mandatory, and its return type is checked.
        // @ts-expect-error guardInputsProvider is required once guards are named
        new LambderCaller<Contract, 'orgPermission'>({ apiPath: '/api', isCorsEnabled: false });
        new LambderCaller<Contract, 'orgPermission'>({
            apiPath: '/api', isCorsEnabled: false,
            // @ts-expect-error the provider must return the guard's declared input shape
            guardInputsProvider: () => ({ orgPermission: { orgId: 42 } }),
        });
        // Without named guards, the plain contract rule applies: options mandatory for guardInput APIs.
        const plain = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false });
        // @ts-expect-error orgPermission must be sent per call
        await plain.api('org.list', { page: 1 });
        await plain.api('org.list', { page: 1 }, { guardInputs: { orgPermission: { orgSlug: 'acme' } } });
    });
});

describe('LambderCaller - a 5xx keeps the envelope the server sent', () => {
    it('errorMessage, crash and logList from a global error handler\'s 500 body land on the outcome', async () => {
        const crash = { name: 'Error', message: 'boom', stack: 'Error: boom\n    at handler', requestId: 'req-9', functionName: 'fn' };
        stubFetch(async () => mockResponse(null, {
            status: 500, statusText: 'Internal Server Error',
            rawText: JSON.stringify({ apiVersion: '1', payload: null, errorMessage: 'Internal server error.', crash, logList: [{ before: 'the throw' }] }),
        }));
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false });

        const outcome = await caller.apiOutcome('crash', {});
        expect(outcome).toMatchObject({ ok: false, reason: 'server', status: 500, errorMessage: { type: 'error', content: 'Internal server error.' } });
        if(outcome.ok || outcome.reason !== 'server') throw new Error('unreachable');
        expect(outcome.response?.crash).toEqual(crash);
        expect(outcome.response?.logList).toEqual([{ before: 'the throw' }]);
    });
});

describe('LambderCaller - answers that are not Lambder\'s', () => {
    it('reads API Gateway\'s own JSON error as a server failure, not as a success with no payload', async () => {
        // A 413, a throttle, a WAF or missing-route 403 and an authorizer 401
        // all answer {"message": ...}. Read as an envelope, a refused save
        // would look saved and errorHandler would never run.
        stubFetch(async () => mockResponse({ message: 'Request Too Long' }, { status: 413, statusText: 'Payload Too Large' }));
        const errorHandler = vi.fn();
        const messageHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, errorHandler, messageHandler });

        const outcome = await caller.apiOutcome('doc.save', {});

        expect(outcome).toMatchObject({ ok: false, reason: 'server', status: 413 });
        if(outcome.ok || outcome.reason !== 'server') throw new Error('unreachable');
        expect(outcome.error.message).toContain('Request Too Long');
        expect(errorHandler).toHaveBeenCalledOnce();
        expect(messageHandler).not.toHaveBeenCalled();
    });

    it('never reads a non-2xx answer as a success, even when it is an envelope that names no reason', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: { saved: true } }, { status: 403, statusText: 'Forbidden' }));
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false });

        expect(await caller.apiOutcome('doc.save', {})).toMatchObject({ ok: false, reason: 'server', status: 403 });
    });

    /** A 5xx as a gateway or a proxy answers it: its own JSON, and whatever headers it sends. */
    const foreignServerAnswer = (status: number, body: unknown, headers: Record<string, string> = {}): LambderApiHttpAnswer => ({
        status, statusText: 'Gateway',
        header: (name) => headers[name.toLowerCase()] ?? null,
        json: async () => body,
        text: async () => JSON.stringify(body),
    });

    it('keeps a 5xx body only when it is Lambder\'s envelope, so a gateway\'s JSON is never read as the app\'s answer', async () => {
        // API Gateway answers a function that crashed or timed out with its
        // own {"message": ...}, and a proxy may answer with any fields at all:
        // read as an envelope, its errorMessage would reach the page as the
        // app's refusal and its crash as the callee's.
        const gateway = await resolveApiOutcome(foreignServerAnswer(502, { message: 'Internal server error' }));
        expect(gateway).toMatchObject({ ok: false, reason: 'server', status: 502 });
        expect(gateway).not.toHaveProperty('response');

        const proxy = await resolveApiOutcome(foreignServerAnswer(502, { errorMessage: 'proxy says no', crash: { name: 'Error', message: 'not ours' }, logList: ['not ours'] }));
        expect(proxy).toMatchObject({ ok: false, reason: 'server', status: 502 });
        expect(proxy).not.toHaveProperty('response');
        expect(proxy).not.toHaveProperty('errorMessage');
        expect(proxy.logList).toBeUndefined();

        const lambders = await resolveApiOutcome(foreignServerAnswer(500, { apiVersion: null, payload: null, errorMessage: 'Internal server error.' }));
        expect(lambders).toMatchObject({ ok: false, reason: 'server', status: 500, errorMessage: { type: 'error', content: 'Internal server error.' }, response: { apiVersion: null } });
    });

    it('carries a 5xx answer\'s Retry-After, as it does a refusal\'s', async () => {
        const unavailable = await resolveApiOutcome(foreignServerAnswer(503, { message: 'Service Unavailable' }, { 'retry-after': '30' }));
        expect(unavailable).toMatchObject({ ok: false, reason: 'server', status: 503, retryAfterSeconds: 30 });
    });
});

describe('LambderCaller - a sessionExpired answer that arrives after a login', () => {
    const csrfKey = 'LMDRSESSIONCSTK';

    it('clears nothing and calls no handler when the CSRF cookie is no longer the one the call sent', async () => {
        // A poll sent while signed out can answer after the login: acting on
        // it would delete the fresh CSRF cookie, and the next session call
        // would post an empty token and sign the person out again.
        const page = { cookie: `${csrfKey}=before-login` };
        vi.stubGlobal('document', page);
        stubFetch(async () => {
            page.cookie = `${csrfKey}=after-login`;
            return mockResponse({ apiVersion: '1', sessionExpired: true });
        });
        const sessionExpiredHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, sessionExpiredHandler });

        expect(await caller.apiOutcome('secure.poll', {})).toMatchObject({ ok: false, reason: 'sessionExpired' });
        expect(sessionExpiredHandler).not.toHaveBeenCalled();
        expect(page.cookie).toBe(`${csrfKey}=after-login`);
    });

    it('clears the CSRF cookie and calls the handler when the answer is about the session the page holds', async () => {
        const page = { cookie: `${csrfKey}=current` };
        vi.stubGlobal('document', page);
        stubFetch(async () => mockResponse({ apiVersion: '1', sessionExpired: true }));
        const sessionExpiredHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, sessionExpiredHandler });

        await caller.apiOutcome('secure.poll', {});

        expect(sessionExpiredHandler).toHaveBeenCalledOnce();
        expect(page.cookie).toContain(`${csrfKey}=;`);
    });

    it('calls the handler when the answer itself cleared the CSRF cookie', async () => {
        // The browser applies the answer's Set-Cookie before fetch resolves:
        // a server refusing an ambiguous cookie pair clears both, and the
        // page is left holding no token rather than a newer one.
        const page = { cookie: `${csrfKey}=current` };
        vi.stubGlobal('document', page);
        stubFetch(async () => {
            page.cookie = '';
            return mockResponse({ apiVersion: '1', sessionExpired: true });
        });
        const sessionExpiredHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, sessionExpiredHandler });

        await caller.apiOutcome('secure.poll', {});

        expect(sessionExpiredHandler).toHaveBeenCalledOnce();
    });
});

describe('LambderCaller - a call given up on while its body downloads', () => {
    it('is reported as the timeout it was, not as a malformed answer', async () => {
        // fetch resolves on the headers; the body is what takes the time.
        stubFetch(async (_url, init) => ({
            status: 200,
            statusText: 'OK',
            headers: { get: () => null },
            json: async () => ({}),
            text: () => new Promise<string>((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            }),
        }));
        const errorHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, timeoutMs: 20, errorHandler });

        expect(await caller.apiOutcome('big.list', {})).toMatchObject({ ok: false, reason: 'timeout' });
    });
});

describe('LambderCaller - a stale bundle that the reload brings back', () => {
    /**
     * The tab's sessionStorage, fresh for each test: what the page loads of
     * one test share, as a real tab keeps it across a reload.
     */
    const stubTabStorage = () => {
        const store = new Map<string, string>();
        vi.stubGlobal('sessionStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
        return store;
    };
    const refusedAsStale: LambderApiTransport = async () => ({
        status: 200, statusText: 'OK', header: () => null,
        json: async () => ({ apiVersion: '9', payload: null, versionExpired: true }),
        text: async () => '',
    });
    /**
     * LambderCaller as a page load has it: its modules evaluated afresh, as a
     * reload evaluates them, so the page's own state starts over and only
     * the tab's sessionStorage carries across. Each load is a second after
     * the last, by the clock and by the document's load time, so what an
     * earlier load recorded predates this one.
     */
    let pageLoadedAt = 1_000_000;
    const loadPageCallerClass = async () => {
        pageLoadedAt += 1_000;
        vi.setSystemTime(pageLoadedAt);
        vi.spyOn(performance, 'timeOrigin', 'get').mockReturnValue(pageLoadedAt);
        vi.resetModules();
        return (await import('../src/client/LambderCaller.js')).default;
    };
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('stops after the second load when two endpoints are stale on every load, whichever answers first', async () => {
        // Each endpoint's refusal has to stay in the record beside the
        // other's: kept one at a time, no load would see a repeat and the
        // page would reload indefinitely.
        stubTabStorage();
        const bundle = { [await apiNameKeyOf('me')]: 'stale-me', [await apiNameKeyOf('config')]: 'stale-config' };
        const versionExpiredHandler = vi.fn();
        const errors: Error[] = [];
        const loadPage = async () => new (await loadPageCallerClass())({
            apiPath: '/api', apiVersion: '1', apiSignatures: bundle, versionExpiredHandler,
            errorHandler: (err) => { errors.push(err); }, transport: refusedAsStale,
        });

        // The page boots with both in flight: it asks for a reload, once
        // or, when the second refusal lands after the first ask returned,
        // twice, and reports nothing.
        const first = await loadPage();
        await Promise.all([first.apiOutcome('me', {}), first.apiOutcome('config', {})]);
        const asksOnBoot = versionExpiredHandler.mock.calls.length;
        expect(asksOnBoot).toBeGreaterThan(0);
        expect(errors).toEqual([]);

        // The same bundle comes back, and this time config answers first.
        const second = await loadPage();
        expect(await second.apiOutcome('config', {})).toMatchObject({ ok: false, reason: 'versionExpired' });
        expect(await second.apiOutcome('me', {})).toMatchObject({ ok: false, reason: 'versionExpired' });
        expect(versionExpiredHandler).toHaveBeenCalledTimes(asksOnBoot);
        expect(errors.map((err) => err.message)).toEqual([
            expect.stringMatching(/^Version expired again for API "config"/),
            expect.stringMatching(/^Version expired again for API "me"/),
        ]);

        const third = await loadPage();
        await Promise.all([third.apiOutcome('me', {}), third.apiOutcome('config', {})]);
        expect(versionExpiredHandler).toHaveBeenCalledTimes(asksOnBoot);
    });

    it('stops after the second load for a version below the server\'s floor, where no signature is sent', async () => {
        stubTabStorage();
        const server = initLambder().create({ apiPath: '/api', apiVersion: '2.0.0', minApiVersion: '2.0.0' })
            .addApi('me', { input: z.object({}), output: z.object({ ok: z.boolean() }) }, async (_ctx, res) => res.api({ ok: true }))
            .addApi('config', { input: z.object({}), output: z.object({ ok: z.boolean() }) }, async (_ctx, res) => res.api({ ok: true }));
        const versionExpiredHandler = vi.fn();
        const errors: Error[] = [];
        const loadPage = async () => {
            const PageCaller = await loadPageCallerClass();
            return new PageCaller<typeof server.ApiContract>({
                apiPath: '/api', apiVersion: '1.0.0', versionExpiredHandler,
                errorHandler: (err) => { errors.push(err); }, transport: lambderHandlerTransport(server.getHandler()),
            });
        };

        const first = await loadPage();
        await Promise.all([first.apiOutcome('me', {}), first.apiOutcome('config', {})]);
        const asksOnBoot = versionExpiredHandler.mock.calls.length;
        expect(asksOnBoot).toBeGreaterThan(0);

        const second = await loadPage();
        expect(await second.apiOutcome('config', {})).toMatchObject({ ok: false, reason: 'versionExpired' });
        expect(await second.apiOutcome('me', {})).toMatchObject({ ok: false, reason: 'versionExpired' });
        expect(versionExpiredHandler).toHaveBeenCalledTimes(asksOnBoot);
        expect(errors).toHaveLength(2);
    });

    it('still reloads for a fresh deploy: a bundle with another signature for the endpoint', async () => {
        stubTabStorage();
        const versionExpiredHandler = vi.fn();
        const errors: Error[] = [];
        const loadBundle = async (signature: string) => new (await loadPageCallerClass())({
            apiPath: '/api', apiVersion: '1', apiSignatures: { [await apiNameKeyOf('me')]: signature }, versionExpiredHandler,
            errorHandler: (err) => { errors.push(err); }, transport: refusedAsStale,
        });

        await (await loadBundle('build-1')).apiOutcome('me', {});
        expect(versionExpiredHandler).toHaveBeenCalledTimes(1);
        // The reload got a newer build, and the server had moved on again.
        await (await loadBundle('build-2')).apiOutcome('me', {});
        expect(versionExpiredHandler).toHaveBeenCalledTimes(2);
        expect(errors).toEqual([]);
        // The same build once more is the loop.
        await (await loadBundle('build-2')).apiOutcome('me', {});
        expect(versionExpiredHandler).toHaveBeenCalledTimes(2);
        expect(errors).toHaveLength(1);
    });

    it('calls nothing for a refusal heard while the page\'s ask is still running, whichever caller hears it', async () => {
        stubTabStorage();
        const bundle = { [await apiNameKeyOf('me')]: 'stale-me', [await apiNameKeyOf('config')]: 'stale-config' };
        // A handler that waits, as a reload prompt waits for its answer.
        let finishAsk!: () => void;
        const versionExpiredHandler = vi.fn(() => new Promise<void>((resolve) => { finishAsk = resolve; }));
        const errorHandler = vi.fn();
        const PageCaller = await loadPageCallerClass();
        const pageCaller = () => new PageCaller({ apiPath: '/api', apiVersion: '1', apiSignatures: bundle, versionExpiredHandler, errorHandler, transport: refusedAsStale });

        const asking = pageCaller().apiOutcome('me', {});
        await vi.waitFor(() => expect(versionExpiredHandler).toHaveBeenCalledOnce());
        expect(await pageCaller().apiOutcome('config', {})).toMatchObject({ ok: false, reason: 'versionExpired' });
        expect(versionExpiredHandler).toHaveBeenCalledOnce();
        expect(errorHandler).not.toHaveBeenCalled();

        finishAsk();
        expect(await asking).toMatchObject({ ok: false, reason: 'versionExpired' });
    });

    it('asks again once a per-call handler has returned without reloading, so the next refusal is not dropped in silence', async () => {
        stubTabStorage();
        const versionExpiredHandler = vi.fn();
        const errorHandler = vi.fn();
        const caller = new (await loadPageCallerClass())({ apiPath: '/api', apiVersion: '1', versionExpiredHandler, errorHandler, transport: refusedAsStale });

        const leavePageAsItIs = vi.fn();
        await caller.apiOutcome('save', {}, { versionExpiredHandler: leavePageAsItIs });
        expect(leavePageAsItIs).toHaveBeenCalledOnce();

        expect(await caller.apiOutcome('save', {})).toMatchObject({ ok: false, reason: 'versionExpired' });
        expect(versionExpiredHandler).toHaveBeenCalledOnce();
        expect(errorHandler).not.toHaveBeenCalled();
    });

    it('never counts a second caller\'s refusal in the same page as a reload that changed nothing', async () => {
        // Both callers of one page hear the same stale endpoint before any
        // reload has happened, which is no evidence of a loop: the page's
        // reload may well bring a newer build, which still deserves one.
        stubTabStorage();
        const versionExpiredHandler = vi.fn();
        const errors: Error[] = [];
        const bundleCaller = async (PageCaller: typeof LambderCaller, signature: string) => new PageCaller({
            apiPath: '/api', apiVersion: '1', apiSignatures: { [await apiNameKeyOf('me')]: signature }, versionExpiredHandler,
            errorHandler: (err) => { errors.push(err); }, transport: refusedAsStale,
        });

        // The first ask returned with the page still here, so the second
        // caller's refusal is asked about in turn.
        const firstPage = await loadPageCallerClass();
        await (await bundleCaller(firstPage, 'build-1')).apiOutcome('me', {});
        await (await bundleCaller(firstPage, 'build-1')).apiOutcome('me', {});
        expect(versionExpiredHandler).toHaveBeenCalledTimes(2);
        expect(errors).toEqual([]);

        await (await bundleCaller(await loadPageCallerClass(), 'build-2')).apiOutcome('me', {});
        expect(versionExpiredHandler).toHaveBeenCalledTimes(3);
        expect(errors).toEqual([]);
    });

    it('counts a recorded call as a loop only when a load before this one recorded it, and then reports it once', async () => {
        const store = stubTabStorage();
        const versionExpiredHandler = vi.fn();
        const errorHandler = vi.fn();
        const page = new (await loadPageCallerClass())({ apiPath: '/api', apiVersion: '1', versionExpiredHandler, errorHandler, transport: refusedAsStale });
        const recordRefusal = (refusedAt: number) => store.set('lambder:version-expired', JSON.stringify({ at: refusedAt, confirmed: false, calls: [['me', '', '1', refusedAt]] }));

        // Recorded as this document loaded: this page's own, with no reload since.
        recordRefusal(pageLoadedAt);
        await page.apiOutcome('me', {});
        expect(versionExpiredHandler).toHaveBeenCalledOnce();
        expect(errorHandler).not.toHaveBeenCalled();

        // Recorded before it: the reload brought the same bundle back.
        recordRefusal(pageLoadedAt - 1);
        await page.apiOutcome('me', {});
        expect(versionExpiredHandler).toHaveBeenCalledOnce();
        expect(errorHandler).toHaveBeenCalledOnce();
        expect(errorHandler.mock.calls[0]![0]).toMatchObject({ message: expect.stringMatching(/^Version expired again for API "me"/) });
    });
});

describe('LambderCaller - CORS mode by default', () => {
    const fetchInitOf = async (options: { apiPath: string; isCorsEnabled?: boolean }) => {
        const fetchMock = stubFetch(async () => mockResponse({ apiVersion: '1', payload: null }));
        await new LambderCaller(options).apiOutcome('thing', {});
        return fetchMock.mock.calls[0]![1] as RequestInit;
    };

    it('sends credentialed cross-origin requests to an apiPath on another origin, with no option set', async () => {
        vi.stubGlobal('location', { href: 'https://app.example.com/', origin: 'https://app.example.com', hostname: 'app.example.com' });

        expect(await fetchInitOf({ apiPath: 'https://api.example.com/api' })).toMatchObject({ mode: 'cors', credentials: 'include' });
        expect(await fetchInitOf({ apiPath: '/api' })).toMatchObject({ mode: 'same-origin', credentials: 'same-origin' });
        // An explicit value still wins.
        expect(await fetchInitOf({ apiPath: 'https://api.example.com/api', isCorsEnabled: false })).toMatchObject({ mode: 'same-origin' });
        expect(await fetchInitOf({ apiPath: '/api', isCorsEnabled: true })).toMatchObject({ mode: 'cors', credentials: 'include' });
    });
});
