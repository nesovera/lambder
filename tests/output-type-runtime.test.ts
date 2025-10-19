/**
 * Output Type Enforcement Runtime Tests
 * 
 * These tests verify that the typed APIs work correctly at runtime
 * while maintaining type safety at compile time.
 */

import { describe, it, expect } from 'vitest';
import { APIGatewayProxyEvent, Context } from 'aws-lambda';
import Lambder from '../src/Lambder.js';
import type { ApiContract } from '../src/index.js';

// Mock AWS Lambda event and context
const createMockEvent = (apiName: string, payload: any): APIGatewayProxyEvent => ({
    body: JSON.stringify({ apiName, payload }),
    headers: { Host: 'localhost' },
    multiValueHeaders: {},
    httpMethod: 'POST',
    isBase64Encoded: false,
    path: '/api',
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

// Test contract
type TestContract = ApiContract<{
    echo: { input: { message: string }, output: { echo: string } },
    add: { input: { a: number, b: number }, output: number },
    getUser: { input: { userId: string }, output: { id: string, name: string, age: number } },
    listUsers: { input: void, output: Array<{ id: string, name: string }> },
    findUser: { input: { email: string }, output: { id: string, name: string } | null },
    deleteUser: { input: { userId: string }, output: boolean },
}>;

// ============================================================================
// Runtime Tests
// ============================================================================

describe('Output Type Enforcement - Runtime', () => {
    it('should return correct primitive types', async () => {
        const lambder = new Lambder<TestContract>({
            publicPath: './public',
            apiPath: '/api',
        });

        lambder.addApi('add', async (ctx, resolver) => {
            const { a, b } = ctx.apiPayload;
            const sum = a + b;
            return resolver.api(sum);
        });

        const event = createMockEvent('add', { a: 5, b: 3 });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toBe(8);
    });

    it('should return correct object types', async () => {
        const lambder = new Lambder<TestContract>({
            publicPath: './public',
            apiPath: '/api',
        });

        lambder.addApi('getUser', async (ctx, resolver) => {
            const userId = ctx.apiPayload.userId;
            return resolver.api({
                id: userId,
                name: 'John Doe',
                age: 30
            });
        });

        const event = createMockEvent('getUser', { userId: '123' });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toEqual({
            id: '123',
            name: 'John Doe',
            age: 30
        });
    });

    it('should return correct array types', async () => {
        const lambder = new Lambder<TestContract>({
            publicPath: './public',
            apiPath: '/api',
        });

        lambder.addApi('listUsers', async (ctx, resolver) => {
            return resolver.api([
                { id: '1', name: 'Alice' },
                { id: '2', name: 'Bob' }
            ]);
        });

        const event = createMockEvent('listUsers', undefined);
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toEqual([
            { id: '1', name: 'Alice' },
            { id: '2', name: 'Bob' }
        ]);
    });

    it('should handle null returns correctly', async () => {
        const lambder = new Lambder<TestContract>({
            publicPath: './public',
            apiPath: '/api',
        });

        lambder.addApi('findUser', async (ctx, resolver) => {
            const email = ctx.apiPayload.email;
            if (email === 'notfound@example.com') {
                return resolver.api(null);
            }
            return resolver.api({ id: '1', name: 'Found User' });
        });

        // Test null case
        const event1 = createMockEvent('findUser', { email: 'notfound@example.com' });
        const context1 = createMockContext();
        const response1 = await lambder.render(event1, context1);

        expect(response1.statusCode).toBe(200);
        const body1 = JSON.parse(response1.body || '{}');
        expect(body1.payload).toBeNull();

        // Test found case
        const event2 = createMockEvent('findUser', { email: 'found@example.com' });
        const context2 = createMockContext();
        const response2 = await lambder.render(event2, context2);

        expect(response2.statusCode).toBe(200);
        const body2 = JSON.parse(response2.body || '{}');
        expect(body2.payload).toEqual({ id: '1', name: 'Found User' });
    });

    it('should return boolean types correctly', async () => {
        const lambder = new Lambder<TestContract>({
            publicPath: './public',
            apiPath: '/api',
        });

        lambder.addApi('deleteUser', async (ctx, resolver) => {
            const userId = ctx.apiPayload.userId;
            // Mock deletion
            const success = userId !== '';
            return resolver.api(success);
        });

        const event = createMockEvent('deleteUser', { userId: '123' });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toBe(true);
    });

    it('should work with die.api()', async () => {
        const lambder = new Lambder<TestContract>({
            publicPath: './public',
            apiPath: '/api',
        });

        lambder.addApi('echo', async (ctx, resolver) => {
            return resolver.die.api({ echo: ctx.apiPayload.message });
        });

        const event = createMockEvent('echo', { message: 'Hello!' });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toEqual({ echo: 'Hello!' });
    });

    it('should work with session APIs', async () => {
        const lambder = new Lambder<TestContract>({
            publicPath: './public',
            apiPath: '/api',
        });

        // Note: Session will fail without DynamoDB setup, but we're testing type enforcement
        lambder.addSessionApi('getUser', async (ctx, resolver) => {
            return resolver.api({
                id: ctx.apiPayload.userId,
                name: 'Session User',
                age: 25
            });
        });

        // This will return 500 error because session is not configured
        const event = createMockEvent('getUser', { userId: '123' });
        const context = createMockContext();
        
        const response = await lambder.render(event, context);
        
        // Should return 500 error when session is not configured
        expect(response.statusCode).toBe(500);
        expect(response.body).toBe('Internal Server Error.');
    });
});

// ============================================================================
// Input Type Tests
// ============================================================================

describe('Input Type Enforcement - Runtime', () => {
    it('should receive correctly typed input', async () => {
        const lambder = new Lambder<TestContract>({
            publicPath: './public',
            apiPath: '/api',
        });

        lambder.addApi('echo', async (ctx, resolver) => {
            // Verify input is correctly typed at runtime
            const message: string = ctx.apiPayload.message;
            expect(typeof message).toBe('string');
            return resolver.api({ echo: message });
        });

        const event = createMockEvent('echo', { message: 'Test Message' });
        const context = createMockContext();
        await lambder.render(event, context);
    });

    it('should handle void input correctly', async () => {
        const lambder = new Lambder<TestContract>({
            publicPath: './public',
            apiPath: '/api',
        });

        lambder.addApi('listUsers', async (ctx, resolver) => {
            // apiPayload should be undefined for void input
            expect(ctx.apiPayload).toBeUndefined();
            return resolver.api([]);
        });

        const event = createMockEvent('listUsers', undefined);
        const context = createMockContext();
        await lambder.render(event, context);
    });

    it('should handle complex input objects', async () => {
        const lambder = new Lambder<TestContract>({
            publicPath: './public',
            apiPath: '/api',
        });

        lambder.addApi('add', async (ctx, resolver) => {
            const { a, b } = ctx.apiPayload;
            expect(typeof a).toBe('number');
            expect(typeof b).toBe('number');
            return resolver.api(a + b);
        });

        const event = createMockEvent('add', { a: 10, b: 20 });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toBe(30);
    });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Edge Cases', () => {
    it('should handle empty arrays', async () => {
        const lambder = new Lambder<TestContract>({
            publicPath: './public',
            apiPath: '/api',
        });

        lambder.addApi('listUsers', async (ctx, resolver) => {
            return resolver.api([]);
        });

        const event = createMockEvent('listUsers', undefined);
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toEqual([]);
    });

    it('should handle zero as a valid number', async () => {
        const lambder = new Lambder<TestContract>({
            publicPath: './public',
            apiPath: '/api',
        });

        lambder.addApi('add', async (ctx, resolver) => {
            return resolver.api(0);
        });

        const event = createMockEvent('add', { a: 0, b: 0 });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toBe(0);
    });

    it('should handle empty strings in objects', async () => {
        const lambder = new Lambder<TestContract>({
            publicPath: './public',
            apiPath: '/api',
        });

        lambder.addApi('getUser', async (ctx, resolver) => {
            return resolver.api({
                id: '',
                name: '',
                age: 0
            });
        });

        const event = createMockEvent('getUser', { userId: '' });
        const context = createMockContext();
        const response = await lambder.render(event, context);

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body || '{}');
        expect(body.payload).toEqual({
            id: '',
            name: '',
            age: 0
        });
    });
});
