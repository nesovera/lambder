import { describe, it, expect } from 'vitest';
import Lambder from '../src/Lambder.js';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';

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

describe('Redirect Response', () => {
    it('should redirect with default status code 302', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute('/old-path', (ctx, res) => {
                return res.redirect('/new-path');
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/old-path');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(302);
        expect(result.multiValueHeaders?.Location).toEqual(['/new-path']);
    });

    it('should redirect with custom status code', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute('/moved-permanently', (ctx, res) => {
                return res.redirect('/new-location', 301);
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/moved-permanently');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(301);
        expect(result.multiValueHeaders?.Location).toEqual(['/new-location']);
    });

    it('should redirect using die.redirect', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute('/die-redirect', (ctx, res) => {
                return res.die.redirect('/somewhere-else');
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/die-redirect');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(302);
        expect(result.multiValueHeaders?.Location).toEqual(['/somewhere-else']);
    });
});
