# Type-Safe API Quick Start

## In 3 Simple Steps

### 1. Define Your Contract Type

```typescript
// shared/apiContract.ts
import type { ApiContract } from 'lambder';

export type MyApiContract = ApiContract<{
    getUserById: { input: { userId: string }, output: User },
    createUser: { input: CreateUserInput, output: User },
    listUsers: { input: void, output: User[] }
}>;
```

### 2. Backend - Pass Type to Lambder

```typescript
import Lambder from 'lambder';
import type { MyApiContract } from './shared/apiContract';

const lambder = new Lambder<MyApiContract>({
    publicPath: './public',
    apiPath: '/api'
});

// Now addApi is type-safe for both inputs AND outputs!
lambder.addApi('getUserById', async (ctx, resolver) => {
    // ✅ ctx.apiPayload is automatically typed as { userId: string }
    const user = await db.getUser(ctx.apiPayload.userId);
    
    // ✅ resolver.api() enforces the output type (User)
    return resolver.api(user); // TypeScript checks that user matches User type!
});
```

### 3. Frontend - Pass Type to LambderCaller

```typescript
import { LambderCaller } from 'lambder';
import type { MyApiContract } from './shared/apiContract';

const caller = new LambderCaller<MyApiContract>({
    apiPath: '/api',
    isCorsEnabled: false
});

// Now api() is type-safe!
const user = await caller.api('getUserById', { userId: '123' });
// user is typed as User | null | undefined
```

## That's It!

- ✅ **No wrapper functions needed**
- ✅ **Use existing `api()` and `addApi()` methods**
- ✅ **Full autocomplete in IDE**
- ✅ **Type-safe inputs AND outputs**
- ✅ **Compile-time validation**
- ✅ **Backward compatible**

## Contract Type Format

```typescript
type MyApiContract = {
    apiName: { input: InputType, output: OutputType }
}
```

## Examples

### API with parameters
```typescript
getUserById: { input: { userId: string }, output: User }
```

### API with no input
```typescript
listAll: { input: void, output: Item[] }
```

### API with complex types
```typescript
updateUser: { 
    input: { id: string } & Partial<User>, 
    output: User 
}
```

### API with conditional output
```typescript
login: { 
    input: { email: string, password: string },
    output: { success: boolean, user?: User, error?: string }
}
```

## Output Type Enforcement

The type system now enforces that `resolver.api()` returns data matching your contract's output type:

```typescript
type MyContract = ApiContract<{
    getNumber: { input: void, output: number },
    getUser: { input: { id: string }, output: User }
}>;

const lambder = new Lambder<MyContract>({ ... });

// ✅ CORRECT
lambder.addApi('getNumber', async (ctx, resolver) => {
    return resolver.api(42); // number - matches output type
});

// ❌ ERROR: Type 'string' is not assignable to type 'number'
lambder.addApi('getNumber', async (ctx, resolver) => {
    return resolver.api("wrong"); // TypeScript error!
});

// ✅ CORRECT
lambder.addApi('getUser', async (ctx, resolver) => {
    return resolver.api({ id: "123", name: "John", ... }); // User object
});

// ❌ ERROR: Missing required properties
lambder.addApi('getUser', async (ctx, resolver) => {
    return resolver.api({ id: "123" }); // TypeScript error - incomplete User!
});
```

This works with:
- `resolver.api()` - typed return value
- `resolver.die.api()` - typed return value
- `addApi()` - typed for regular APIs
- `addSessionApi()` - typed for session APIs

## Without Type Safety (Still Works!)

Don't want type safety? Just don't pass the generic type:

```typescript
// Frontend
const caller = new LambderCaller({ ... }); // No generic
await caller.api('anyApi', { anything: true }); // Works, but untyped

// Backend
const lambder = new Lambder({ ... }); // No generic
lambder.addApi('anyApi', async (ctx, resolver) => {
    // ctx.apiPayload is any
});
```

## Full Example

See [simplified-typed-api-example.ts](../examples/simplified-typed-api-example.ts) for a complete working example.

## Key Points

- **Contract is just a TypeScript type** - No runtime code!
- **Zero overhead** - All type checking happens at compile time
- **Input AND output validation** - Both sides of your API are type-safe
- **Compile-time safety** - Catch type mismatches before deployment
- **Opt-in** - Use types when you want them
- **Simple** - Just pass type to constructor
- **Autocomplete** - IDE shows available APIs as you type
