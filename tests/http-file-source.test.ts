/**
 * LambderHttpFileSource: public files over HTTP(S) from any origin serving
 * them by path (a CDN, an R2 custom domain), against a real local server.
 *
 * - URLs are baseUrl + the relative path, each segment percent-encoded; the
 *   response's Content-Type is used unless it is a generic octet-stream.
 * - A 404 or 410 reads as null (the request falls through); other failed
 *   statuses and timeouts propagate.
 * - As the files option it serves index.html from the origin too, fetched
 *   once per instance.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeBody } from './helpers.js';
import Lambder from '../src/core/Lambder.js';
import { LambderHttpFileSource } from '../src/stores/LambderHttpFileSource.js';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';

const originFiles: Record<string, { status: number; type?: string; body?: string }> = {
    '/v42/app.css': { status: 200, type: 'text/css', body: 'body {}' },
    '/v42/app.js': { status: 200, type: 'application/octet-stream', body: 'x' },
    '/v42/plain.js': { status: 200, body: 'x' },
    '/v42/index.html': { status: 200, type: 'text/html', body: '<h1>shell</h1>' },
    '/v42/gone.js': { status: 410 },
    '/v42/denied.js': { status: 403 },
    '/v42/broken.js': { status: 500 },
};

const requests: { url: string; headers: http.IncomingHttpHeaders }[] = [];
const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', headers: req.headers });
    if(req.url === '/v42/slow.js') return; // never answers: the timeout case
    const file = originFiles[req.url ?? ''];
    res.writeHead(file?.status ?? 404, file?.type ? { 'Content-Type': file.type } : {});
    res.end(file?.body ?? '');
});
let origin = '';

beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => { requests.length = 0; });

const event = (requestPath: string): APIGatewayProxyEvent => ({
    body: null, headers: { Host: 'localhost' }, multiValueHeaders: {}, httpMethod: 'GET', isBase64Encoded: false,
    path: requestPath, pathParameters: null, queryStringParameters: null, multiValueQueryStringParameters: null,
    stageVariables: null, requestContext: {} as any, resource: '',
});

describe('LambderHttpFileSource', () => {
    it('reads baseUrl + relative path and uses the response Content-Type', async () => {
        const file = await new LambderHttpFileSource({ baseUrl: `${origin}/v42/` }).read('app.css');

        expect(file?.body.toString('utf8')).toBe('body {}');
        expect(file?.mimeType).toBe('text/css');
        expect(requests.map((request) => request.url)).toEqual(['/v42/app.css']);
    });

    it('treats baseUrl as a folder whether or not it ends in a slash', async () => {
        const file = await new LambderHttpFileSource({ baseUrl: `${origin}/v42` }).read('app.css');
        expect(file?.body.toString('utf8')).toBe('body {}');
        expect(requests.map((request) => request.url)).toEqual(['/v42/app.css']);
    });

    it('percent-encodes each path segment, so a path names the same object as an S3 key would', async () => {
        await new LambderHttpFileSource({ baseUrl: `${origin}/v42/` }).read('a b/c+d@e#f?.png');
        expect(requests.map((request) => request.url)).toEqual(['/v42/a%20b/c%2Bd%40e%23f%3F.png']);
    });

    it('leaves the mime type to the extension when the response is untyped or a generic octet-stream', async () => {
        const source = new LambderHttpFileSource({ baseUrl: `${origin}/v42/` });
        expect((await source.read('app.js'))?.mimeType).toBeUndefined();
        expect((await source.read('plain.js'))?.mimeType).toBeUndefined();
    });

    it('a 404 or 410 reads as null; other failed statuses and timeouts propagate', async () => {
        const source = new LambderHttpFileSource({ baseUrl: `${origin}/v42/` });

        await expect(source.read('missing.js')).resolves.toBeNull();
        await expect(source.read('gone.js')).resolves.toBeNull();
        await expect(source.read('denied.js')).rejects.toThrow('403');
        await expect(source.read('broken.js')).rejects.toThrow('500');
        await expect(new LambderHttpFileSource({ baseUrl: `${origin}/v42/`, timeoutMs: 50 }).read('slow.js')).rejects.toThrow();
    });

    it('sends the configured headers with every read', async () => {
        await new LambderHttpFileSource({ baseUrl: `${origin}/v42/`, headers: { 'X-Origin-Key': 'k1' } }).read('app.css');
        expect(requests[0]?.headers['x-origin-key']).toBe('k1');
    });

    it('refuses a baseUrl that is not an absolute http(s) URL', () => {
        expect(() => new LambderHttpFileSource({ baseUrl: '' })).toThrow('absolute http(s) URL');
        expect(() => new LambderHttpFileSource({ baseUrl: '/v42/' })).toThrow('absolute http(s) URL');
        expect(() => new LambderHttpFileSource({ baseUrl: 'ftp://assets.example.com/v42/' })).toThrow('absolute http(s) URL');
    });

    it('as the files option, serves public files and the index fallback from the origin, fetching index.html once', async () => {
        const handler = new Lambder({ files: new LambderHttpFileSource({ baseUrl: `${origin}/v42/` }), apiPath: '/api' })
            .servePublicFiles()
            .serveIndexHtml()
            .getHandler();
        const context = {} as Context;

        const css = await handler(event('/app.css'), context);
        expect(css.statusCode).toBe(200);
        expect(css.multiValueHeaders?.['Content-Type']).toContain('text/css');
        expect(decodeBody(css)).toBe('body {}');

        for(const page of ['/about', '/pricing']){
            const shell = await handler(event(page), context);
            expect(shell.statusCode).toBe(200);
            expect(decodeBody(shell)).toBe('<h1>shell</h1>');
        }
        expect(requests.filter((request) => request.url === '/v42/index.html').length).toBe(1);
    });

    it('a missing file falls through to the route fallback', async () => {
        const handler = new Lambder({ files: new LambderHttpFileSource({ baseUrl: `${origin}/v42/` }), apiPath: '/api' })
            .servePublicFiles()
            .setRouteFallbackHandler((ctx, res) => res.text('fallback', { statusCode: 404 }))
            .getHandler();

        const missing = await handler(event('/missing.js'), {} as Context);
        expect(missing.statusCode).toBe(404);
        expect(decodeBody(missing)).toBe('fallback');
    });
});
