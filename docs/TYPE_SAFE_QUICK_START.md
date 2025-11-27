# Type-Safe API Quick Start (v2.0)

## In 3 Simple Steps

### 1. Define & Implement APIs (Backend)

Use Zod schemas to define your API contract inline. Lambder will automatically validate inputs at runtime and infer types for compile-time safety.

```typescript
import { z } from "zod";
import Lambder from "lambder";

// Initialize
const lambder = new Lambder({
    publicPath: "./public",
    apiPath: "/api"
})
// Chain APIs
.addApi("getUser", {
    input: z.object({ userId: z.string() }),
    output: z.object({ id: z.string(), name: z.string() })
}, async (ctx, resolver) => {
    // ctx.apiPayload is typed as { userId: string }
    // Runtime validation is already performed!
    return resolver.api({ 
        id: ctx.apiPayload.userId, 
        name: "John Doe" 
    });
});

// Export the inferred contract type
export type ApiContractType = typeof lambder.ApiContract;

export const handler = lambder.getHandler();
```

### 2. Use in Frontend

Import the type (not the code) and use `LambderCaller`.

```typescript
import { LambderCaller } from "lambder";
import type { ApiContractType } from "./backend"; // Type-only import

const lambderCaller = new LambderCaller<ApiContractType>({
    apiPath: "/api"
});

// Fully typed!
// TypeScript knows 'getUser' takes { userId: string } and returns { id: string, name: string }
const user = await lambderCaller.api("getUser", { userId: "123" });
```

### 3. Modular APIs (Optional)

For larger apps, split your APIs into modules using `.use()`.

```typescript
// api.user.ts
import { z } from "zod";
import Lambder from "lambder";

export const userApi = <T>(l: Lambder<T>) => {
    return l.addApi("login", {
        input: z.object({ email: z.string() }),
        output: z.boolean()
    }, async (ctx, resolver) => {
        return resolver.api(true);
    });
};

// index.ts
import { userApi } from "./api.user";

const lambder = new Lambder({ publicPath: './public' })
    .use(userApi); // Types are preserved!
```
