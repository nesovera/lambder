/**
 * API Gateway HTTP API / Lambda Function URL (payload v2) support:
 * event decoding (method/path/query/cookies) and v2 response encoding
 * (single-value headers + cookies array instead of multiValueHeaders).
 */

import { describe, it, expect } from 'vitest';
import Lambder, { initLambder } from '../src/core/Lambder.js';
import { decodeBody, gunzipBody, createMockContext } from './helpers.js';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const createMockEventV2 = (
    reqPath: string,
    overrides: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 => ({
    version: '2.0',
    routeKey: '$default',
    rawPath: reqPath,
    rawQueryString: '',
    headers: { host: 'localhost' },
    requestContext: {
        accountId: '1',
        apiId: 'api',
        domainName: 'localhost',
        domainPrefix: '',
        http: { method: 'GET', path: reqPath, protocol: 'HTTP/1.1', sourceIp: '9.9.9.9', userAgent: 'test' },
        requestId: 'r',
        routeKey: '$default',
        stage: '$default',
        time: '',
        timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
});

describe('HTTP API v2 events', () => {
    it('is detected as an HTTP event and routes normally', async () => {
        expect(Lambder.isHttpEvent(createMockEventV2('/x'))).toBe(true);
        expect(Lambder.isHttpEvent({ source: 'aws.events' })).toBe(false);

        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/hello', (ctx, res) => res.html('Hello V2'));

        const result = await lambder.getHandler()(createMockEventV2('/hello'), createMockContext());
        expect((result as any).statusCode).toBe(200);
        expect(decodeBody(result as any)).toBe('Hello V2');
    });

    it('decodes method, query string, cookies and source ip from the v2 shape', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute({ path: '/echo', method: 'POST' }, (ctx, res) => res.json({
                method: ctx.method,
                page: ctx.get.page,
                session: ctx.cookie.session,
                ip: ctx.ip,
                host: ctx.host,
            }, { etag: false }));

        const event = createMockEventV2('/echo', {
            rawQueryString: 'page=2&sort=asc',
            cookies: ['session=abc123', 'theme=dark'],
        });
        event.requestContext.http.method = 'POST';

        const result = await lambder.render(event, createMockContext());
        const body = JSON.parse(decodeBody(result));
        expect(body).toEqual({ method: 'POST', page: '2', session: 'abc123', ip: '9.9.9.9', host: 'localhost' });
    });

    it('emits v2 responses: single-value headers plus a cookies array', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/set', (ctx, res) => {
                res.addHeader('Set-Cookie', 'a=1; Path=/');
                res.addHeader('Set-Cookie', 'b=2; Path=/');
                return res.html('ok', { headers: { 'X-One': 'x' } });
            });

        const result = await lambder.render(createMockEventV2('/set'), createMockContext());
        expect(result.multiValueHeaders).toBeUndefined();
        expect(result.headers?.['X-One']).toBe('x');
        expect(result.headers?.['Content-Type']).toContain('text/html');
        expect(result.cookies).toEqual(['a=1; Path=/', 'b=2; Path=/']);
        expect(result.headers?.['Set-Cookie']).toBeUndefined();
    });

    it('v1 events still emit multiValueHeaders', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/x', (ctx, res) => res.html('v1'));

        const v1Event = {
            body: null, headers: { Host: 'localhost' }, multiValueHeaders: {}, httpMethod: 'GET',
            isBase64Encoded: false, path: '/x', pathParameters: null, queryStringParameters: null,
            multiValueQueryStringParameters: null, stageVariables: null, requestContext: {} as any, resource: '',
        };
        const result = await lambder.render(v1Event, createMockContext());
        expect(result.multiValueHeaders?.['Content-Type']).toBeDefined();
        expect(result.headers).toBeUndefined();
        expect(result.cookies).toBeUndefined();
    });

    it('parses POST bodies and dispatches APIs on v2 events', async () => {
        const { z } = await import('zod');
        const lambder = new Lambder({ publicPath: './public', apiPath: '/api' })
            .addApi('echo.name', {
                input: z.object({ name: z.string() }),
                output: z.object({ hello: z.string() }),
            }, async (ctx, res) => res.api({ hello: ctx.apiPayload.name }));

        const event = createMockEventV2('/api', {
            body: JSON.stringify({ apiName: 'echo.name', payload: { name: 'v2' } }),
        });
        event.requestContext.http.method = 'POST';

        const result = await lambder.render(event, createMockContext());
        const body = JSON.parse(decodeBody(result));
        expect(body.payload).toEqual({ hello: 'v2' });
    });

    it('strips named stage prefixes from rawPath (parity with v1 path)', async () => {
        const lambder = new Lambder({ publicPath: './public', apiPath: '/secure' })
            .addRoute('/hello', (ctx, res) => res.html('Hello ' + ctx.path));

        // Named stage: rawPath includes the prefix, requestContext.stage names it.
        const staged = createMockEventV2('/prod-stage/hello');
        staged.requestContext.stage = 'prod-stage';
        const result = await lambder.render(staged, createMockContext());
        expect(decodeBody(result as any)).toBe('Hello /hello');

        // Stage root maps to "/".
        const root = createMockEventV2('/prod-stage');
        root.requestContext.stage = 'prod-stage';
        const rootCtx = await new Lambder({ publicPath: './public' })
            .addRoute('/', (ctx, res) => res.html('root'))
            .render(root, createMockContext());
        expect(decodeBody(rootCtx as any)).toBe('root');

        // $default stage: rawPath has no prefix and must not be touched.
        const plain = createMockEventV2('/hello');
        const plainResult = await lambder.render(plain, createMockContext());
        expect(decodeBody(plainResult as any)).toBe('Hello /hello');

        // A path that merely looks like the stage name is not stripped.
        const lookalike = createMockEventV2('/prod-stage-extra/hello');
        lookalike.requestContext.stage = 'prod-stage';
        const lookalikeResult = await lambder.render(lookalike, createMockContext());
        expect((lookalikeResult as any).statusCode).toBe(404);
    });

    it('applies ETag + If-None-Match 304 on v2 GETs', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/page', (ctx, res) => res.html('<p>stable content</p>'));

        const first = await lambder.render(createMockEventV2('/page'), createMockContext());
        const etag = (first.headers as Record<string, string>).ETag;
        expect(etag).toBeTruthy();

        const second = await lambder.render(
            createMockEventV2('/page', { headers: { 'host': 'localhost', 'if-none-match': etag } }),
            createMockContext(),
        );
        expect(second.statusCode).toBe(304);
        expect(second.body).toBe('');
    });

    it('gzips large compressible v2 responses when accepted', async () => {
        const bigHtml = `<p>${'lambder '.repeat(500)}</p>`;
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/big', (ctx, res) => res.html(bigHtml));

        const result = await lambder.render(
            createMockEventV2('/big', { headers: { 'host': 'localhost', 'accept-encoding': 'gzip, br' } }),
            createMockContext(),
        );
        expect((result.headers as Record<string, string>)['Content-Encoding']).toBe('gzip');
        expect(result.isBase64Encoded).toBe(true);
        expect(gunzipBody(result as any)).toBe(bigHtml);
    });

    it('answers CORS preflight on v2 OPTIONS requests', async () => {
        const lambder = initLambder().create({ publicPath: './public', cors: true })
            .addRoute('/x', (ctx, res) => res.html('x'));

        const event = createMockEventV2('/x', { headers: { 'host': 'localhost', 'origin': 'https://app.example.com' } });
        event.requestContext.http.method = 'OPTIONS';

        const result = await lambder.render(event, createMockContext());
        expect(result.statusCode).toBe(204);
        expect((result.headers as Record<string, string>)['Access-Control-Allow-Origin']).toBeTruthy();
    });

    it('preserves the raw query string on trailing-slash redirects (v2)', async () => {
        const lambder = new Lambder({ publicPath: './tests/fixtures/public' })
            .servePublicFiles()
            .serveIndexHtml(undefined, { redirectTrailingSlash: true });

        const result = await lambder.render(
            createMockEventV2('/about/', { rawQueryString: 'a=1&a=2&b=x%20y' }),
            createMockContext(),
        );
        expect(result.statusCode).toBe(301);
        expect((result.headers as Record<string, string>).Location).toBe('/about?a=1&a=2&b=x%20y');
    });

    it('emits the v2 shape from the global error handler and the last-resort 500', async () => {
        const lambder = new Lambder({ publicPath: './public' })
            .addRoute('/boom', () => { throw new Error('boom'); })
            .setGlobalErrorHandler((err, ctx, res) => res.html('handled: ' + err.message, { statusCode: 500 }));

        const handled = await lambder.render(createMockEventV2('/boom'), createMockContext());
        expect(handled.statusCode).toBe(500);
        expect(handled).toHaveProperty('headers');
        expect(handled).not.toHaveProperty('multiValueHeaders');
        expect(decodeBody(handled as any)).toBe('handled: boom');

        // No global error handler: the hardcoded 500 must still be v2-shaped.
        const bare = new Lambder({ publicPath: './public' })
            .addRoute('/boom', () => { throw new Error('boom'); });
        const fallback = await bare.render(createMockEventV2('/boom'), createMockContext());
        expect(fallback.statusCode).toBe(500);
        expect(fallback).toHaveProperty('headers');
        expect(fallback).not.toHaveProperty('multiValueHeaders');
    });
});
