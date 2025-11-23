/**
 * LambderMSW Testing Example
 * 
 * This example shows how to use LambderMSW with MSW (Mock Service Worker)
 * to test your Lambder APIs with full type safety.
 * 
 * To run this example:
 * 1. Install MSW: npm install msw --save-dev
 * 2. Install a test runner: npm install vitest --save-dev
 * 3. Create this file in your test directory
 * 
 * NOTE: This is an example file. Type errors are expected since dependencies
 * may not be installed in the examples directory. Copy this to your project's
 * test directory to use it.
 */

// @ts-nocheck - Example file, types may not be available
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import { LambderMSW, LambderCaller } from '../src/index.ts';
import Lambder from '../src/Lambder.js';

// Define your API contract using Lambder chaining
const lambder = new Lambder()
    .addApi('getUserById', {
        input: z.object({ userId: z.string() }),
        output: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable()
    }, async () => ({} as any)) // Dummy handler for type inference
    .addApi('createUser', {
        input: z.object({ name: z.string(), email: z.string() }),
        output: z.object({ id: z.string(), name: z.string(), email: z.string() })
    }, async () => ({} as any))
    .addApi('getUsers', {
        input: z.object({ limit: z.number().optional() }),
        output: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() }))
    }, async () => ({} as any))
    .addApi('deleteUser', {
        input: z.object({ userId: z.string() }),
        output: z.object({ success: z.boolean() })
    }, async () => ({} as any));

type TestApiContract = typeof lambder.ApiContract;

// Setup LambderMSW with type safety
const lambderMSW = new LambderMSW<TestApiContract>({
    apiPath: '/secure',
    apiVersion: '1.0.0',
});

// Create mock handlers
const handlers = [
    // Mock getUserById - returns user or null
    lambderMSW.mockApi('getUserById', async (payload) => {
        const users: Record<string, { id: string; name: string; email: string }> = {
            '1': { id: '1', name: 'John Doe', email: 'john@example.com' },
            '2': { id: '2', name: 'Jane Smith', email: 'jane@example.com' },
        };
        
        return users[payload?.userId || ''] || null;
    }),

    // Mock createUser - simulates creating a user
    lambderMSW.mockApi('createUser', async (payload) => {
        return {
            id: Math.random().toString(36).substring(7),
            name: payload?.name || '',
            email: payload?.email || '',
        };
    }, { 
        delay: 100, // Simulate 100ms network delay
        message: 'User created successfully'
    }),

    // Mock getUsers - returns a list of users
    lambderMSW.mockApi('getUsers', async (payload) => {
        const allUsers = [
            { id: '1', name: 'John Doe', email: 'john@example.com' },
            { id: '2', name: 'Jane Smith', email: 'jane@example.com' },
            { id: '3', name: 'Bob Johnson', email: 'bob@example.com' },
        ];
        
        const limit = payload?.limit || 10;
        return allUsers.slice(0, limit);
    }),

    // Mock deleteUser - simulate authorization error
    lambderMSW.mockNotAuthorized('deleteUser'),
];

// Setup MSW server
const server = setupServer(...handlers);

// Setup LambderCaller
const lambderCaller = new LambderCaller<TestApiContract>({
    apiPath: '/secure',
    isCorsEnabled: false,
});

// Test suite
describe('LambderMSW Testing Example', () => {
    beforeAll(() => {
        server.listen({ onUnhandledRequest: 'error' });
    });

    afterEach(() => {
        server.resetHandlers();
    });

    afterAll(() => {
        server.close();
    });

    it('should fetch user by id', async () => {
        const user = await lambderCaller.api('getUserById', { userId: '1' });
        
        expect(user).toEqual({
            id: '1',
            name: 'John Doe',
            email: 'john@example.com',
        });
    });

    it('should return null for non-existent user', async () => {
        const user = await lambderCaller.api('getUserById', { userId: '999' });
        
        expect(user).toBeNull();
    });

    it('should create a new user with delay', async () => {
        const startTime = Date.now();
        
        const newUser = await lambderCaller.api('createUser', {
            name: 'Alice Wonder',
            email: 'alice@example.com',
        });
        
        const endTime = Date.now();
        
        expect(newUser?.name).toBe('Alice Wonder');
        expect(newUser?.email).toBe('alice@example.com');
        expect(newUser?.id).toBeDefined();
        
        // Check that delay was applied (at least 100ms)
        expect(endTime - startTime).toBeGreaterThanOrEqual(100);
    });

    it('should fetch list of users', async () => {
        const users = await lambderCaller.api('getUsers', { limit: 2 });
        
        expect(users).toHaveLength(2);
        expect(users?.[0]?.name).toBe('John Doe');
        expect(users?.[1]?.name).toBe('Jane Smith');
    });

    it('should handle authorization error', async () => {
        let errorCaught = false;
        
        try {
            await lambderCaller.api('deleteUser', { userId: '1' });
        } catch (error: any) {
            errorCaught = true;
            expect(error.notAuthorized).toBe(true);
        }
        
        expect(errorCaught).toBe(true);
    });

    it('should override handler for specific test', async () => {
        // Override the getUserById handler for this test only
        server.use(
            lambderMSW.mockApi('getUserById', async (payload) => {
                return {
                    id: payload?.userId || '',
                    name: 'Override User',
                    email: 'override@example.com',
                };
            })
        );

        const user = await lambderCaller.api('getUserById', { userId: '999' });
        
        expect(user?.name).toBe('Override User');
    });

    it('should simulate session expired', async () => {
        // Add a handler that simulates session expiration
        server.use(
            lambderMSW.mockSessionExpired('getUserById')
        );

        let errorCaught = false;
        
        try {
            await lambderCaller.api('getUserById', { userId: '1' });
        } catch (error: any) {
            errorCaught = true;
            expect(error.sessionExpired).toBe(true);
        }
        
        expect(errorCaught).toBe(true);
    });

    it('should simulate custom error', async () => {
        server.use(
            lambderMSW.mockError('createUser', 'Email already exists')
        );

        let errorCaught = false;
        
        try {
            await lambderCaller.api('createUser', {
                name: 'Duplicate',
                email: 'john@example.com',
            });
        } catch (error: any) {
            errorCaught = true;
            expect(error.errorMessage).toBe('Email already exists');
        }
        
        expect(errorCaught).toBe(true);
    });
});

// Example: Testing with dynamic responses
describe('Dynamic Response Testing', () => {
    beforeAll(() => server.listen());
    afterEach(() => server.resetHandlers());
    afterAll(() => server.close());

    it('should handle different query parameters', async () => {
        server.use(
            lambderMSW.mockApi('getUsers', async (payload) => {
                const limit = payload?.limit || 10;
                
                // Generate mock users based on limit
                return Array.from({ length: limit }, (_, i) => ({
                    id: `${i + 1}`,
                    name: `User ${i + 1}`,
                    email: `user${i + 1}@example.com`,
                }));
            })
        );

        const users3 = await lambderCaller.api('getUsers', { limit: 3 });
        expect(users3).toHaveLength(3);

        const users5 = await lambderCaller.api('getUsers', { limit: 5 });
        expect(users5).toHaveLength(5);
    });
});

// Example: Testing error conditions
describe('Error Handling', () => {
    beforeAll(() => server.listen());
    afterEach(() => server.resetHandlers());
    afterAll(() => server.close());

    it('should handle handler throwing error', async () => {
        server.use(
            lambderMSW.mockApi('getUserById', async () => {
                throw new Error('Database connection failed');
            })
        );

        let errorCaught = false;
        
        try {
            await lambderCaller.api('getUserById', { userId: '1' });
        } catch (error: any) {
            errorCaught = true;
            expect(error.errorMessage).toBe('Database connection failed');
        }
        
        expect(errorCaught).toBe(true);
    });
});

console.log('✅ LambderMSW example tests configured!');
console.log('📖 See docs/LAMBDER_MSW.md for more information');
