/**
 * LambderCaller: outcome semantics, per-call handler overrides, timeout.
 *
 * - apiOutcome() resolves to a discriminated { ok } union and never throws.
 * - api()/apiRaw() keep their legacy null-collapsing shape.
 * - Per-call handlers override the constructor handlers.
 * - timeoutMs aborts the fetch and reports reason 'timeout'.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import LambderCaller from '../src/LambderCaller.js';

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
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
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

    it('errorMessage envelope: reason errorMessage, handler called, apiRaw keeps the envelope', async () => {
        stubFetch(async () => mockResponse({ apiVersion: '1', payload: null, errorMessage: { type: 'warning', content: 'Denied.' } }));
        const errorMessageHandler = vi.fn();
        const caller = new LambderCaller({ apiPath: '/api', isCorsEnabled: false, errorMessageHandler });

        const outcome = await caller.apiOutcome('doThing', {});
        expect(outcome).toMatchObject({ ok: false, reason: 'errorMessage', errorMessage: { type: 'warning', content: 'Denied.' } });
        expect(errorMessageHandler).toHaveBeenCalledWith({ type: 'warning', content: 'Denied.' });

        const raw = await caller.apiRaw('doThing', {});
        expect(raw?.errorMessage).toEqual({ type: 'warning', content: 'Denied.' });
        expect(await caller.api('doThing', {})).toBe(null);
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
        expect(outcome).toMatchObject({ ok: false, reason: 'notAuthorized', errorMessage: 'Permission denied.' });
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
        expect(outcome).toMatchObject({ ok: false, reason: 'server', status: 500, errorMessage: 'Internal server error.' });
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

describe('LambderCaller - createIdempotencyKey', () => {
    const V4_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    it('produces unique v4-shaped keys', () => {
        const a = LambderCaller.createIdempotencyKey();
        const b = LambderCaller.createIdempotencyKey();
        expect(a).toMatch(V4_SHAPE);
        expect(b).toMatch(V4_SHAPE);
        expect(a).not.toBe(b);
    });

    it('falls back to getRandomValues when randomUUID is unavailable (insecure contexts)', () => {
        const realCrypto = globalThis.crypto;
        vi.stubGlobal('crypto', { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
        const key = LambderCaller.createIdempotencyKey();
        expect(key).toMatch(V4_SHAPE);
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
        expect(perCallHandler).toHaveBeenCalledWith('Denied.');
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
        if(!outcome.ok) expect(outcome.error?.message).toBe('handler bug');
    });
});
