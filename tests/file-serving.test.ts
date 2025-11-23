/**
 * File Serving Tests
 * 
 * Tests for file serving functionality including:
 * - Serving existing files correctly
 * - Fallback to index.html for non-existent files
 * - Not serving index.html when the requested file exists
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../src/Lambder.js';
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
            publicPath: path.resolve('./tests/fixtures/public'),
            apiPath: '/api'
        })
            .addRoute('/(.*)', (ctx, res) => {
                return res.file(ctx.path, {}, 'index.html');
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/main.css');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(200);
        
        // Check content type is CSS
        expect(result.multiValueHeaders?.['Content-Type']).toContain('text/css');
        
        // Check body contains CSS content
        const body = Buffer.from(result.body || '', 'base64').toString();
        expect(body).toContain('body { margin: 0; }');
        expect(body).not.toContain('<h1>Test HTML</h1>');
    });

    it('should serve index.html when requested file does not exist', async () => {
        const lambder = new Lambder({
            publicPath: path.resolve('./tests/fixtures/public'),
            apiPath: '/api'
        })
            .addRoute('/(.*)', (ctx, res) => {
                return res.file(ctx.path, {}, 'index.html');
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/non-existent-file.js');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(200);
        
        // Check content type is HTML
        expect(result.multiValueHeaders?.['Content-Type']).toContain('text/html');
        
        // Check body contains HTML content from index.html
        const body = Buffer.from(result.body || '', 'base64').toString();
        expect(body).toContain('<h1>Test HTML</h1>');
    });

    it('should serve index.html when requested directly', async () => {
        const lambder = new Lambder({
            publicPath: path.resolve('./tests/fixtures/public'),
            apiPath: '/api'
        })
            .addRoute('/(.*)', (ctx, res) => {
                return res.file(ctx.path, {}, 'index.html');
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/index.html');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(200);
        
        // Check content type is HTML
        expect(result.multiValueHeaders?.['Content-Type']).toContain('text/html');
        
        // Check body contains HTML content
        const body = Buffer.from(result.body || '', 'base64').toString();
        expect(body).toContain('<h1>Test HTML</h1>');
    });

    it('should return error when both requested file and fallback do not exist', async () => {
        const lambder = new Lambder({
            publicPath: path.resolve('./tests/fixtures/public'),
            apiPath: '/api'
        })
            .addRoute('/(.*)', (ctx, res) => {
                return res.file(ctx.path, {}, 'non-existent-fallback.html');
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/non-existent-file.js');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(200);
        
        // Should return JSON error
        const body = JSON.parse(result.body || '{}');
        expect(body.error).toContain('File not found');
    });

    it('should serve correct file even when catch-all route is last', async () => {
        const lambder = new Lambder({
            publicPath: path.resolve('./tests/fixtures/public'),
            apiPath: '/api'
        })
            .addRoute('/specific', (ctx, res) => {
                return res.html('Specific Route');
            })
            .addRoute('/(.*)', (ctx, res) => {
                return res.file(ctx.path, {}, 'index.html');
            });

        const handler = lambder.getHandler();
        
        // Test specific route still works
        const specificEvent = createMockEvent('/specific');
        const specificResult = await handler(specificEvent, createMockContext());
        const specificBody = Buffer.from(specificResult.body || '', 'base64').toString();
        expect(specificBody).toBe('Specific Route');
        
        // Test main.css is served correctly
        const cssEvent = createMockEvent('/main.css');
        const cssResult = await handler(cssEvent, createMockContext());
        const cssBody = Buffer.from(cssResult.body || '', 'base64').toString();
        expect(cssBody).toContain('body { margin: 0; }');
        
        // Test fallback to index.html for non-existent files
        const fallbackEvent = createMockEvent('/some-route');
        const fallbackResult = await handler(fallbackEvent, createMockContext());
        const fallbackBody = Buffer.from(fallbackResult.body || '', 'base64').toString();
        expect(fallbackBody).toContain('<h1>Test HTML</h1>');
    });

    it('should serve CSS file with correct text/css MIME type', async () => {
        const lambder = new Lambder({
            publicPath: path.resolve('./tests/fixtures/public'),
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
        const body = Buffer.from(result.body || '', 'base64').toString();
        expect(body).toContain('body { margin: 0; }');
    });
});
