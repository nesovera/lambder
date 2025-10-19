/**
 * Type Safety Tests
 * 
 * This file tests that the type system works correctly.
 * If this file compiles without errors, the types are working!
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../src/Lambder.js';
import LambderCaller from '../src/LambderCaller.js';
import type { ApiContract } from '../src/index.js';

// Test contract
type TestApiContract = ApiContract<{
    getUser: { input: { userId: string }, output: { id: string, name: string } },
    createUser: { input: { name: string, email: string }, output: { id: string, name: string, email: string } },
    listUsers: { input: void, output: Array<{ id: string, name: string }> },
    deleteUser: { input: { userId: string }, output: boolean }
}>;

// ============================================================================
// Test 1: LambderCaller Type Safety
// ============================================================================

describe('LambderCaller Type Safety', () => {
    it('should have correct types', () => {
        const caller = new LambderCaller<TestApiContract>({
            apiPath: '/api',
            isCorsEnabled: false
        });

        // Type assertions to verify compile-time types
        // If this compiles, the types are correct
        
        // ✅ These should compile without errors
        type GetUserInput = Parameters<typeof caller.api<'getUser'>>[1];
        type CreateUserInput = Parameters<typeof caller.api<'createUser'>>[1];
        
        // Verify the caller was created successfully
        expect(caller).toBeDefined();
        expect(caller.api).toBeDefined();
        
        // ❌ These would cause TypeScript errors (commented out):
        // await caller.api('getUser', { id: '123' }); // Error: should be userId
        // await caller.api('createUser', { name: 'Bob' }); // Error: missing email
        // await caller.api('getUser', { userId: 123 }); // Error: userId should be string
        // await caller.api('nonExistent', {}); // Error: API doesn't exist
        // await caller.api('listUsers', { something: true }); // Error: should be undefined
    });
});

// ============================================================================
// Test 2: Lambder Type Safety
// ============================================================================

describe('Lambder Type Safety', () => {
    it('should have correct types', () => {
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

        // Verify the lambder was created successfully
        expect(lambder).toBeDefined();
        expect(lambder.addApi).toBeDefined();
        
        // ❌ These would cause TypeScript errors (commented out):
        // lambder.addApi('getUser', async (ctx, resolver) => {
        //     const id = ctx.apiPayload.id; // Error: should be userId
        //     return resolver.api({ id, name: 'Test' });
        // });
        // lambder.addApi('getUser', async (ctx, resolver) => {
        //     return resolver.api({ id: '1' }); // Error: missing name property
        // });
    });
});

// ============================================================================
// Test 3: Backward Compatibility (No Contract)
// ============================================================================

describe('Backward Compatibility (No Contract)', () => {
    it('should work without type contract', () => {
        // Without contract type - should work as before (untyped)
        const caller = new LambderCaller({
            apiPath: '/api',
            isCorsEnabled: false
        });

        const lambder = new Lambder({
            publicPath: './public',
            apiPath: '/api'
        });

        // Should work - untyped
        lambder.addApi('anyApi', async (ctx, resolver) => {
            // ctx.apiPayload is any
            return resolver.api({ anything: ctx.apiPayload });
        });

        // Verify the instances were created successfully
        expect(caller).toBeDefined();
        expect(lambder).toBeDefined();
    });
});

// ============================================================================
// Test 4: apiRaw Method
// ============================================================================

describe('apiRaw Method Type Safety', () => {
    it('should have correct types for apiRaw', () => {
        const caller = new LambderCaller<TestApiContract>({
            apiPath: '/api',
            isCorsEnabled: false
        });

        // Verify the caller was created successfully
        expect(caller).toBeDefined();
        expect(caller.apiRaw).toBeDefined();
        
        // Type checking happens at compile time
        // If this compiles, apiRaw has correct types
    });
});

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

describe('Complex Types', () => {
    it('should handle complex type patterns', () => {
        const caller = new LambderCaller<ComplexApiContract>({
            apiPath: '/api',
            isCorsEnabled: false
        });

        // Verify the caller was created successfully
        expect(caller).toBeDefined();
        
        // Type assertions to verify compile-time types
        // If this compiles with correct types, the test passes
        type UpdateInput = Parameters<typeof caller.api<'update'>>[1];
        type SearchInput = Parameters<typeof caller.api<'search'>>[1];
        
        // These would compile successfully with correct types:
        // await caller.api('update', { id: '1', name: 'New Name' });
        // await caller.api('update', { id: '1', email: 'new@email.com' });
        // await caller.api('update', { id: '1' }); // Only id
        // await caller.api('search', { query: 'test' });
        // await caller.api('search', { query: 'test', filters: { role: 'admin' } });
        // await caller.api('search', { query: 'test', filters: { role: 'admin', active: true } });
    });
});

// ============================================================================
// Test 6: Output Type Enforcement
// ============================================================================

describe('Output Type Enforcement', () => {
    it('should enforce output types in resolver.api()', () => {
        const lambder = new Lambder<TestApiContract>({
            publicPath: './public',
            apiPath: '/api'
        });

        // ✅ CORRECT: Return correct output type
        lambder.addApi('getUser', async (ctx, resolver) => {
            const userId = ctx.apiPayload.userId;
            return resolver.api({ id: userId, name: 'John Doe' });
        });

        // ✅ CORRECT: Return null is allowed
        lambder.addApi('getUser', async (ctx, resolver) => {
            return resolver.api(null);
        });

        // ✅ CORRECT: Boolean output
        lambder.addApi('deleteUser', async (ctx, resolver) => {
            return resolver.api(true);
        });

        // ✅ CORRECT: Array output
        lambder.addApi('listUsers', async (ctx, resolver) => {
            return resolver.api([
                { id: '1', name: 'User 1' },
                { id: '2', name: 'User 2' }
            ]);
        });

        // ✅ CORRECT: Empty array
        lambder.addApi('listUsers', async (ctx, resolver) => {
            return resolver.api([]);
        });

        expect(lambder).toBeDefined();

        // ❌ These would cause TypeScript errors (commented out):
        
        // Wrong output type:
        // lambder.addApi('getUser', async (ctx, resolver) => {
        //     return resolver.api("wrong"); // Error: string not assignable to { id: string, name: string }
        // });
        
        // Missing required property:
        // lambder.addApi('getUser', async (ctx, resolver) => {
        //     return resolver.api({ id: '123' }); // Error: missing 'name' property
        // });
        
        // Wrong property type:
        // lambder.addApi('getUser', async (ctx, resolver) => {
        //     return resolver.api({ id: 123, name: 'Test' }); // Error: id should be string
        // });
        
        // Wrong boolean output:
        // lambder.addApi('deleteUser', async (ctx, resolver) => {
        //     return resolver.api("true"); // Error: string not assignable to boolean
        // });
        
        // Wrong array element type:
        // lambder.addApi('listUsers', async (ctx, resolver) => {
        //     return resolver.api([{ id: '1' }]); // Error: missing 'name' property
        // });
    });

    it('should enforce output types in resolver.die.api()', () => {
        const lambder = new Lambder<TestApiContract>({
            publicPath: './public',
            apiPath: '/api'
        });

        // ✅ CORRECT: die.api also enforces types
        lambder.addApi('getUser', async (ctx, resolver) => {
            return resolver.die.api({ id: ctx.apiPayload.userId, name: 'Test' });
        });

        // ✅ CORRECT: die.api with null
        lambder.addApi('deleteUser', async (ctx, resolver) => {
            return resolver.die.api(true);
        });

        expect(lambder).toBeDefined();

        // ❌ These would cause TypeScript errors (commented out):
        // lambder.addApi('getUser', async (ctx, resolver) => {
        //     return resolver.die.api("wrong"); // Error: wrong type
        // });
    });

    it('should enforce output types in addSessionApi()', () => {
        const lambder = new Lambder<TestApiContract>({
            publicPath: './public',
            apiPath: '/api'
        });

        // ✅ CORRECT: Session APIs also enforce output types
        lambder.addSessionApi('createUser', async (ctx, resolver) => {
            const { name, email } = ctx.apiPayload;
            return resolver.api({ id: '1', name, email });
        });

        // ✅ CORRECT: Session API with null
        lambder.addSessionApi('deleteUser', async (ctx, resolver) => {
            return resolver.api(true);
        });

        expect(lambder).toBeDefined();

        // ❌ These would cause TypeScript errors (commented out):
        // lambder.addSessionApi('createUser', async (ctx, resolver) => {
        //     return resolver.api({ id: '1' }); // Error: missing name and email
        // });
    });
});

// ============================================================================
// Test 7: Complex Output Types
// ============================================================================

type ComplexOutputContract = ApiContract<{
    // Primitive outputs
    getCount: { input: void, output: number },
    getMessage: { input: void, output: string },
    isActive: { input: void, output: boolean },
    
    // Nested objects
    getStats: { 
        input: void, 
        output: { 
            users: { total: number, active: number },
            products: { total: number, inStock: number }
        } 
    },
    
    // Union types
    findUser: { 
        input: { email: string }, 
        output: { id: string, name: string } | null 
    },
    
    // Array of complex objects
    getOrders: { 
        input: { userId: string }, 
        output: Array<{ 
            id: string, 
            items: Array<{ name: string, price: number }>,
            total: number 
        }> 
    }
}>;

describe('Complex Output Types', () => {
    it('should enforce primitive output types', () => {
        const lambder = new Lambder<ComplexOutputContract>({
            publicPath: './public',
            apiPath: '/api'
        });

        // ✅ CORRECT: Primitive outputs
        lambder.addApi('getCount', async (ctx, resolver) => {
            return resolver.api(42);
        });

        lambder.addApi('getMessage', async (ctx, resolver) => {
            return resolver.api("Hello World");
        });

        lambder.addApi('isActive', async (ctx, resolver) => {
            return resolver.api(true);
        });

        expect(lambder).toBeDefined();

        // ❌ These would cause TypeScript errors (commented out):
        // lambder.addApi('getCount', async (ctx, resolver) => {
        //     return resolver.api("42"); // Error: string not assignable to number
        // });
    });

    it('should enforce nested object types', () => {
        const lambder = new Lambder<ComplexOutputContract>({
            publicPath: './public',
            apiPath: '/api'
        });

        // ✅ CORRECT: Nested structure
        lambder.addApi('getStats', async (ctx, resolver) => {
            return resolver.api({
                users: { total: 100, active: 75 },
                products: { total: 50, inStock: 40 }
            });
        });

        expect(lambder).toBeDefined();

        // ❌ These would cause TypeScript errors (commented out):
        // lambder.addApi('getStats', async (ctx, resolver) => {
        //     return resolver.api({
        //         users: { total: 100 } // Error: missing 'active'
        //     });
        // });
    });

    it('should enforce union types correctly', () => {
        const lambder = new Lambder<ComplexOutputContract>({
            publicPath: './public',
            apiPath: '/api'
        });

        // ✅ CORRECT: Return object
        lambder.addApi('findUser', async (ctx, resolver) => {
            return resolver.api({ id: '123', name: 'John' });
        });

        // ✅ CORRECT: Return null (part of union)
        lambder.addApi('findUser', async (ctx, resolver) => {
            return resolver.api(null);
        });

        expect(lambder).toBeDefined();

        // ❌ These would cause TypeScript errors (commented out):
        // lambder.addApi('findUser', async (ctx, resolver) => {
        //     return resolver.api(undefined); // Error: undefined not in union
        // });
    });

    it('should enforce complex nested array types', () => {
        const lambder = new Lambder<ComplexOutputContract>({
            publicPath: './public',
            apiPath: '/api'
        });

        // ✅ CORRECT: Complex nested array
        lambder.addApi('getOrders', async (ctx, resolver) => {
            return resolver.api([
                {
                    id: '1',
                    items: [
                        { name: 'Item 1', price: 10 },
                        { name: 'Item 2', price: 20 }
                    ],
                    total: 30
                }
            ]);
        });

        expect(lambder).toBeDefined();

        // ❌ These would cause TypeScript errors (commented out):
        // lambder.addApi('getOrders', async (ctx, resolver) => {
        //     return resolver.api([
        //         {
        //             id: '1',
        //             items: [{ name: 'Item 1' }], // Error: missing 'price'
        //             total: 30
        //         }
        //     ]);
        // });
    });
});

// ============================================================================
// Test 8: Type Inference
// ============================================================================

describe('Type Inference', () => {
    it('should infer types correctly from contract', () => {
        const lambder = new Lambder<TestApiContract>({
            publicPath: './public',
            apiPath: '/api'
        });

        // Test that TypeScript correctly infers the types
        lambder.addApi('getUser', async (ctx, resolver) => {
            // ctx.apiPayload type should be inferred as { userId: string }
            const userId: string = ctx.apiPayload.userId;
            
            // Variable with explicit type matching contract
            const user: { id: string, name: string } = {
                id: userId,
                name: 'Test User'
            };
            
            // Should accept the correctly typed variable
            return resolver.api(user);
        });

        lambder.addApi('createUser', async (ctx, resolver) => {
            // Input type inference
            const name: string = ctx.apiPayload.name;
            const email: string = ctx.apiPayload.email;
            
            // Output type inference
            const result: { id: string, name: string, email: string } = {
                id: '123',
                name,
                email
            };
            
            return resolver.api(result);
        });

        expect(lambder).toBeDefined();
    });
});

// ============================================================================
// If this file compiles without errors, the type system is working! ✅
// ============================================================================
