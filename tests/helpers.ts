import { gunzipSync } from 'node:zlib';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';
import type { LambderHttpResponse } from '../src/LambderResponse.js';

/** Decode a finalized response body: base64-aware, gzip-unaware (tests opt out of gzip by not sending Accept-Encoding). */
export const decodeBody = (result: { body: string | null, isBase64Encoded?: boolean }): string => {
    if(!result.body) return '';
    return result.isBase64Encoded ? Buffer.from(result.body, 'base64').toString() : result.body;
};

/** Decode a gzipped, base64-encoded response body. */
export const gunzipBody = (result: { body: string | null }): string =>
    gunzipSync(Buffer.from(result.body || '', 'base64')).toString('utf8');

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
