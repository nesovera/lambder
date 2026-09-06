/**
 * Response finalize pipeline: automatic gzip negotiation and ETag / If-None-Match conditional requests.
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../src/core/Lambder.js';
import { decodeBody, gunzipBody, createMockEvent, createMockContext } from './helpers.js';
describe('Compression (gzip)', () => {
    const bigHtml = '<p>' + 'lambder '.repeat(500) + '</p>';

    it('gzips large compressible responses when the client accepts gzip', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/big', (ctx, res) => res.html(bigHtml));

        const result = await lambder.render(
            createMockEvent('/big', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip, deflate, br' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toEqual(['gzip']);
        expect(result.multiValueHeaders?.['Vary']).toContain('Accept-Encoding');
        expect(result.isBase64Encoded).toBe(true);
        expect(gunzipBody(result)).toBe(bigHtml);
    });

    it('does not gzip when the client does not accept gzip', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/big', (ctx, res) => res.html(bigHtml));

        const result = await lambder.render(createMockEvent('/big'), createMockContext());

        expect(result.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
        expect(decodeBody(result)).toBe(bigHtml);
    });

    it('does not gzip small responses in auto mode', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/small', (ctx, res) => res.html('<p>small</p>'));

        const result = await lambder.render(
            createMockEvent('/small', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
        expect(decodeBody(result)).toBe('<p>small</p>');
    });

    it('compress: true forces gzip even below the size threshold', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/forced', (ctx, res) => res.xml('<x/>', { compress: true }));

        const result = await lambder.render(
            createMockEvent('/forced', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toEqual(['gzip']);
        expect(gunzipBody(result)).toBe('<x/>');
    });

    it('compress: false opts out entirely', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/opt-out', (ctx, res) => res.html(bigHtml, { compress: false }));

        const result = await lambder.render(
            createMockEvent('/opt-out', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
    });

    it('compression: false disables auto gzip globally', async () => {
        const lambder = new Lambder({ publicPath: './public', compression: false })
            .addRoute('/big', (ctx, res) => res.html(bigHtml));

        const result = await lambder.render(
            createMockEvent('/big', { headers: { Host: 'localhost', 'Accept-Encoding': 'gzip' } }),
            createMockContext(),
        );

        expect(result.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
    });

    it('apiBinary responses are gzipped for accepting clients', async () => {
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
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
        const lambder = new Lambder({ publicPath: './public' })
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
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/submit', (ctx, res) => res.html('ok'));

        const result = await lambder.render(
            createMockEvent('/submit', { httpMethod: 'POST' }),
            createMockContext(),
        );
        expect(result.multiValueHeaders?.['ETag']).toBeUndefined();
    });

    it('etag: false disables the ETag per response', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/page', (ctx, res) => res.html('x', { etag: false }));

        const result = await lambder.render(createMockEvent('/page'), createMockContext());
        expect(result.multiValueHeaders?.['ETag']).toBeUndefined();
    });
});

