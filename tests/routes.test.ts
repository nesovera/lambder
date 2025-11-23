/**
 * Routes Tests
 * 
 * Tests for addRoute and addSessionRoute functionality including:
 * - String path matching
 * - Path parameter extraction
 * - RegExp route matching
 * - Function-based conditional routing
 * - Session-protected routes
 * - Route priority/ordering
 * - Wildcard routes
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import Lambder from '../src/Lambder.js';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';

// Mock DynamoDB
const ddbMock = mockClient(DynamoDBDocumentClient);

const createMockEvent = (path: string, method: string = 'GET', sessionToken?: string): APIGatewayProxyEvent => ({
    body: null,
    headers: { 
        Host: 'localhost',
        Cookie: sessionToken ? `LMDRSESSIONTKID=${sessionToken}` : ''
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

describe('Routes - Basic Path Matching', () => {
    it('should match simple string paths', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute('/hello', (ctx, res) => {
                return res.html('Hello World');
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/hello');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(200);
        const body = Buffer.from(result.body || '', 'base64').toString();
        expect(body).toBe('Hello World');
    });

    it('should not match wrong paths', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute('/hello', (ctx, res) => {
                return res.html('Hello');
            })
            .setRouteFallbackHandler((ctx, res) => {
                return res.status404('Not Found');
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/goodbye');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(404);
    });

    it('should match multiple routes', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute('/home', (ctx, res) => {
                return res.html('Home Page');
            })
            .addRoute('/about', (ctx, res) => {
                return res.html('About Page');
            })
            .addRoute('/contact', (ctx, res) => {
                return res.html('Contact Page');
            });

        const handler = lambder.getHandler();

        const homeResult = await handler(createMockEvent('/home'), createMockContext());
        expect(Buffer.from(homeResult.body || '', 'base64').toString()).toBe('Home Page');

        const aboutResult = await handler(createMockEvent('/about'), createMockContext());
        expect(Buffer.from(aboutResult.body || '', 'base64').toString()).toBe('About Page');

        const contactResult = await handler(createMockEvent('/contact'), createMockContext());
        expect(Buffer.from(contactResult.body || '', 'base64').toString()).toBe('Contact Page');
    });
});

describe('Routes - Path Parameters', () => {
    it('should extract path parameters from string patterns', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute('/user/:userId', (ctx, res) => {
                return res.json({ userId: ctx.pathParams?.userId });
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/user/123');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body || '{}');
        expect(body.userId).toBe('123');
    });

    it('should extract multiple path parameters', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute('/users/:userId/posts/:postId', (ctx, res) => {
                return res.json({ 
                    userId: ctx.pathParams?.userId,
                    postId: ctx.pathParams?.postId
                });
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/users/456/posts/789');
        const result = await handler(event, createMockContext());

        const body = JSON.parse(result.body || '{}');
        expect(body.userId).toBe('456');
        expect(body.postId).toBe('789');
    });

    it('should handle optional parameters', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute('/files/:path*', (ctx, res) => {
                return res.json({ path: ctx.pathParams?.path });
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/files/documents/report.pdf');
        const result = await handler(event, createMockContext());

        const body = JSON.parse(result.body || '{}');
        expect(body.path).toBeTruthy();
    });
});

describe('Routes - RegExp Matching', () => {
    it('should match routes using RegExp', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute(/^\/admin/, (ctx, res) => {
                return res.html('Admin Area');
            });

        const handler = lambder.getHandler();
        
        const adminResult = await handler(createMockEvent('/admin'), createMockContext());
        expect(Buffer.from(adminResult.body || '', 'base64').toString()).toBe('Admin Area');

        const adminDashResult = await handler(createMockEvent('/admin/dashboard'), createMockContext());
        expect(Buffer.from(adminDashResult.body || '', 'base64').toString()).toBe('Admin Area');
    });

    it('should extract regex match groups', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute(/^\/products\/(\d+)$/, (ctx, res) => {
                const productId = ctx.pathParams?.[1];
                return res.json({ productId });
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/products/999');
        const result = await handler(event, createMockContext());

        const body = JSON.parse(result.body || '{}');
        expect(body.productId).toBe('999');
    });

    it('should support complex regex patterns', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute(/^\/api\/v\d+/, (ctx, res) => {
                return res.json({ matched: true });
            });

        const handler = lambder.getHandler();
        
        const v1Result = await handler(createMockEvent('/api/v1'), createMockContext());
        expect(JSON.parse(v1Result.body || '{}').matched).toBe(true);

        const v2Result = await handler(createMockEvent('/api/v2'), createMockContext());
        expect(JSON.parse(v2Result.body || '{}').matched).toBe(true);
    });
});

describe('Routes - Function-based Conditional Routing', () => {
    it('should match routes using custom functions', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute((ctx) => ctx.path.startsWith('/custom'), (ctx, res) => {
                return res.html('Custom Route');
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/custom/anything');
        const result = await handler(event, createMockContext());

        expect(Buffer.from(result.body || '', 'base64').toString()).toBe('Custom Route');
    });

    it('should support complex conditional logic', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute(
                (ctx) => ctx.path === '/special' && ctx.get.key === 'secret',
                (ctx, res) => {
                    return res.html('Special Access');
                }
            );

        const handler = lambder.getHandler();
        
        // Without query param
        const event1 = createMockEvent('/special');
        const result1 = await handler(event1, createMockContext());
        expect(result1.statusCode).toBe(204); // Fallback

        // With query param
        const event2: APIGatewayProxyEvent = {
            ...createMockEvent('/special'),
            queryStringParameters: { key: 'secret' }
        };
        const result2 = await handler(event2, createMockContext());
        expect(Buffer.from(result2.body || '', 'base64').toString()).toBe('Special Access');
    });

    it('should access context variables in condition', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute(
                (ctx) => ctx.host === 'admin.example.com' && ctx.path === '/dashboard',
                (ctx, res) => {
                    return res.html('Admin Dashboard');
                }
            );

        const handler = lambder.getHandler();
        
        const event: APIGatewayProxyEvent = {
            ...createMockEvent('/dashboard'),
            headers: { Host: 'admin.example.com' }
        };
        const result = await handler(event, createMockContext());
        
        expect(Buffer.from(result.body || '', 'base64').toString()).toBe('Admin Dashboard');
    });
});

describe('Routes - Session Protected Routes', () => {
    beforeEach(() => {
        ddbMock.reset();
    });

    it('should protect routes with addSessionRoute', async () => {
        const mockSession = {
            pk: 'hash',
            sk: 'sortkey',
            sessionToken: 'hash:sortkey',
            csrfToken: 'csrf-token',
            sessionKey: 'user-123',
            data: { userId: '123', role: 'user' },
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            lastAccessedAt: Math.floor(Date.now() / 1000),
            ttlInSeconds: 3600,
        };

        ddbMock.on(GetCommand).resolves({ Item: mockSession });
        ddbMock.on(PutCommand).resolves({});

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .enableDdbSession(
                {
                    tableName: 'test-sessions',
                    tableRegion: 'us-east-1',
                    sessionSalt: 'test-salt',
                },
                { partitionKey: 'pk', sortKey: 'sk' }
            )
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.html(`<h1>Error: ${err.message}</h1>`);
            })
            .addSessionRoute('/protected', (ctx, res) => {
                return res.html(`Welcome ${ctx.session.data.userId}`);
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/protected', 'GET', 'hash:sortkey');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(200);
        expect(Buffer.from(result.body || '', 'base64').toString()).toContain('Welcome 123');
    });

    it('should reject access without valid session', async () => {
        ddbMock.on(GetCommand).resolves({}); // No session found

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .enableDdbSession(
                {
                    tableName: 'test-sessions',
                    tableRegion: 'us-east-1',
                    sessionSalt: 'test-salt',
                },
                { partitionKey: 'pk', sortKey: 'sk' }
            )
            .addSessionRoute('/protected', (ctx, res) => {
                return res.html('Protected');
            })
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.raw({ statusCode: 401, body: 'Unauthorized' });
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/protected', 'GET', 'invalid-token');
        const result = await handler(event, createMockContext());

        expect(result.statusCode).toBe(401);
    });

    it('should access session data in session routes', async () => {
        const mockSession = {
            pk: 'hash',
            sk: 'sortkey',
            sessionToken: 'hash:sortkey',
            csrfToken: 'csrf-token',
            sessionKey: 'user-456',
            data: { userId: '456', username: 'testuser', role: 'admin' },
            createdAt: Math.floor(Date.now() / 1000),
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            lastAccessedAt: Math.floor(Date.now() / 1000),
            ttlInSeconds: 3600,
        };

        ddbMock.on(GetCommand).resolves({ Item: mockSession });
        ddbMock.on(PutCommand).resolves({});

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .enableDdbSession(
                {
                    tableName: 'test-sessions',
                    tableRegion: 'us-east-1',
                    sessionSalt: 'test-salt',
                },
                { partitionKey: 'pk', sortKey: 'sk' }
            )
            .setGlobalErrorHandler((err, ctx, res) => {
                return res.json({ error: err.message });
            })
            .addSessionRoute('/profile', (ctx, res) => {
                return res.json({
                    sessionKey: ctx.session.sessionKey,
                    username: ctx.session.data.username,
                    role: ctx.session.data.role
                });
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/profile', 'GET', 'hash:sortkey');
        const result = await handler(event, createMockContext());

        const body = JSON.parse(result.body || '{}');
        expect(body.sessionKey).toBe('user-456');
        expect(body.username).toBe('testuser');
        expect(body.role).toBe('admin');
    });
});

describe('Routes - Priority and Ordering', () => {
    it('should match first defined route when multiple routes match', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute('/item', (ctx, res) => {
                return res.html('Exact Match');
            })
            .addRoute(/^\/item/, (ctx, res) => {
                return res.html('Regex Match');
            });

        const handler = lambder.getHandler();
        const event = createMockEvent('/item');
        const result = await handler(event, createMockContext());

        // First route should win
        expect(Buffer.from(result.body || '', 'base64').toString()).toBe('Exact Match');
    });

    it('should respect route definition order', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute('/users/admin', (ctx, res) => {
                return res.html('Admin User');
            })
            .addRoute('/users/:userId', (ctx, res) => {
                return res.html(`User ${ctx.pathParams?.userId}`);
            });

        const handler = lambder.getHandler();
        
        // Should match specific route first
        const adminResult = await handler(createMockEvent('/users/admin'), createMockContext());
        expect(Buffer.from(adminResult.body || '', 'base64').toString()).toBe('Admin User');

        // Should match parameterized route
        const userResult = await handler(createMockEvent('/users/123'), createMockContext());
        expect(Buffer.from(userResult.body || '', 'base64').toString()).toContain('User 123');
    });
});

describe('Routes - Wildcard and Catch-all Routes', () => {
    it('should support wildcard routes', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute('/(.*)', (ctx, res) => {
                return res.html('Catch All');
            });

        const handler = lambder.getHandler();
        
        const result1 = await handler(createMockEvent('/anything'), createMockContext());
        expect(Buffer.from(result1.body || '', 'base64').toString()).toBe('Catch All');

        const result2 = await handler(createMockEvent('/deeply/nested/path'), createMockContext());
        expect(Buffer.from(result2.body || '', 'base64').toString()).toBe('Catch All');
    });

    it('should use wildcard as final fallback', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute('/specific', (ctx, res) => {
                return res.html('Specific');
            })
            .addRoute('/(.*)', (ctx, res) => {
                return res.html('Fallback');
            });

        const handler = lambder.getHandler();
        
        const specificResult = await handler(createMockEvent('/specific'), createMockContext());
        expect(Buffer.from(specificResult.body || '', 'base64').toString()).toBe('Specific');

        const fallbackResult = await handler(createMockEvent('/anything-else'), createMockContext());
        expect(Buffer.from(fallbackResult.body || '', 'base64').toString()).toBe('Fallback');
    });
});

describe('Routes - Method Filtering', () => {
    it('should only match GET requests', async () => {
        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        })
            .addRoute('/resource', (ctx, res) => {
                return res.html('GET Response');
            });

        const handler = lambder.getHandler();
        
        // GET should work
        const getEvent = createMockEvent('/resource', 'GET');
        const getResult = await handler(getEvent, createMockContext());
        expect(Buffer.from(getResult.body || '', 'base64').toString()).toBe('GET Response');

        // POST should not match routes (should hit fallback)
        const postEvent = createMockEvent('/resource', 'POST');
        const postResult = await handler(postEvent, createMockContext());
        expect(postResult.statusCode).toBe(204); // Default fallback
    });
});
