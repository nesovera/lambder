# Type-Safe API Quick Start

## In 3 Simple Steps

### 1. Define Your Contract Type

```typescript
// shared/apiContract.ts
import type { ApiContract } from 'lambder';

export type MyApiContract = {
    getUserById: { input: { userId: string }, output: User },
    createUser: { input: CreateUserInput, output: User },
    listUsers: { input: void, output: User[] }
} satisfies ApiContract;
```

### 2. Backend - Pass Type to Lambder

```typescript
import Lambder from 'lambder';
import type { MyApiContract } from './shared/apiContract';

const lambder = new Lambder<MyApiContract>({
    publicPath: './public',
    apiPath: '/api'
});

// Now addApi is type-safe!
lambder.addApi('getUserById', async (ctx, resolver) => {
    // ctx.apiPayload is automatically typed as { userId: string }
    const user = await db.getUser(ctx.apiPayload.userId);
    return resolver.api(user);
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
- ✅ **Type-safe inputs and outputs**
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
- **Opt-in** - Use types when you want them
- **Simple** - Just pass type to constructor
- **Autocomplete** - IDE shows available APIs as you type
