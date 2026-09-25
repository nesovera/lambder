/**
 * Response finalize pipeline: automatic Brotli/gzip negotiation and ETag /
 * If-None-Match conditional requests.
 */

import { describe, it, expect, vi } from 'vitest';
import { brotliDecompressSync } from 'node:zlib';
import { z } from 'zod';
import Lambder, { initLambder } from '../src/core/Lambder.js';
import { decodeBody, gunzipBody, brotliBody, createMockEvent, createMockEventV2, createApiEvent, createMockContext, testPublicFiles } from './helpers.js';
describe('Compression (Brotli / gzip)', () => {
    const bigHtml = '<p>' + 'lambder '.repeat(500) + '</p>';

    // These events are a REST API's (v1), where compression is on only when named.
    const serveBig = (options?: ConstructorParameters<typeof Lambder>[0]) =>
        new Lambder({ files: testPublicFiles(), compression: true, ...options })
            .addRoute('/big', (ctx, res) => res.html(bigHtml));

    it('prefers Brotli when the client accepts it', async () => {
        const result = await serveBig().render(
            createMockEvent('/big', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip, deflate, br' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toEqual(['br']);
        expect(result.multiValueHeaders?.['Vary']).toContain('Accept-Encoding');
        expect(result.isBase64Encoded).toBe(true);
        expect(brotliBody(result)).toBe(bigHtml);
    });

    it('falls back to gzip for a client that does not accept Brotli', async () => {
        const result = await serveBig().render(
            createMockEvent('/big', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip, deflate' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toEqual(['gzip']);
        expect(gunzipBody(result)).toBe(bigHtml);
    });

    it('respects an encodings preference that excludes Brotli', async () => {
        const result = await serveBig({ compression: { encodings: ['gzip'] } }).render(
            createMockEvent('/big', { headers: { Host: 'localhost', 'Accept-Encoding': 'br, gzip' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toEqual(['gzip']);
        expect(gunzipBody(result)).toBe(bigHtml);
    });

    it('skips an encoding the client refused with q=0', async () => {
        const result = await serveBig().render(
            createMockEvent('/big', { headers: { Host: 'localhost', 'Accept-Encoding': 'br;q=0, gzip' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toEqual(['gzip']);
    });

    it('Brotli beats gzip on the same body', async () => {
        const [brotli, gzip] = await Promise.all([
            serveBig().render(createMockEvent('/big', { headers: { Host: 'localhost', 'Accept-Encoding': 'br' } }), createMockContext()),
            serveBig().render(createMockEvent('/big', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }), createMockContext()),
        ]);

        expect(brotli.body!.length).toBeLessThan(gzip.body!.length);
    });

    it('rejects a nonsense compression option at construction', () => {
        // The same validation the at-rest stores get, from the same resolver.
        expect(() => serveBig({ compression: { minBytes: -50 } })).toThrow(/non-negative integer/);
        expect(() => serveBig({ compression: { quality: 99 } })).toThrow(/0 to 11/);
        // An empty preference list would add Vary and never compress, silently.
        expect(() => serveBig({ compression: { encodings: [] } })).toThrow(/non-empty list/);
    });

    it('keeps the defaults for a field set to undefined', async () => {
        // A quality of undefined must not reach Brotli on the first large response.
        const result = await serveBig({ compression: { minBytes: undefined, quality: undefined } }).render(
            createMockEvent('/big', { headers: { Host: 'localhost', 'Accept-Encoding': 'br' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toEqual(['br']);
        expect(brotliBody(result)).toBe(bigHtml);
    });

    it('honours a custom quality', async () => {
        const result = await serveBig({ compression: { quality: 11 } }).render(
            createMockEvent('/big', { headers: { Host: 'localhost', 'Accept-Encoding': 'br' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toEqual(['br']);
        expect(brotliBody(result)).toBe(bigHtml);
    });

    it('does not gzip when the client does not accept gzip', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute('/big', (ctx, res) => res.html(bigHtml));

        const result = await lambder.render(createMockEvent('/big'), createMockContext());

        expect(result.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
        expect(decodeBody(result)).toBe(bigHtml);
    });

    it('does not gzip small responses in auto mode', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute('/small', (ctx, res) => res.html('<p>small</p>'));

        const result = await lambder.render(
            createMockEvent('/small', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
        expect(decodeBody(result)).toBe('<p>small</p>');
    });

    it('compress: true forces gzip even below the size threshold', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute('/forced', (ctx, res) => res.xml('<x/>', { compress: true }));

        const result = await lambder.render(
            createMockEvent('/forced', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toEqual(['gzip']);
        expect(gunzipBody(result)).toBe('<x/>');
    });

    it('compress: false opts out entirely', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute('/opt-out', (ctx, res) => res.html(bigHtml, { compress: false }));

        const result = await lambder.render(
            createMockEvent('/opt-out', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
    });

    it('compression: false disables auto gzip globally', async () => {
        const lambder = new Lambder({ files: testPublicFiles(), compression: false })
            .addRoute('/big', (ctx, res) => res.html(bigHtml));

        const result = await lambder.render(
            createMockEvent('/big', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
    });

    it('apiBinary responses are gzipped for accepting clients', async () => {
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addRoute('/bin', (ctx, res) => res.apiBinary({ ok: true }));

        const result = await lambder.render(
            createMockEvent('/bin', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toEqual(['gzip']);
        expect(JSON.parse(gunzipBody(result)).payload).toEqual({ ok: true });
    });
});

describe('ETag / conditional requests', () => {
    it('sets an ETag on GET 200 responses and answers If-None-Match with 304', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute('/page', (ctx, res) => res.html('<p>etag me</p>'));

        const first = await lambder.render(createMockEvent('/page'), createMockContext());
        const etag = first.multiValueHeaders?.['ETag']?.[0];
        expect(etag).toMatch(/^".+"$/);

        const second = await lambder.render(
            createMockEvent('/page', { headers: { Host: 'localhost', 'If-None-Match': etag! } }),
            createMockContext(),
        );
        expect(second.statusCode).toBe(304);
        expect(second.body).toBe('');
        expect(second.multiValueHeaders?.['ETag']).toEqual([etag]);
        // No body, so nothing that describes one.
        expect(second.multiValueHeaders?.['Content-Type']).toBeUndefined();
    });

    /**
     * A 304 is the same call as the 200 it stands in for, so it keeps the
     * call's headers, not only the cache ones. Otherwise a cacheable GET that
     * also slides the session cookie stops refreshing it once the browser
     * holds the ETag, and a cross-origin revalidation loses
     * Access-Control-Allow-Origin, so the browser refuses the answer it asked
     * for.
     */
    it('carries Set-Cookie, the call\'s headers and CORS onto the 304', async () => {
        const lambder = initLambder().create({
            files: testPublicFiles(),
            cors: { origins: ['https://app.example.com'], credentials: true },
        }).addRoute('/page', (ctx, res) => {
            res.setCookie('LMDRSESSIONTKID', 'slid', { path: '/' });
            res.setHeader('X-Request-Id', 'abc');
            return res.html('<p>etag me</p>', { cacheControl: 'private, max-age=0, must-revalidate' });
        });

        const headers = { Host: 'localhost', Origin: 'https://app.example.com' };
        const first = await lambder.render(createMockEvent('/page', { headers }), createMockContext());
        const etag = first.multiValueHeaders?.['ETag']?.[0];
        expect(first.multiValueHeaders?.['Set-Cookie']?.[0]).toContain('LMDRSESSIONTKID=slid');

        const second = await lambder.render(
            createMockEvent('/page', { headers: { ...headers, 'If-None-Match': etag! } }),
            createMockContext(),
        );

        expect(second.statusCode).toBe(304);
        expect(second.multiValueHeaders?.['Set-Cookie']?.[0]).toContain('LMDRSESSIONTKID=slid');
        expect(second.multiValueHeaders?.['X-Request-Id']).toEqual(['abc']);
        expect(second.multiValueHeaders?.['Access-Control-Allow-Origin']).toEqual(['https://app.example.com']);
        expect(second.multiValueHeaders?.['Access-Control-Allow-Credentials']).toEqual(['true']);
        expect(second.multiValueHeaders?.['Vary']).toContain('Origin');
        expect(second.multiValueHeaders?.['Cache-Control']).toEqual(['private, max-age=0, must-revalidate']);
    });

    it('keeps an answer that sets a cookie out of shared caches in both gateway formats, the crash path included', async () => {
        const lambder = initLambder().create({ files: testPublicFiles() })
            .addRoute('/shared', (ctx, res) => {
                res.setCookie('guest', 'visitor-1', { path: '/' });
                return res.html('<p>hi</p>', { cacheControl: 'public, max-age=600, s-maxage=86400, stale-while-revalidate=30' });
            })
            .addRoute('/unsaid', (ctx, res) => {
                res.setCookie('guest', 'visitor-1', { path: '/' });
                return res.html('<p>hi</p>');
            })
            .addRoute('/stored-nowhere', (ctx, res) => {
                res.setCookie('guest', 'visitor-1', { path: '/' });
                return res.html('<p>hi</p>', { cacheControl: 'no-store' });
            })
            .addRoute('/broken', (ctx, res) => {
                res.setCookie('guest', 'visitor-1', { path: '/' });
                res.setHeader('Cache-Control', 'public, max-age=60');
                throw new Error('the page broke');
            });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const v1 = await lambder.render(createMockEvent('/shared'), createMockContext());
            expect(v1.multiValueHeaders?.['Cache-Control']).toEqual(['private, max-age=600, stale-while-revalidate=30']);

            const v2 = await lambder.render(createMockEventV2('/shared'), createMockContext());
            expect(v2.cookies?.[0]).toContain('guest=visitor-1');
            expect(v2.headers?.['Cache-Control']).toBe('private, max-age=600, stale-while-revalidate=30');

            // Nothing said about caching, or already kept out of every cache: left as it is.
            expect((await lambder.render(createMockEvent('/unsaid'), createMockContext())).multiValueHeaders?.['Cache-Control']).toBeUndefined();
            expect((await lambder.render(createMockEvent('/stored-nowhere'), createMockContext())).multiValueHeaders?.['Cache-Control']).toEqual(['no-store']);

            const crashed = await lambder.render(createMockEvent('/broken'), createMockContext());
            expect(crashed.statusCode).toBe(500);
            expect(crashed.multiValueHeaders?.['Cache-Control']).toEqual(['private, max-age=60']);
        } finally {
            error.mockRestore();
        }
    });

    it('does not set ETags on POST responses', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute('/submit', (ctx, res) => res.html('ok'));

        const result = await lambder.render(
            createMockEvent('/submit', { httpMethod: 'POST' }),
            createMockContext(),
        );
        expect(result.multiValueHeaders?.['ETag']).toBeUndefined();
    });

    it('etag: false disables the ETag per response', async () => {
        const lambder = new Lambder({ files: testPublicFiles() })
            .addRoute('/page', (ctx, res) => res.html('x', { etag: false }));

        const result = await lambder.render(createMockEvent('/page'), createMockContext());
        expect(result.multiValueHeaders?.['ETag']).toBeUndefined();
    });
});


/**
 * An API handler's binary body reaches finalization as the Buffer the handler
 * returned, not as the base64 the core carries it in. The base64 hop exists
 * so the idempotency store can persist an answer as plain data; letting it
 * reach the wire would ship a third more bytes, uncompressed, and a body near
 * the Lambda response cap would cross it.
 */
describe('Binary bodies from an API handler', () => {
    const wasm = Buffer.from('lambder '.repeat(500), 'utf8');

    const binaryApp = () => new Lambder({ files: testPublicFiles(), apiPath: '/api' })
        .addApi('download', { input: z.any(), output: z.any() }, (ctx, res) => res.raw({
            statusCode: 200,
            headers: { 'Content-Type': 'application/wasm' },
            body: wasm,
            compress: true,
        }))
        .addRoute('/download', (ctx, res) => res.raw({
            statusCode: 200,
            headers: { 'Content-Type': 'application/wasm' },
            body: wasm,
            compress: true,
        }));

    const accepting = { Host: 'localhost', 'Accept-Encoding': 'br, gzip' };

    it('compresses, exactly as the same body returned from a route does', async () => {
        const fromApi = await binaryApp().render(
            createApiEvent({ apiName: 'download', payload: {} }, { headers: accepting }),
            createMockContext(),
        );
        const fromRoute = await binaryApp().render(
            createMockEvent('/download', { headers: accepting }),
            createMockContext(),
        );

        expect(fromApi.multiValueHeaders?.['Content-Encoding']).toEqual(['br']);
        expect(fromRoute.multiValueHeaders?.['Content-Encoding']).toEqual(['br']);
        expect(fromApi.body).toBe(fromRoute.body);
        expect(brotliDecompressSync(Buffer.from(fromApi.body || '', 'base64'))).toEqual(wasm);
        // The point of it: the encoded body is far smaller than the base64 of
        // the raw bytes.
        expect((fromApi.body || '').length).toBeLessThan(wasm.toString('base64').length / 4);
    });

    it('still passes a body the handler pre-encoded through untouched', async () => {
        const preEncoded = wasm.toString('base64');
        const lambder = new Lambder({ files: testPublicFiles(), apiPath: '/api' })
            .addApi('download', { input: z.any(), output: z.any() }, (ctx, res) => res.raw({
                statusCode: 200,
                headers: { 'Content-Type': 'application/wasm' },
                body: preEncoded,
                isBase64Encoded: true,
            }));

        const result = await lambder.render(
            createApiEvent({ apiName: 'download', payload: {} }, { headers: accepting }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
        expect(result.isBase64Encoded).toBe(true);
        expect(result.body).toBe(preEncoded);
    });
});

describe('The response size guard', () => {
    /**
     * maxResponseBytes stands in for Lambda's ~6MB cap, and the cap is in
     * bytes. String.length counts UTF-16 code units, so an uncompressed
     * non-ASCII answer up to three times over would pass, and Lambda would
     * refuse the invocation with an opaque payload-size error and no
     * envelope, the outcome the guard exists to replace.
     */
    const serve = (body: string) => new Lambder({ files: testPublicFiles(), apiPath: '/api', compression: false, maxResponseBytes: 1000 })
        .addRoute('/page', (ctx, res) => res.text(body))
        .setGlobalErrorHandler((err, ctx, res) => res.text(err.message, { statusCode: 500 }));

    it('measures the body in bytes, and reports bytes', async () => {
        const underBoth = await serve('a'.repeat(900)).render(createMockEvent('/page'), createMockContext());
        expect(underBoth.statusCode).toBe(200);

        // 900 characters, 2700 bytes: under the character cap, well over the byte cap.
        const overInBytes = await serve('字'.repeat(900)).render(createMockEvent('/page'), createMockContext());
        expect(overInBytes.statusCode).toBe(500);
        expect(decodeBody(overInBytes)).toContain('2700 bytes');
        expect(decodeBody(overInBytes)).toContain('maxResponseBytes (1000)');
    });
});
