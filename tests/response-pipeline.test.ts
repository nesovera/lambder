/**
 * Response finalize pipeline: automatic Brotli/gzip negotiation and ETag /
 * If-None-Match conditional requests.
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../src/core/Lambder.js';
import { LambderLocalFileSource } from '../src/core/LambderFiles.js';
import { decodeBody, gunzipBody, brotliBody, createMockEvent, createMockContext } from './helpers.js';
describe('Compression (Brotli / gzip)', () => {
    const bigHtml = '<p>' + 'lambder '.repeat(500) + '</p>';

    const serveBig = (options?: ConstructorParameters<typeof Lambder>[0]) =>
        new Lambder({ files: new LambderLocalFileSource({ root: './public' }), ...options })
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
        const lambder = new Lambder({ files: new LambderLocalFileSource({ root: './public' }) })
            .addRoute('/big', (ctx, res) => res.html(bigHtml));

        const result = await lambder.render(createMockEvent('/big'), createMockContext());

        expect(result.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
        expect(decodeBody(result)).toBe(bigHtml);
    });

    it('does not gzip small responses in auto mode', async () => {
        const lambder = new Lambder({ files: new LambderLocalFileSource({ root: './public' }) })
            .addRoute('/small', (ctx, res) => res.html('<p>small</p>'));

        const result = await lambder.render(
            createMockEvent('/small', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
        expect(decodeBody(result)).toBe('<p>small</p>');
    });

    it('compress: true forces gzip even below the size threshold', async () => {
        const lambder = new Lambder({ files: new LambderLocalFileSource({ root: './public' }) })
            .addRoute('/forced', (ctx, res) => res.xml('<x/>', { compress: true }));

        const result = await lambder.render(
            createMockEvent('/forced', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toEqual(['gzip']);
        expect(gunzipBody(result)).toBe('<x/>');
    });

    it('compress: false opts out entirely', async () => {
        const lambder = new Lambder({ files: new LambderLocalFileSource({ root: './public' }) })
            .addRoute('/opt-out', (ctx, res) => res.html(bigHtml, { compress: false }));

        const result = await lambder.render(
            createMockEvent('/opt-out', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
    });

    it('compression: false disables auto gzip globally', async () => {
        const lambder = new Lambder({ files: new LambderLocalFileSource({ root: './public' }), compression: false })
            .addRoute('/big', (ctx, res) => res.html(bigHtml));

        const result = await lambder.render(
            createMockEvent('/big', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
    });

    it('apiBinary responses are gzipped for accepting clients', async () => {
        const lambder = new Lambder({ files: new LambderLocalFileSource({ root: './public' }), apiPath: '/api' })
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
        const lambder = new Lambder({ files: new LambderLocalFileSource({ root: './public' }) })
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
    });

    it('does not set ETags on POST responses', async () => {
        const lambder = new Lambder({ files: new LambderLocalFileSource({ root: './public' }) })
            .addRoute('/submit', (ctx, res) => res.html('ok'));

        const result = await lambder.render(
            createMockEvent('/submit', { httpMethod: 'POST' }),
            createMockContext(),
        );
        expect(result.multiValueHeaders?.['ETag']).toBeUndefined();
    });

    it('etag: false disables the ETag per response', async () => {
        const lambder = new Lambder({ files: new LambderLocalFileSource({ root: './public' }) })
            .addRoute('/page', (ctx, res) => res.html('x', { etag: false }));

        const result = await lambder.render(createMockEvent('/page'), createMockContext());
        expect(result.multiValueHeaders?.['ETag']).toBeUndefined();
    });
});

