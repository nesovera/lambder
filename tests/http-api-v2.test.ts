/**
 * API Gateway HTTP API / Lambda Function URL (payload v2) support:
 * event decoding (method/path/query/cookies) and v2 response encoding
 * (single-value headers + cookies array instead of multiValueHeaders).
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../src/Lambder.js';
import { decodeBody, createMockContext } from './helpers.js';
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
});
