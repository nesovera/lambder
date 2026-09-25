/**
 * Headers written while a call runs (res.setHeader, res.addHeader, the
 * session controller's Set-Cookie) belong to the CALL, not to the response
 * that first carried them. An afterRender hook may answer with a different
 * response than the handler produced, and they have to travel across to it:
 * a login API whose session cookie is dropped on the way out logs nobody in,
 * writes its session record anyway, and reports no error.
 *
 * These pin it for APIs and routes alike, on the success path, the refusal
 * path and the hook-throws path.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import Lambder from '../src/core/Lambder.js';
import type LambderResolver from '../src/core/LambderResolver.js';
import type { LambderRenderContext } from '../src/core/LambderContext.js';
import type { LambderResponse } from '../src/core/LambderResponse.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import { refuse } from '../src/shared/wire/LambderApiRefusal.js';
import { decodeBody, createMockEvent, createApiEvent, createMockContext, testPublicFiles } from './helpers.js';

const files = () => testPublicFiles();

const app = () => new Lambder({
    files: files(),
    apiPath: '/api',
    session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt', tokenCookieKey: 'sid', csrfCookieKey: 'csid' },
});

const call = (lambder: Lambder<any, any>, apiName: string) =>
    lambder.render(createApiEvent({ apiName, payload: {} }), createMockContext());

describe('Headers written during a call', () => {
    it('survive an afterRender hook that answers with a different response', async () => {
        const lambder = app()
            .addApi('login', { input: z.any(), output: z.any() }, async (ctx, res) => {
                await lambder.getSessionController(ctx).createSession('user-1', { role: 'user' });
                res.setHeader('X-Handler', 'ran');
                return res.api({ ok: true });
            })
            .addHook('afterRender', (ctx, res) => res.json({ replaced: true }));

        const result = await call(lambder, 'login');

        expect(JSON.parse(decodeBody(result))).toEqual({ replaced: true });
        const cookies = result.multiValueHeaders?.['Set-Cookie'] ?? [];
        expect(cookies.length).toBe(2);
        expect(cookies[0]).toContain('sid=');
        expect(cookies[1]).toContain('csid=');
        expect(result.multiValueHeaders?.['X-Handler']).toEqual(['ran']);
    });

    it('survive an afterRender hook that throws a refusal over the answer', async () => {
        const lambder = app()
            .addApi('login', { input: z.any(), output: z.any() }, async (ctx, res) => {
                await lambder.getSessionController(ctx).createSession('user-1', { role: 'user' });
                return res.api({ ok: true });
            })
            .addHook('afterRender', () => refuse('Nope.', { code: 'app/nope' }));

        const result = await call(lambder, 'login');

        expect(JSON.parse(decodeBody(result)).errorMessage.code).toBe('app/nope');
        expect((result.multiValueHeaders?.['Set-Cookie'] ?? []).length).toBe(2);
    });

    it('are not doubled when the hooks leave the handler\'s own response in place', async () => {
        const lambder = app()
            .addApi('thing', { input: z.any(), output: z.any() }, async (ctx, res) => {
                res.addHeader('Set-Cookie', 'a=1; Path=/');
                res.addHeader('Set-Cookie', 'b=2; Path=/');
                res.setHeader('X-Once', 'yes');
                return res.api({ ok: true });
            })
            .addHook('afterRender', (ctx, res, response) => response);

        const result = await call(lambder, 'thing');

        expect(result.multiValueHeaders?.['Set-Cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/']);
        expect(result.multiValueHeaders?.['X-Once']).toEqual(['yes']);
    });

    it('let a hook overwrite what the handler set, because the hook wrote it later', async () => {
        const lambder = app()
            .addApi('thing', { input: z.any(), output: z.any() }, async (ctx, res) => {
                res.setHeader('X-Who', 'handler');
                return res.api({ ok: true });
            })
            .addHook('afterRender', (ctx, res, response) => { res.setHeader('X-Who', 'hook'); return response; });

        const result = await call(lambder, 'thing');

        expect(result.multiValueHeaders?.['X-Who']).toEqual(['hook']);
    });

    it('travel onto a replacement response on a route too, as they always have', async () => {
        const lambder = new Lambder({ files: files() })
            .addRoute('/page', (ctx, res) => { res.setHeader('X-Handler', 'ran'); return res.html('<p>hi</p>'); })
            .addHook('afterRender', (ctx, res) => res.json({ replaced: true }));

        const result = await lambder.render(createMockEvent('/page'), createMockContext());

        expect(JSON.parse(decodeBody(result))).toEqual({ replaced: true });
        expect(result.multiValueHeaders?.['X-Handler']).toEqual(['ran']);
    });

    it('survive a crash with NO global error handler, which is the default configuration', async () => {
        // The crash path must keep the call's headers without a
        // globalErrorHandler too, since that handler is not the default.
        // Otherwise an app that just throws writes its session record and
        // sends the browser nothing (signed in on the server, signed out in
        // the browser), and a cross-origin caller cannot read the error
        // because the CORS headers go with them.
        const lambder = new Lambder({
            files: files(),
            apiPath: '/api',
            cors: { origins: ['https://site.example'] },
            session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt', tokenCookieKey: 'sid', csrfCookieKey: 'csid' },
        }).addApi('login', { input: z.any(), output: z.any() }, async (ctx, res) => {
            await lambder.getSessionController(ctx).createSession('user-1', { role: 'user' });
            res.setHeader('X-Handler', 'ran');
            throw new Error('after the session was written');
        });

        const result = await lambder.render(
            createApiEvent({ apiName: 'login', payload: {} }, { headers: { Origin: 'https://site.example' } }),
            createMockContext(),
        );

        expect(result.statusCode).toBe(500);
        expect((result.multiValueHeaders?.['Set-Cookie'] ?? []).length).toBe(2);
        expect(result.multiValueHeaders?.['X-Handler']).toEqual(['ran']);
        expect(result.multiValueHeaders?.['Access-Control-Allow-Origin']).toEqual(['https://site.example']);
        // Still the structured crash envelope a client can parse.
        expect(JSON.parse(decodeBody(result)).errorMessage).toEqual({ type: 'error', content: 'Internal server error.' });
    });
});

/**
 * The call's headers go onto the response BEFORE the afterRender hooks run,
 * so a hook is the last writer. Replaying them afterwards would put the
 * handler's value straight back: a hook could neither override a header nor
 * delete one, and the deletion would look like it worked right up to the wire.
 */
describe('An afterRender hook and the headers the handler wrote', () => {
    type AfterRenderHook = (ctx: LambderRenderContext, res: LambderResolver, response: LambderResponse) => LambderResponse;
    const pageWith = (hook: AfterRenderHook) => new Lambder({ files: files() })
        .addRoute('/page', (ctx, res) => {
            res.setHeader('X-Owner', 'handler');
            res.setCookie('sid', 'from-handler', { path: '/' });
            return res.html('page');
        })
        .addHook('afterRender', hook);

    it('lets the hook override one', async () => {
        const lambder = pageWith((ctx, res, response) => {
            response.setHeader('X-Owner', 'hook');
            return response;
        });

        const result = await lambder.render(createMockEvent('/page'), createMockContext());
        expect(result.multiValueHeaders?.['X-Owner']).toEqual(['hook']);
    });

    it('lets the hook delete one', async () => {
        const lambder = pageWith((ctx, res, response) => {
            for(const key of Object.keys(response.headers)){
                if(key.toLowerCase() === 'x-owner') delete response.headers[key];
            }
            return response;
        });

        const result = await lambder.render(createMockEvent('/page'), createMockContext());
        expect(result.multiValueHeaders?.['X-Owner']).toBeUndefined();
        // The rest of the call's headers are untouched by the deletion.
        expect(result.multiValueHeaders?.['Set-Cookie']?.[0]).toContain('sid=from-handler');
    });

    it('still applies what the hook itself wrote through res', async () => {
        const lambder = pageWith((ctx, res, response) => {
            res.setHeader('X-Hook', 'wrote-this');
            return response;
        });

        const result = await lambder.render(createMockEvent('/page'), createMockContext());
        expect(result.multiValueHeaders?.['X-Hook']).toEqual(['wrote-this']);
        expect(result.multiValueHeaders?.['X-Owner']).toEqual(['handler']);
    });
});
