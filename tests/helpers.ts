import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import type { APIGatewayProxyEvent, APIGatewayProxyEventV2, Context } from 'aws-lambda';
import type { LambderHttpResponse } from '../src/core/LambderResponse.js';

/** Decode a finalized response body: base64-aware, gzip-unaware (tests opt out of gzip by not sending Accept-Encoding). */
export const decodeBody = (result: { body: string | null, isBase64Encoded?: boolean }): string => {
    if(!result.body) return '';
    return result.isBase64Encoded ? Buffer.from(result.body, 'base64').toString() : result.body;
};

/** Decode a gzipped, base64-encoded response body. */
export const gunzipBody = (result: { body: string | null }): string =>
    gunzipSync(Buffer.from(result.body || '', 'base64')).toString('utf8');

/** Decode a Brotli-compressed, base64-encoded response body. */
export const brotliBody = (result: { body: string | null }): string =>
    brotliDecompressSync(Buffer.from(result.body || '', 'base64')).toString('utf8');

export const createMockEvent = (
    reqPath: string,
    overrides: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent => ({
    body: null,
    headers: { Host: 'localhost' },
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: reqPath,
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    ...overrides,
});

/**
 * A POST to the API path carrying the request envelope. `body` is the whole
 * envelope, so a test can send `payload` plainly, send a compressed
 * `payloadGz` pair, or add guardInputs/idempotencyKey beside it.
 */
export const createApiEvent = (
    body: Record<string, unknown>,
    overrides: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent => createMockEvent('/api', {
    body: JSON.stringify(body),
    httpMethod: 'POST',
    headers: { Host: 'localhost', 'X-Forwarded-For': '203.0.113.7' },
    ...overrides,
});

/** An API Gateway HTTP API (payload v2) event: the shape a Function URL or HTTP API delivers. */
export const createMockEventV2 = (
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

export const createMockContext = (): Context => ({
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

export type { LambderHttpResponse };
