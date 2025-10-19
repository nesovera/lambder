/**
 * Test file to verify output type enforcement
 * This file should have TypeScript errors if output types are not correct
 */

import Lambder from '../src/Lambder.js';
import type { ApiContract } from '../src/index.js';

// Define a simple API contract
type TestContract = ApiContract<{
    getNumber: { input: void, output: number },
    getString: { input: { id: string }, output: string },
    getUser: { input: { userId: string }, output: { id: string; name: string; age: number } },
}>;

const lambder = new Lambder<TestContract>({
    publicPath: './public',
    apiPath: '/api',
});

// ✅ CORRECT: Returns the right type
lambder.addApi('getNumber', async (ctx, resolver) => {
    // This should work - returning number
    return resolver.api(42);
});

// ❌ INCORRECT: Should cause TypeScript error - returning wrong type
lambder.addApi('getNumber', async (ctx, resolver) => {
    // @ts-expect-error - Testing type enforcement: should not accept string when output is number
    return resolver.api("wrong type");
});

// ✅ CORRECT: Returns string
lambder.addApi('getString', async (ctx, resolver) => {
    const id = ctx.apiPayload.id;
    return resolver.api(`String for ${id}`);
});

// ❌ INCORRECT: Should cause TypeScript error - returning wrong type
lambder.addApi('getString', async (ctx, resolver) => {
    // @ts-expect-error - Testing type enforcement: should not accept number when output is string
    return resolver.api(123);
});

// ✅ CORRECT: Returns correct object shape
lambder.addApi('getUser', async (ctx, resolver) => {
    return resolver.api({
        id: ctx.apiPayload.userId,
        name: "John Doe",
        age: 30,
    });
});

// ❌ INCORRECT: Should cause TypeScript error - missing required field
lambder.addApi('getUser', async (ctx, resolver) => {
    // @ts-expect-error - Testing type enforcement: missing 'age' field
    return resolver.api({
        id: ctx.apiPayload.userId,
        name: "John Doe",
        // age is missing
    });
});

// ❌ INCORRECT: Should cause TypeScript error - wrong field type
lambder.addApi('getUser', async (ctx, resolver) => {
    return resolver.api({
        id: ctx.apiPayload.userId,
        name: "John Doe",
        // @ts-expect-error - Testing type enforcement: age should be number, not string
        age: "30", // wrong type
    });
});

// ✅ CORRECT: Using null is allowed
lambder.addApi('getNumber', async (ctx, resolver) => {
    return resolver.api(null);
});

// ✅ CORRECT: Using resolver.die.api also enforces types
lambder.addApi('getNumber', async (ctx, resolver) => {
    return resolver.die.api(42);
});

// ❌ INCORRECT: resolver.die.api should also enforce types
lambder.addApi('getNumber', async (ctx, resolver) => {
    // @ts-expect-error - Testing type enforcement: die.api should also check types
    return resolver.die.api("wrong type");
});

// Test with addSessionApi
lambder.addSessionApi('getString', async (ctx, resolver) => {
    // Should also enforce output type for session APIs
    return resolver.api("correct string");
});

lambder.addSessionApi('getString', async (ctx, resolver) => {
    // @ts-expect-error - Testing type enforcement: session API should also enforce types
    return resolver.api(123);
});

console.log("If this file compiles with @ts-expect-error comments, output type enforcement is working!");
