/**
 * Type Safety Tests
 * 
 * This file tests that the type system works correctly.
 * If this file compiles without errors, the types are working!
 */

import Lambder from '../src/Lambder.js';
import LambderCaller from '../src/LambderCaller.js';
import type { ApiContract } from '../src/index.js';

// Test contract
type TestApiContract = {
    getUser: { input: { userId: string }, output: { id: string, name: string } },
    createUser: { input: { name: string, email: string }, output: { id: string, name: string, email: string } },
    listUsers: { input: void, output: Array<{ id: string, name: string }> },
    deleteUser: { input: { userId: string }, output: boolean }
}

// ============================================================================
// Test 1: LambderCaller Type Safety
// ============================================================================

function testCallerTypes() {
    const caller = new LambderCaller<TestApiContract>({
        apiPath: '/api',
        isCorsEnabled: false
    });

    async function test() {
        // ✅ Should work: Correct types
        const user1 = await caller.api('getUser', { userId: '123' });
        const user2 = await caller.api('createUser', { name: 'Alice', email: 'alice@example.com' });
        const users = await caller.api('listUsers', undefined);
        const deleted = await caller.api('deleteUser', { userId: '123' });

        // Type assertions to verify return types
        if (user1) {
            const name: string = user1.name; // Should work
            const id: string = user1.id; // Should work
        }

        if (user2) {
            const email: string = user2.email; // Should work
        }

        if (users) {
            const firstUser = users[0];
            if (firstUser) {
                const name: string = firstUser.name; // Should work
            }
        }

        if (deleted !== null && deleted !== undefined) {
            const result: boolean = deleted; // Should work
        }

        // ❌ These should cause TypeScript errors (commented out to allow compilation):
        
        // Wrong property name
        // await caller.api('getUser', { id: '123' }); // Error: should be userId
        
        // Missing required property
        // await caller.api('createUser', { name: 'Bob' }); // Error: missing email
        
        // Wrong type
        // await caller.api('getUser', { userId: 123 }); // Error: userId should be string
        
        // Non-existent API
        // await caller.api('nonExistent', {}); // Error: API doesn't exist
        
        // Wrong payload for void input
        // await caller.api('listUsers', { something: true }); // Error: should be undefined
    }
}

// ============================================================================
// Test 2: Lambder Type Safety
// ============================================================================

function testLambderTypes() {
    const lambder = new Lambder<TestApiContract>({
        publicPath: './public',
        apiPath: '/api'
    });

    // ✅ Should work: Typed API
    lambder.addApi('getUser', async (ctx, resolver) => {
        // ctx.apiPayload should be typed as { userId: string }
        const userId: string = ctx.apiPayload.userId; // Should work
        
        // Return correct type
        return resolver.api({ id: userId, name: 'Test' });
    });

    // ✅ Should work: Typed session API
    lambder.addSessionApi('createUser', async (ctx, resolver) => {
        // ctx.apiPayload should be typed as { name: string, email: string }
        const name: string = ctx.apiPayload.name;
        const email: string = ctx.apiPayload.email;
        
        return resolver.api({ id: '1', name, email });
    });

    // ✅ Should work: Void input API
    lambder.addApi('listUsers', async (ctx, resolver) => {
        // ctx.apiPayload should be void/undefined
        return resolver.api([
            { id: '1', name: 'User 1' },
            { id: '2', name: 'User 2' }
        ]);
    });

    // ✅ Should work: RegExp (untyped)
    lambder.addApi(/^admin\./, async (ctx, resolver) => {
        // ctx.apiPayload is any (untyped)
        return resolver.api({});
    });

    // ❌ These should cause TypeScript errors (commented out):
    
    // Accessing wrong property
    // lambder.addApi('getUser', async (ctx, resolver) => {
    //     const id = ctx.apiPayload.id; // Error: should be userId
    //     return resolver.api({ id, name: 'Test' });
    // });
    
    // Returning wrong type
    // lambder.addApi('getUser', async (ctx, resolver) => {
    //     return resolver.api({ id: '1' }); // Error: missing name property
    // });
}

// ============================================================================
// Test 3: Backward Compatibility (No Contract)
// ============================================================================

function testBackwardCompatibility() {
    // Without contract type - should work as before (untyped)
    const caller = new LambderCaller({
        apiPath: '/api',
        isCorsEnabled: false
    });

    const lambder = new Lambder({
        publicPath: './public',
        apiPath: '/api'
    });

    async function test() {
        // Should work - untyped
        const result = await caller.api('anyApi', { anything: true });
        
        lambder.addApi('anyApi', async (ctx, resolver) => {
            // ctx.apiPayload is any
            return resolver.api({ anything: ctx.apiPayload });
        });
    }
}

// ============================================================================
// Test 4: apiRaw Method
// ============================================================================

function testApiRaw() {
    const caller = new LambderCaller<TestApiContract>({
        apiPath: '/api',
        isCorsEnabled: false
    });

    async function test() {
        // apiRaw should also be typed
        const response = await caller.apiRaw('getUser', { userId: '123' });
        
        if (response) {
            // response.payload should be typed
            const user = response.payload;
            if (user) {
                const name: string = user.name; // Should work
                const id: string = user.id; // Should work
            }
        }
    }
}

// ============================================================================
// Test 5: Complex Types
// ============================================================================

type ComplexApiContract = {
    update: { 
        input: { id: string } & Partial<{ name: string, email: string }>, 
        output: { id: string, name: string, email: string } 
    },
    search: { 
        input: { query: string, filters?: { role?: string, active?: boolean } }, 
        output: Array<{ id: string, name: string }> 
    }
}

function testComplexTypes() {
    const caller = new LambderCaller<ComplexApiContract>({
        apiPath: '/api',
        isCorsEnabled: false
    });

    async function test() {
        // Should work with partial update
        await caller.api('update', { id: '1', name: 'New Name' });
        await caller.api('update', { id: '1', email: 'new@email.com' });
        await caller.api('update', { id: '1' }); // Only id

        // Should work with optional nested object
        await caller.api('search', { query: 'test' });
        await caller.api('search', { query: 'test', filters: { role: 'admin' } });
        await caller.api('search', { query: 'test', filters: { role: 'admin', active: true } });
    }
}

// ============================================================================
// If this file compiles without errors, the type system is working! ✅
// ============================================================================

export { };
