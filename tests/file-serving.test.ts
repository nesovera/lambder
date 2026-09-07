/**
 * File Serving Tests
 * 
 * Tests for file serving functionality including:
 * - Serving existing files correctly
 * - Fallback to index.html for non-existent files
 * - Not serving index.html when the requested file exists
 */

import { describe, it, expect } from 'vitest';
import { decodeBody } from './helpers.js';
import { vi } from 'vitest';
import Lambder from '../src/core/Lambder.js';
import { LambderLocalFileSource } from '../src/core/LambderFiles.js';
import type { LambderFileSource, LambderFilesOption } from '../src/core/LambderFiles.js';
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
        
        // Check content type is CSS
        expect(result.multiValueHeaders?.['Content-Type']).toContain('text/css');
        
        // Check body contains CSS content
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
        
        // Check content type is HTML
        expect(result.multiValueHeaders?.['Content-Type']).toContain('text/html');
        
        // Check body contains HTML content from index.html
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
        
        // Check content type is HTML
        expect(result.multiValueHeaders?.['Content-Type']).toContain('text/html');
        
        // Check body contains HTML content
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
        
        // Verify Content-Type header is exactly text/css
        expect(result.multiValueHeaders?.['Content-Type']).toBeDefined();
        expect(result.multiValueHeaders?.['Content-Type']?.[0]).toBe('text/css');
        
        // Verify body contains CSS content
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
        expect(css.multiValueHeaders?.['Content-Type']).toContain('text/css');
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
        expect(terms.multiValueHeaders?.['Content-Type']).toContain('text/html');
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
