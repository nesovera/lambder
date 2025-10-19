/**
 * Simplified Type-Safe API Example
 * 
 * This example shows how to use Lambder's opt-in type-safe API system.
 * Simply pass your API contract type to LambderCaller and Lambder constructors,
 * and get full type safety with no extra wrapper functions needed!
 */

import Lambder from '../src/Lambder.js';
import LambderCaller from '../src/LambderCaller.js';
import type { ApiContract } from '../src/index.js';

// ============================================================================
// Step 1: Define your data types
// ============================================================================

type User = {
    id: string;
    name: string;
    email: string;
    role: 'admin' | 'user';
    createdAt: string;
};

type CreateUserInput = {
    name: string;
    email: string;
    password: string;
};

type UpdateUserInput = {
    userId: string;
    name?: string;
    email?: string;
};

type LoginInput = {
    email: string;
    password: string;
};

type LoginOutput = {
    success: boolean;
    user?: User;
    token?: string;
    error?: string;
};

// ============================================================================
// Step 2: Define your API contract (shared between frontend and backend)
// ============================================================================

export type MyApiContract = {
    // API with input and output
    getUserById: { input: { userId: string }, output: User },
    
    // API with complex input/output
    createUser: { input: CreateUserInput, output: User },
    updateUser: { input: UpdateUserInput, output: User },
    
    // API with void input (no parameters needed)
    listUsers: { input: void, output: User[] },
    getCurrentUser: { input: void, output: User },
    
    // API with conditional output
    login: { input: LoginInput, output: LoginOutput },
    
    // API with primitive output
    getUserCount: { input: void, output: number },
    deleteUser: { input: { userId: string }, output: boolean },
}

// ============================================================================
// Step 3: Backend - Pass contract type to Lambder
// ============================================================================

export function setupBackend() {
    // Pass the contract type as a generic parameter
    const lambder = new Lambder<MyApiContract>({
        publicPath: './public',
        apiPath: '/api',
        apiVersion: '1.0.0',
    });

    // Now addApi is type-safe! ctx.apiPayload is automatically typed!
    lambder.addApi('getUserById', async (ctx, resolver) => {
        // ctx.apiPayload is typed as { userId: string }
        const userId = ctx.apiPayload.userId; // ✅ TypeScript knows this!
        
        // Mock database call
        const user: User = {
            id: userId,
            name: 'John Doe',
            email: 'john@example.com',
            role: 'user',
            createdAt: new Date().toISOString(),
        };
        
        return resolver.api(user);
    });

    // Session API with typed payload
    lambder.addSessionApi('createUser', async (ctx, resolver) => {
        // ctx.apiPayload is typed as CreateUserInput
        const { name, email, password } = ctx.apiPayload;
        
        // Validation with type safety
        if (!name || !email || !password) {
            return resolver.api(null, {
                errorMessage: 'Missing required fields'
            });
        }
        
        // Create user
        const newUser: User = {
            id: Math.random().toString(36).substr(2, 9),
            name,
            email,
            role: 'user',
            createdAt: new Date().toISOString(),
        };
        
        return resolver.api(newUser);
    });

    // API with void input
    lambder.addApi('listUsers', async (ctx, resolver) => {
        // ctx.apiPayload is void/undefined
        const users: User[] = [
            { id: '1', name: 'John', email: 'john@example.com', role: 'user', createdAt: new Date().toISOString() },
            { id: '2', name: 'Jane', email: 'jane@example.com', role: 'admin', createdAt: new Date().toISOString() },
        ];
        
        return resolver.api(users);
    });

    // Complex API with conditional response
    lambder.addApi('login', async (ctx, resolver) => {
        // ctx.apiPayload is typed as LoginInput
        const { email, password } = ctx.apiPayload;
        
        // Mock authentication
        if (email === 'test@example.com' && password === 'password123') {
            const result: LoginOutput = {
                success: true,
                user: {
                    id: '1',
                    name: 'Test User',
                    email: email,
                    role: 'user',
                    createdAt: new Date().toISOString(),
                },
                token: 'mock-jwt-token',
            };
            return resolver.api(result);
        } else {
            const result: LoginOutput = {
                success: false,
                error: 'Invalid credentials',
            };
            return resolver.api(result);
        }
    });

    // You can still use RegExp or functions for dynamic patterns (untyped)
    lambder.addApi(/^admin\./, async (ctx, resolver) => {
        // ctx.apiPayload is any (untyped)
        return resolver.api({ message: 'Admin API' });
    });

    return lambder;
}

// ============================================================================
// Step 4: Frontend - Pass contract type to LambderCaller
// ============================================================================

export function setupFrontend() {
    // Pass the contract type as a generic parameter
    const caller = new LambderCaller<MyApiContract>({
        apiPath: '/api',
        apiVersion: '1.0.0',
        isCorsEnabled: false,
        errorHandler: (err) => {
            console.error('API Error:', err);
        },
    });

    // Now all API calls are type-safe!
    
    // Example 1: Get user by ID
    async function example1() {
        // TypeScript knows:
        // - First parameter is 'getUserById' (autocomplete shows all API names!)
        // - Second parameter must be { userId: string }
        // - Return type is User | null | undefined
        const user = await caller.api('getUserById', { userId: '123' });
        
        if (user) {
            console.log(user.name); // ✅ TypeScript knows 'name' exists
            console.log(user.email); // ✅ TypeScript knows 'email' exists
            console.log(user.role); // ✅ TypeScript knows 'role' is 'admin' | 'user'
            // console.log(user.age); // ✗ Error: Property 'age' does not exist
        }
    }

    // Example 2: Create user
    async function example2() {
        // TypeScript enforces the CreateUserInput type
        const newUser = await caller.api('createUser', {
            name: 'Alice',
            email: 'alice@example.com',
            password: 'secret123',
        });
        
        if (newUser) {
            console.log('Created user:', newUser.id);
        }
        
        // This would be a TypeScript error:
        // await caller.api('createUser', { name: 'Bob' }); // ✗ Missing email and password
    }

    // Example 3: Login
    async function example3() {
        const result = await caller.api('login', {
            email: 'test@example.com',
            password: 'password123',
        });
        
        if (result?.success && result.user) {
            console.log('Logged in as:', result.user.name);
            console.log('Token:', result.token);
        } else {
            console.error('Login failed:', result?.error);
        }
    }

    // Example 4: List users (void input)
    async function example4() {
        // For void input, pass undefined
        const users = await caller.api('listUsers', undefined);
        
        if (users) {
            users.forEach(user => {
                console.log(user.name); // ✅ TypeScript knows the array type
            });
        }
    }

    // Example 5: Get user count (primitive output)
    async function example5() {
        const count = await caller.api('getUserCount', undefined);
        if (count !== null && count !== undefined) {
            console.log(`Total users: ${count}`); // count is number
        }
    }

    // Example 6: With custom headers
    async function example6() {
        const user = await caller.api(
            'getUserById',
            { userId: '456' },
            { headers: { 'X-Custom-Header': 'value' } }
        );
    }

    // Example 7: Using apiRaw for full response
    async function example7() {
        const response = await caller.apiRaw('getUserById', { userId: '123' });
        
        if (response) {
            console.log('Payload:', response.payload); // User | null
            if (response.logList) {
                console.log('Logs:', response.logList);
            }
            if (response.errorMessage) {
                console.error('Error:', response.errorMessage);
            }
        }
    }

    return caller;
}

// ============================================================================
// Without Contract (Backward Compatibility)
// ============================================================================

export function setupWithoutContract() {
    // If you don't pass a contract type, it works like before (untyped)
    const caller = new LambderCaller({
        apiPath: '/api',
        isCorsEnabled: false,
    });

    // Still works, but no type safety
    async function untypedExample() {
        const user = await caller.api('getUserById', { userId: '123' });
        // user is any
    }

    const lambder = new Lambder({
        publicPath: './public',
        apiPath: '/api',
    });

    // Still works, but no type safety
    lambder.addApi('getUserById', async (ctx, resolver) => {
        // ctx.apiPayload is any
        const user = { id: ctx.apiPayload.userId, name: 'User' };
        return resolver.api(user);
    });
}

// ============================================================================
// Type Safety Examples
// ============================================================================

export function typeSafetyExamples() {
    const caller = new LambderCaller<MyApiContract>({ apiPath: '/api', isCorsEnabled: false });

    async function examples() {
        // ✓ VALID:
        await caller.api('getUserById', { userId: '123' });
        await caller.api('createUser', { name: 'Alice', email: 'alice@example.com', password: 'pass' });
        await caller.api('listUsers', undefined);

        // ✗ ERRORS (TypeScript prevents):
        // await caller.api('getUserById'); // Missing required payload
        // await caller.api('getUserById', { id: '123' }); // Wrong property name (should be userId)
        // await caller.api('createUser', { name: 'Bob' }); // Missing email and password
        // await caller.api('nonExistentApi', {}); // API doesn't exist in contract
        
        // Type inference works:
        const user = await caller.api('getUserById', { userId: '123' });
        if (user) {
            console.log(user.name); // ✓ TypeScript knows user has name
            // console.log(user.age); // ✗ Error: Property 'age' does not exist
        }

        const users = await caller.api('listUsers', undefined);
        if (users) {
            users.forEach(u => {
                console.log(u.email); // ✓ TypeScript knows array item structure
            });
        }
    }
}

// ============================================================================
// Key Benefits
// ============================================================================
// 
// 1. ✅ Type Safety - Frontend and backend share the same types
// 2. ✅ Autocomplete - IDE suggests available APIs as you type
// 3. ✅ No Wrappers - Use existing api() and addApi() methods
// 4. ✅ Opt-In - Add types when you want, or don't use them at all
// 5. ✅ Backward Compatible - Existing code works without changes
// 6. ✅ Simple - Just pass type to constructor, that's it!
// 7. ✅ Zero Runtime Overhead - Pure TypeScript types
//
// ============================================================================

export { Lambder, LambderCaller, type ApiContract };
