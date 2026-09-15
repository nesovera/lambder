/**
 * Response finalize pipeline: automatic Brotli/gzip negotiation and ETag /
 * If-None-Match conditional requests.
 */

import { describe, it, expect } from 'vitest';
import { brotliDecompressSync } from 'node:zlib';
import { z } from 'zod';
import Lambder, { initLambder } from '../src/core/Lambder.js';
import { decodeBody, gunzipBody, brotliBody, createMockEvent, createApiEvent, createMockContext, testPublicFiles } from './helpers.js';
describe('Compression (Brotli / gzip)', () => {
    const bigHtml = '<p>' + 'lambder '.repeat(500) + '</p>';

    const serveBig = (options?: ConstructorParameters<typeof Lambder>[0]) =>
        new Lambder({ files: testPublicFiles(), ...options })
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
     * A 304 is the same call as the 200 it stands in for. Preserving five
     * cache headers and dropping everything else made revalidation the one
     * exit of render() where that stopped being true: a cacheable GET that
     * also slid the session cookie stopped refreshing it as soon as the
     * browser held the ETag, and a cross-origin revalidation lost
     * Access-Control-Allow-Origin, so the browser refused the answer it had
     * asked for.
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
        // The point of the fix: the encoded body is far smaller than the
        // base64 of the raw bytes would have been.
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
     * bytes. Measuring the finished body with String.length counted UTF-16
     * code units, so an uncompressed non-ASCII answer passed a guard it was
     * up to three times over, and Lambda then refused the invocation with an
     * opaque payload-size error and no envelope, which is the outcome the
     * guard exists to replace.
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
