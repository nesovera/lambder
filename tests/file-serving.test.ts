/**
 * Serving files: the reader over the configured source (the path rule, the
 * memory cache, the mime fallback), the servePublicFiles slot over it, and
 * res.file / res.templateFile beside it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { decodeBody } from './helpers.js';
import { vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import Lambder from '../src/core/Lambder.js';
import { LambderFiles } from '../src/core/LambderFiles.js';
import { LambderLocalFileSource } from '../src/stores/LambderLocalFileSource.js';
import { LambderS3FileSource } from '../src/stores/LambderS3FileSource.js';
import { LambderHttpFileSource } from '../src/stores/LambderHttpFileSource.js';
import type { LambderFileSource } from '../src/shared/contracts/LambderFileSource.js';
import type { LambderFilesOption } from '../src/core/LambderFiles.js';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import path from 'path';

const createMockEvent = (path: string, method: string = 'GET'): APIGatewayProxyEvent => ({
    body: null,
    headers: {
        Host: 'localhost',
    },
    multiValueHeaders: {},
    httpMethod: method,
    isBase64Encoded: false,
    path,
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
});

const createMockContext = (): Context => ({
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'test',
    functionVersion: '1',
    invokedFunctionArn: 'arn',
    memoryLimitInMB: '128',
    awsRequestId: '123',
    logGroupName: 'group',
    logStreamName: 'stream',
    getRemainingTimeInMillis: () => 1000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
});

describe('File Serving with Fallback', () => {
    it('should serve main.css when it exists, NOT index.html', async () => {
        const lambder = new Lambder({
            files: new LambderLocalFileSource({ root: path.resolve('./tests/fixtures/public') }),
            apiPath: '/api'
        })
            .addRoute('/(.*)', async (ctx, res) => {
                const file = await res.file(ctx.path);
                return file.statusCode === 404 ? res.file('index.html') : file;
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/main.css');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(200);

        expect(result.multiValueHeaders?.['Content-Type']).toContain('text/css; charset=utf-8');

        const body = decodeBody(result);
        expect(body).toContain('body { margin: 0; }');
        expect(body).not.toContain('<h1>Test HTML</h1>');
    });

    it('should serve index.html when requested file does not exist', async () => {
        const lambder = new Lambder({
            files: new LambderLocalFileSource({ root: path.resolve('./tests/fixtures/public') }),
            apiPath: '/api'
        })
            .addRoute('/(.*)', async (ctx, res) => {
                const file = await res.file(ctx.path);
                return file.statusCode === 404 ? res.file('index.html') : file;
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/non-existent-file.js');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(200);

        expect(result.multiValueHeaders?.['Content-Type']).toContain('text/html; charset=utf-8');

        const body = decodeBody(result);
        expect(body).toContain('<h1>Test HTML</h1>');
    });

    it('should serve index.html when requested directly', async () => {
        const lambder = new Lambder({
            files: new LambderLocalFileSource({ root: path.resolve('./tests/fixtures/public') }),
            apiPath: '/api'
        })
            .addRoute('/(.*)', async (ctx, res) => {
                const file = await res.file(ctx.path);
                return file.statusCode === 404 ? res.file('index.html') : file;
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/index.html');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(200);

        expect(result.multiValueHeaders?.['Content-Type']).toContain('text/html; charset=utf-8');

        const body = decodeBody(result);
        expect(body).toContain('<h1>Test HTML</h1>');
    });

    it('should return error when both requested file and fallback do not exist', async () => {
        const lambder = new Lambder({
            files: new LambderLocalFileSource({ root: path.resolve('./tests/fixtures/public') }),
            apiPath: '/api'
        })
            .addRoute('/(.*)', async (ctx, res) => {
                const file = await res.file(ctx.path);
                return file.statusCode === 404 ? res.file('non-existent-fallback.html') : file;
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/non-existent-file.js');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(404);
        expect(decodeBody(result)).toContain('File not found');
    });

    it('should serve correct file even when catch-all route is last', async () => {
        const lambder = new Lambder({
            files: new LambderLocalFileSource({ root: path.resolve('./tests/fixtures/public') }),
            apiPath: '/api'
        })
            .addRoute('/specific', (ctx, res) => {
                return res.html('Specific Route');
            })
            .addRoute('/(.*)', async (ctx, res) => {
                const file = await res.file(ctx.path);
                return file.statusCode === 404 ? res.file('index.html') : file;
            });

        const handler = lambder.getHandler();

        // Test specific route still works
        const specificEvent = createMockEvent('/specific');
        const specificResult = await handler(specificEvent, createMockContext());
        const specificBody = decodeBody(specificResult);
        expect(specificBody).toBe('Specific Route');

        // Test main.css is served correctly
        const cssEvent = createMockEvent('/main.css');
        const cssResult = await handler(cssEvent, createMockContext());
        const cssBody = decodeBody(cssResult);
        expect(cssBody).toContain('body { margin: 0; }');

        // Test fallback to index.html for non-existent files
        const fallbackEvent = createMockEvent('/some-route');
        const fallbackResult = await handler(fallbackEvent, createMockContext());
        const fallbackBody = decodeBody(fallbackResult);
        expect(fallbackBody).toContain('<h1>Test HTML</h1>');
    });

    it('should serve CSS file with correct text/css MIME type', async () => {
        const lambder = new Lambder({
            files: new LambderLocalFileSource({ root: path.resolve('./tests/fixtures/public') }),
            apiPath: '/api'
        })
            .addRoute('/(.*)', (ctx, res) => {
                return res.file(ctx.path);
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/main.css');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(200);

        expect(result.multiValueHeaders?.['Content-Type']).toBeDefined();
        expect(result.multiValueHeaders?.['Content-Type']?.[0]).toBe('text/css; charset=utf-8');

        const body = decodeBody(result);
        expect(body).toContain('body { margin: 0; }');
    });
});

describe('Public file sources', () => {
    const files = new Map<string, { body: Buffer, mimeType?: string }>([
        ['app.css', { body: Buffer.from('body { color: red; }') }],
        ['data.bin', { body: Buffer.from([1, 2, 3]), mimeType: 'application/x-custom' }],
        ['nested/page.txt', { body: Buffer.from('nested text') }],
    ]);
    const makeSource = () => {
        const read = vi.fn(async (relativePath: string) => files.get(relativePath) ?? null);
        return { source: { read } satisfies LambderFileSource, read };
    };
    const makeLambder = (files: LambderFilesOption, options: Parameters<Lambder["servePublicFiles"]>[0] = {}) =>
        new Lambder({ files, apiPath: '/api' })
            .servePublicFiles(options)
            .setRouteFallbackHandler((ctx, res) => res.text(`fallback:${ctx.path}`, { statusCode: 404 }));
    const request = async (lambder: Lambder, requestPath: string) =>
        await lambder.getHandler()(createMockEvent(requestPath), createMockContext());

    it('serves from a custom source, mime from the extension unless the source names one', async () => {
        const { source, read } = makeSource();
        const lambder = makeLambder(source);

        const css = await request(lambder, '/app.css');
        expect(css.statusCode).toBe(200);
        expect(css.multiValueHeaders?.['Content-Type']).toContain('text/css; charset=utf-8');
        expect(decodeBody(css)).toBe('body { color: red; }');
        expect(read).toHaveBeenCalledWith('app.css'); // relative: no leading slash

        const bin = await request(lambder, '/data.bin');
        expect(bin.multiValueHeaders?.['Content-Type']).toContain('application/x-custom');

        const nested = await request(lambder, '/nested/page.txt');
        expect(decodeBody(nested)).toBe('nested text');
        expect(read).toHaveBeenCalledWith('nested/page.txt');
    });

    it('falls through to the route fallback when the source has no such file', async () => {
        const { source } = makeSource();
        const result = await request(makeLambder(source), '/missing.js');
        expect(result.statusCode).toBe(404);
        expect(decodeBody(result)).toBe('fallback:/missing.js');
    });

    it('never asks the source for traversal, empty, or directory paths', async () => {
        const { source, read } = makeSource();
        const lambder = makeLambder(source);
        for (const requestPath of ['/../secret', '/a/../../b.css', '/', '/nested/']) {
            const result = await request(lambder, requestPath);
            expect(result.statusCode).toBe(404);
        }
        expect(read).not.toHaveBeenCalled();
    });

    it('remembers a miss for its TTL instead of asking the source on every page view', async () => {
        // A real 50 ms TTL: the cache keeps its own clock, which fake timers do not move.
        const { source, read } = makeSource();
        const lambder = makeLambder({ source, memoryCache: { missTtlSeconds: 0.05 } });
        await request(lambder, '/dashboard');
        await request(lambder, '/dashboard');
        expect(read).toHaveBeenCalledTimes(1);

        // Uploaded meanwhile: served once the remembered miss runs out.
        files.set('dashboard', { body: Buffer.from('now here') });
        try {
            await new Promise((resolve) => setTimeout(resolve, 80));
            expect(decodeBody(await request(lambder, '/dashboard'))).toBe('now here');
            expect(read).toHaveBeenCalledTimes(2);
        } finally {
            files.delete('dashboard');
        }
    });

    it('evicts the least recently served file first, so a hot file outlives a cold one', async () => {
        const hot = { body: Buffer.alloc(400, 1) };
        const cold = { body: Buffer.alloc(400, 2) };
        const late = { body: Buffer.alloc(400, 3) };
        files.set('hot.bin', hot); files.set('cold.bin', cold); files.set('late.bin', late);
        try {
            const { source, read } = makeSource();
            // Room for two of these with their keys and overhead, not three.
            const lambder = makeLambder({ source, memoryCache: { maxBytes: 1_500 } });
            await request(lambder, '/hot.bin');
            await request(lambder, '/cold.bin');
            await request(lambder, '/hot.bin');
            await request(lambder, '/late.bin');
            read.mockClear();
            await request(lambder, '/hot.bin');
            expect(read).not.toHaveBeenCalled();
            await request(lambder, '/cold.bin');
            expect(read).toHaveBeenCalledWith('cold.bin');
        } finally {
            files.delete('hot.bin'); files.delete('cold.bin'); files.delete('late.bin');
        }
    });

    it('bounds the remembered misses by the bytes of their paths, which the caller chooses', async () => {
        const { source, read } = makeSource();
        const lambder = makeLambder({ source, memoryCache: { missTtlSeconds: 60 } });
        const longPath = (index: number) => `/${String(index).padStart(8, '0')}${'x'.repeat(8_000)}`;
        await request(lambder, longPath(0));
        // Three hundred more 8 KB misses: past the misses' byte budget,
        // though far under any count a bound by entries would have.
        for (let index = 1; index <= 300; index += 1) await request(lambder, longPath(index));
        read.mockClear();
        await request(lambder, longPath(0));
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('asks the source every time with missTtlSeconds: 0 or the memory cache off', async () => {
        for (const option of [{ missTtlSeconds: 0 }, false] as const) {
            const { source, read } = makeSource();
            const lambder = makeLambder({ source, memoryCache: option });
            await request(lambder, '/dashboard');
            await request(lambder, '/dashboard');
            expect(read).toHaveBeenCalledTimes(2);
        }
    });

    it('looks a file up by its decoded name, whichever gateway encoded the path', async () => {
        const { source, read } = makeSource();
        files.set('team photo.txt', { body: Buffer.from('team') });
        files.set('hakkımızda.txt', { body: Buffer.from('hakkında') });
        try {
            const lambder = makeLambder(source);
            expect(decodeBody(await request(lambder, '/team%20photo.txt'))).toBe('team');
            expect(decodeBody(await request(lambder, '/hakk%C4%B1m%C4%B1zda.txt'))).toBe('hakkında');
            expect(read).toHaveBeenCalledWith('team photo.txt');
            // A percent sign in a name, and an encoded slash, which no name holds.
            files.set('100%.txt', { body: Buffer.from('percent') });
            expect(decodeBody(await request(lambder, '/100%25.txt'))).toBe('percent');
            expect((await request(lambder, '/nested%2Fpage.txt')).statusCode).toBe(404);
            expect(read).not.toHaveBeenCalledWith(expect.stringContaining('%2F'));
            // An encoded ".." is refused as the ".." it decodes to.
            expect((await request(lambder, '/nested/%2e%2e/%2e%2e/secret')).statusCode).toBe(404);
            expect(read).not.toHaveBeenCalledWith(expect.stringContaining('..'));
        } finally {
            files.delete('team photo.txt');
            files.delete('hakkımızda.txt');
        }
    });

    it('marks only bundler output immutable, never a hand-named file', async () => {
        const immutable = 'public, max-age=31536000, immutable';
        const cacheControlOf = async (relativePath: string) => {
            files.set(relativePath, { body: Buffer.from('x') });
            try {
                const result = await request(makeLambder(makeSource().source), `/${relativePath}`);
                return result.multiValueHeaders?.['Cache-Control']?.[0];
            } finally {
                files.delete(relativePath);
            }
        };
        for (const hashed of [
            'assets/index-BHf9XZ2a.js', 'assets/index-D-2kQ_7a.js', 'assets/index-DfG3k9Q1.js', 'assets/index-BxQkLmPa.js',
            'assets/vendor-a1b2c3d4.js', 'static/chunks/123-abc12345.js',
            'static/js/main.3f2a1b9c.js', 'static/js/787.3f2a1b9c.chunk.js', '_next/static/chunks/app.js',
        ]) {
            expect(await cacheControlOf(hashed)).toBe(immutable);
        }
        for (const handNamed of [
            'android-chrome-192x192.png', 'og-image-1200x630.png', 'privacy-policy-v2.html', 'team-photo-2023.jpg', 'inter-latin-400-normal.woff2',
            'assets/team-photo-2023.jpg', 'assets/icon-settings.svg', 'assets/photo-20230615.jpg', 'app-4f8a1b2c.js',
            // A last word of exactly 8 characters: PascalCase, or lowercase around a version.
            'assets/Inter-SemiBold.woff2', 'assets/icon-Settings.svg', 'assets/og-image-v2-final.png',
        ]) {
            expect(await cacheControlOf(handNamed)).toBe('public, max-age=3600');
        }
    });

    it('serves repeat requests from the memory cache, configured beside the source', async () => {
        const { source, read } = makeSource();
        const lambder = makeLambder(source);
        await request(lambder, '/app.css');
        await request(lambder, '/app.css');
        expect(read).toHaveBeenCalledTimes(1);

        const { source: uncached, read: uncachedRead } = makeSource();
        const noCache = makeLambder({ source: uncached, memoryCache: false });
        await request(noCache, '/app.css');
        await request(noCache, '/app.css');
        expect(uncachedRead).toHaveBeenCalledTimes(2);
    });

    it('cacheControl callback receives the relative path; the immutable heuristic applies to it', async () => {
        const { source } = makeSource();
        files.set('assets/app-4f8a1b2c9d.js', { body: Buffer.from('js') });
        const seen: string[] = [];
        const lambder = makeLambder(source, { cacheControl: (_ctx: unknown, relativePath: string) => { seen.push(relativePath); return 'private'; } });
        await request(lambder, '/nested/page.txt');
        expect(seen).toEqual(['nested/page.txt']);

        const hashed = await request(makeLambder(makeSource().source), '/assets/app-4f8a1b2c9d.js');
        expect(hashed.multiValueHeaders?.['Cache-Control']).toContain('public, max-age=31536000, immutable');
    });

    it('a local folder source serves the bundled folder, traversal-safe', async () => {
        const lambder = new Lambder({ files: new LambderLocalFileSource({ root: path.resolve('./tests/fixtures/public') }), apiPath: '/api' })
            .servePublicFiles()
            .setRouteFallbackHandler((ctx, res) => res.text('fallback', { statusCode: 404 }));
        const result = await request(lambder, '/main.css');
        expect(result.statusCode).toBe(200);
        expect(decodeBody(result)).toContain('body { margin: 0; }');
        expect((await request(lambder, '/../package.json')).statusCode).toBe(404);
    });
});

describe('Files option', () => {
    it('servePublicFiles, res.file and res.templateFile require the files option', async () => {
        expect(() => new Lambder({ apiPath: '/api' }).servePublicFiles()).toThrow(/files option/);

        const res = new Lambder({ apiPath: '/api' }).getResponseBuilder();
        await expect(res.file('/main.css')).rejects.toThrow(/files option/);
        await expect(res.templateFile('index.html')).rejects.toThrow(/files option/);
    });

    it('res.file and res.templateFile read through the configured source', async () => {
        const read = vi.fn(async (relativePath: string) => {
            if (relativePath === 'legal/terms.html') return { body: Buffer.from('<h1>Terms</h1>') };
            if (relativePath === 'index.html') return { body: Buffer.from('<title>Shell</title>') };
            return null;
        });
        const lambder = new Lambder({ files: { read }, apiPath: '/api' })
            .addRoute('/terms', (ctx, res) => res.file('/legal/terms.html'))
            .addRoute('/nope', (ctx, res) => res.file('/nope.html'))
            .addRoute('/shell', (ctx, res) => res.templateFile('index.html', { title: 'Hello' }, { htmlVirtualSlots: true }));
        const handler = lambder.getHandler();

        const terms = await handler(createMockEvent('/terms'), createMockContext());
        expect(terms.statusCode).toBe(200);
        expect(terms.multiValueHeaders?.['Content-Type']).toContain('text/html; charset=utf-8');
        expect(decodeBody(terms)).toBe('<h1>Terms</h1>');
        expect(read).toHaveBeenCalledWith('legal/terms.html'); // relative, no leading slash

        const missing = await handler(createMockEvent('/nope'), createMockContext());
        expect(missing.statusCode).toBe(404);

        const shell = await handler(createMockEvent('/shell'), createMockContext());
        expect(decodeBody(shell)).toBe('<title>Hello</title>');
        await handler(createMockEvent('/shell'), createMockContext());
        expect(read.mock.calls.filter(([p]) => p === 'index.html').length).toBe(1); // read and compiled once per instance
    });

    it('caches compiled templates per instance, not per path', async () => {
        const sourceA = { read: async () => ({ body: Buffer.from('A') }) };
        const sourceB = { read: async () => ({ body: Buffer.from('B') }) };
        const a = new Lambder({ files: sourceA, apiPath: '/api' }).addRoute('/', (ctx, res) => res.templateFile('index.html')).getHandler();
        const b = new Lambder({ files: sourceB, apiPath: '/api' }).addRoute('/', (ctx, res) => res.templateFile('index.html')).getHandler();
        expect(decodeBody(await a(createMockEvent('/'), createMockContext()))).toBe('A');
        expect(decodeBody(await b(createMockEvent('/'), createMockContext()))).toBe('B');
    });
});

describe('The reader path rule', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    /** A fetch stand-in whose recorded calls are typed the way the source calls it. */
    const recordingFetch = (answer: () => Promise<Response>) =>
        vi.fn<(url: URL, init: { headers: Record<string, string> }) => Promise<Response>>(answer);

    /**
     * Leading-slash runs a caller can write on any request. Each collapses to
     * a plain relative path UNDER the source's own root. Stripping just one
     * slash would hand a source "/x" (root-relative) for "//x", and
     * "//attacker.example/evil.html" (protocol-relative, naming a host of the
     * caller's choosing) for "///attacker.example/evil.html".
     */
    const collapsingPaths: [string, string][] = [
        ['//x', 'x'],
        ['///attacker.example/evil.html', 'attacker.example/evil.html'],
    ];

    /** Paths that name no file at all: no source is asked for any of them. */
    const refusedPaths = ['/\\x', 'a//b', './a', '/nested/../../b', '/', '/nested/'];

    it('hands a local source only paths that stay under its root', async () => {
        const source = new LambderLocalFileSource({ root: path.resolve('./tests/fixtures/public') });
        const read = vi.spyOn(source, 'read');
        const reader = new LambderFiles(source);

        for(const refused of refusedPaths){
            expect(await reader.read(refused)).toBeNull();
        }
        expect(read).not.toHaveBeenCalled();

        for(const [requested, relative] of collapsingPaths){
            await reader.read(requested);
            expect(read).toHaveBeenLastCalledWith(relative);
        }
        // And its own belt holds for a caller that reaches it without the reader.
        expect(await source.read('../../package.json')).toBeNull();
    });

    it('hands an S3 source only keys that stay under its prefix', async () => {
        const s3Mock = mockClient(S3Client);
        s3Mock.reset();
        s3Mock.on(GetObjectCommand).resolves({ Body: { transformToByteArray: async () => new Uint8Array([1]) } as any });
        const reader = new LambderFiles(new LambderS3FileSource({ bucket: 'web', prefix: 'v42/', client: new S3Client({}) }));

        for(const refused of refusedPaths){
            expect(await reader.read(refused)).toBeNull();
        }
        expect(s3Mock.calls()).toHaveLength(0);

        for(const [requested, relative] of collapsingPaths){
            await reader.read(requested);
            expect(s3Mock.commandCalls(GetObjectCommand).at(-1)?.args[0].input.Key).toBe(`v42/${relative}`);
        }
        s3Mock.restore();
    });

    it('hands an HTTP source only URLs that stay under its base URL', async () => {
        const fetchSpy = recordingFetch(async () => new Response('x', { status: 200 }));
        vi.stubGlobal('fetch', fetchSpy);
        const source = new LambderHttpFileSource({ baseUrl: 'https://cdn.example.com/v42/' });
        const reader = new LambderFiles(source);

        for(const refused of refusedPaths){
            expect(await reader.read(refused)).toBeNull();
        }
        expect(fetchSpy).not.toHaveBeenCalled();

        for(const [requested, relative] of collapsingPaths){
            await reader.read(requested);
            expect(String(fetchSpy.mock.calls.at(-1)?.[0])).toBe(`https://cdn.example.com/v42/${relative}`);
        }

        // The source's own belt, for a caller that reaches it without the
        // reader: a value that resolves outside baseUrl is refused unfetched.
        fetchSpy.mockClear();
        expect(await source.read('/attacker.example/evil.html')).toBeNull();
        expect(await source.read('//attacker.example/evil.html')).toBeNull();
        expect(await source.read('/private/secrets.json')).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('never fetches an attacker-named origin, so the origin credentials never leave the configured host', async () => {
        const fetchSpy = recordingFetch(async () => new Response('<script>evil()</script>', { status: 404 }));
        vi.stubGlobal('fetch', fetchSpy);
        const lambder = new Lambder({
            files: new LambderHttpFileSource({
                baseUrl: 'https://cdn.example.com/v42/',
                headers: { Authorization: 'Bearer SECRET-ORIGIN-TOKEN' },
            }),
            apiPath: '/api',
        })
            .servePublicFiles()
            .setRouteFallbackHandler((ctx, res) => res.text('fallback', { statusCode: 404 }));

        const result = await lambder.getHandler()(createMockEvent('///attacker.example/evil.html'), createMockContext());

        expect(result.statusCode).toBe(404);
        expect(decodeBody(result)).toBe('fallback');
        // The one read it did make went to the configured origin, under the
        // configured version prefix, carrying the Authorization header there
        // and nowhere else.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(String(url)).toBe('https://cdn.example.com/v42/attacker.example/evil.html');
        expect(new URL(String(url)).host).toBe('cdn.example.com');
        expect(init.headers).toEqual({ Authorization: 'Bearer SECRET-ORIGIN-TOKEN' });
    });
});

describe('servePublicFiles method gate', () => {
    const serve = (options: Parameters<Lambder['servePublicFiles']>[0] = {}) =>
        new Lambder({ files: new LambderLocalFileSource({ root: path.resolve('./tests/fixtures/public') }), apiPath: '/api' })
            .servePublicFiles(options)
            .setRouteFallbackHandler((ctx, res) => res.text(`fallback:${ctx.method}`, { statusCode: 404 }));

    it('serves GET and HEAD by default and falls a write method through to the route fallback', async () => {
        const lambder = serve();

        const get = await lambder.getHandler()(createMockEvent('/main.css'), createMockContext());
        expect(get.statusCode).toBe(200);
        expect(decodeBody(get)).toContain('body { margin: 0; }');

        const head = await lambder.getHandler()(createMockEvent('/main.css', 'HEAD'), createMockContext());
        expect(head.statusCode).toBe(200);

        const del = await lambder.getHandler()(createMockEvent('/main.css', 'DELETE'), createMockContext());
        expect(del.statusCode).toBe(404);
        expect(decodeBody(del)).toBe('fallback:DELETE');
    });

    it('accepts HEAD for a list that names GET alone, as a route matcher does', async () => {
        const lambder = serve({ methods: ['GET'] });

        expect((await lambder.getHandler()(createMockEvent('/main.css', 'HEAD'), createMockContext())).statusCode).toBe(200);
        expect((await lambder.getHandler()(createMockEvent('/main.css', 'POST'), createMockContext())).statusCode).toBe(404);
    });
});
