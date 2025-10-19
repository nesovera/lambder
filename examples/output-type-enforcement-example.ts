/**
 * Output Type Enforcement Example
 * 
 * This example demonstrates how Lambder now enforces output types
 * in addition to input types for type-safe APIs.
 */

import Lambder from '../src/Lambder.js';
import type { ApiContract } from '../src/index.js';

// ============================================================================
// Define Types
// ============================================================================

type User = {
    id: string;
    name: string;
    email: string;
    age: number;
};

type Product = {
    id: string;
    name: string;
    price: number;
    inStock: boolean;
};

type Stats = {
    totalUsers: number;
    totalProducts: number;
    revenue: number;
};

// ============================================================================
// Define API Contract
// ============================================================================

type MyApiContract = ApiContract<{
    // Simple primitive outputs
    getCount: { input: void, output: number },
    getMessage: { input: { id: string }, output: string },
    isActive: { input: void, output: boolean },
    
    // Complex object outputs
    getUser: { input: { userId: string }, output: User },
    getProduct: { input: { productId: string }, output: Product },
    
    // Array outputs
    listUsers: { input: void, output: User[] },
    listProducts: { input: { category: string }, output: Product[] },
    
    // Complex nested outputs
    getStats: { input: void, output: Stats },
    
    // Nullable outputs
    findUser: { input: { email: string }, output: User | null },
}>;

// ============================================================================
// Setup Backend with Type Enforcement
// ============================================================================

const lambder = new Lambder<MyApiContract>({
    publicPath: './public',
    apiPath: '/api',
});

// ✅ EXAMPLE 1: Simple primitive outputs are enforced
lambder.addApi('getCount', async (ctx, resolver) => {
    const count = 42;
    return resolver.api(count); // ✅ TypeScript validates this is a number
});

lambder.addApi('getMessage', async (ctx, resolver) => {
    const message = `Message for ${ctx.apiPayload.id}`;
    return resolver.api(message); // ✅ TypeScript validates this is a string
});

lambder.addApi('isActive', async (ctx, resolver) => {
    const active = true;
    return resolver.api(active); // ✅ TypeScript validates this is a boolean
});

// ✅ EXAMPLE 2: Complex objects must match the shape
lambder.addApi('getUser', async (ctx, resolver) => {
    const user: User = {
        id: ctx.apiPayload.userId,
        name: "John Doe",
        email: "john@example.com",
        age: 30,
    };
    return resolver.api(user); // ✅ All required fields are present
});

lambder.addApi('getProduct', async (ctx, resolver) => {
    const product: Product = {
        id: ctx.apiPayload.productId,
        name: "Widget",
        price: 99.99,
        inStock: true,
    };
    return resolver.api(product); // ✅ Correct shape
});

// ✅ EXAMPLE 3: Arrays are type-checked
lambder.addApi('listUsers', async (ctx, resolver) => {
    const users: User[] = [
        { id: "1", name: "Alice", email: "alice@example.com", age: 25 },
        { id: "2", name: "Bob", email: "bob@example.com", age: 30 },
    ];
    return resolver.api(users); // ✅ Array of User objects
});

lambder.addApi('listProducts', async (ctx, resolver) => {
    const category = ctx.apiPayload.category;
    const products: Product[] = [
        { id: "1", name: "Item 1", price: 10, inStock: true },
        { id: "2", name: "Item 2", price: 20, inStock: false },
    ];
    return resolver.api(products); // ✅ Array of Product objects
});

// ✅ EXAMPLE 4: Nested objects are validated
lambder.addApi('getStats', async (ctx, resolver) => {
    const stats: Stats = {
        totalUsers: 100,
        totalProducts: 50,
        revenue: 10000,
    };
    return resolver.api(stats); // ✅ Matches Stats shape
});

// ✅ EXAMPLE 5: Nullable types work correctly
lambder.addApi('findUser', async (ctx, resolver) => {
    const email = ctx.apiPayload.email;
    
    if (email === "john@example.com") {
        // Found user
        const user: User = {
            id: "123",
            name: "John",
            email: email,
            age: 30,
        };
        return resolver.api(user); // ✅ Can return User
    } else {
        // Not found
        return resolver.api(null); // ✅ Can return null
    }
});

// ✅ EXAMPLE 6: Using die.api() also enforces types
lambder.addApi('getCount', async (ctx, resolver) => {
    return resolver.die.api(42); // ✅ die.api() also type-checks
});

// ✅ EXAMPLE 7: Session APIs also enforce output types
lambder.addSessionApi('getUser', async (ctx, resolver) => {
    const user: User = {
        id: ctx.apiPayload.userId,
        name: "Jane Doe",
        email: "jane@example.com",
        age: 28,
    };
    return resolver.api(user); // ✅ Type-safe for session APIs too
});

// ============================================================================
// What TypeScript Prevents (these would cause compile errors)
// ============================================================================

/*
// ❌ ERROR: Wrong primitive type
lambder.addApi('getCount', async (ctx, resolver) => {
    return resolver.api("not a number"); // Error: string not assignable to number
});

// ❌ ERROR: Missing required field
lambder.addApi('getUser', async (ctx, resolver) => {
    return resolver.api({
        id: "123",
        name: "John",
        email: "john@example.com",
        // age is missing! - TypeScript error
    });
});

// ❌ ERROR: Wrong field type
lambder.addApi('getUser', async (ctx, resolver) => {
    return resolver.api({
        id: "123",
        name: "John",
        email: "john@example.com",
        age: "30", // Error: string not assignable to number
    });
});

// ❌ ERROR: Wrong array element type
lambder.addApi('listUsers', async (ctx, resolver) => {
    return resolver.api([
        { id: "1", name: "Alice", email: "alice@example.com", age: 25 },
        "not a user object", // Error: string not assignable to User
    ]);
});

// ❌ ERROR: Returning wrong type when null is not allowed
lambder.addApi('getUser', async (ctx, resolver) => {
    return resolver.api(null); // Error: null not assignable to User (findUser allows null, but getUser doesn't)
});
*/

console.log("✅ All examples demonstrate proper output type enforcement!");
console.log("✅ TypeScript will catch type mismatches at compile time!");
console.log("✅ This works with both resolver.api() and resolver.die.api()!");
console.log("✅ Both addApi() and addSessionApi() enforce output types!");

export default lambder;
