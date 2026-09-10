# Getting started

From an empty Lambda function to a typed API call in the browser. Every
configuration option used here is described in full in
[Configuration](./configuration.md).

## Install

```bash
npm install lambder zod
```

On Lambda (`nodejs18.x` and later) the AWS SDK v3 is already provided by the
runtime, so add `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` as dev
dependencies and keep them out of the deployment package. Anywhere else (a
container, a long-running server, local tests) install them for real. The
[README's install section](../README.md#installation) has the full table.

## 1. Create the instance

The whole configuration is given at creation, in one declaration; only
registration (routes, apis, hooks, `use()`) chains afterwards. `initLambder`
is curried so the session data type is fixed first and everything else (policy
names, guard metadata) is INFERRED from the options. TypeScript type arguments
are all-or-nothing per call, so a plain `new Lambder<SessionData>({...})` would
silently widen the inferred policy types, which is why the curried creator is
the canonical entry.

```typescript
// handler.ts
import { initLambder, LambderLocalFileSource } from "lambder";
import * as path from "path";

interface SessionData { userId: string; username: string; }

const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    files: new LambderLocalFileSource({ root: path.resolve("./public") }),
    session: {
        tableName: "website-session",
        tableRegion: "us-east-1",
        sessionSalt: process.env.SESSION_SALT!,
    },
    // true allows any origin; or { origins: ["https://app.example.com"], credentials: true }
    cors: true,
});
```

Sessions need a DynamoDB table; [DynamoDB tables](./dynamodb-tables.md) has the
Terraform, the TTL setting and the IAM policy. Drop the `session` option
entirely if you do not need sessions yet.

## 2. Define APIs

Zod schemas define the contract. Inputs are validated at runtime and inferred
at compile time, and the output type is checked against what the handler
returns.

```typescript
lambder
    .addApi("getCompanyPage", {
        input: z.object({ companyName: z.string() }),
        output: z.object({ id: z.string(), name: z.string(), description: z.string() }),
    }, async ({ apiPayload }, res) => {
        // apiPayload is typed { companyName: string } and already validated
        return res.api(await fetchCompany(apiPayload.companyName));
    })
    .addApi("loginUser", {
        input: z.object({ email: z.string().email(), password: z.string() }),
        output: z.object({ success: z.boolean() }),
    }, async (ctx, res) => {
        const user = await authenticateUser(ctx.apiPayload.email, ctx.apiPayload.password);
        if (!user) return res.api({ success: false });

        await lambder.getSessionController(ctx).createSession(user.id, { userId: user.id, username: user.name });
        return res.api({ success: true });
    });

// Endpoints that require a session use addSessionApi; ctx.session is fetched,
// validated and typed for you.
lambder.addSessionApi("getProfile", {
    input: z.void(),
    output: z.object({ userId: z.string(), username: z.string() }),
}, async (ctx, res) => res.api({
    userId: ctx.session.data.userId,
    username: ctx.session.data.username,
}));
```

[APIs and refusals](./apis.md) covers the rest: modular API files, guard data
on the context, and how to refuse a call without it reading as a crash.

## 3. Export the contract and the handler

```typescript
// The type the frontend imports. Type-only: no runtime code crosses over.
export type ApiContractType = typeof lambder.ApiContract;

// The Lambda entry point. Dispatches HTTP requests and non-HTTP events alike.
export const handler = lambder.getHandler();
```

## 4. Call it from the frontend

Import `LambderCaller` from the `lambder/client` entry. Everything reachable
from there is browser-safe by construction (no AWS SDK, no Node built-ins, no
server pipeline), so a bundle can never pick up server code.

```typescript
import { LambderCaller } from "lambder/client";
import type { ApiContractType } from "./backend/handler"; // type-only import

const caller = new LambderCaller<ApiContractType>({
    apiPath: "/api",
    isCorsEnabled: false,
    errorMessageHandler: (message) => showToast(message),
    sessionExpiredHandler: () => redirectToLogin(),
});

const company = await caller.api("getCompanyPage", { companyName: "Acme" });
```

TypeScript now knows the available API names, the required input shape and the
result type for each one. `api()` collapses every failure to `null`; when a
call site needs to know why a call failed, use `apiOutcome()`. Both are covered
in [Frontend client](./client.md).

## 5. Serve the frontend build (optional)

The same function can host the built frontend beside the API:

```typescript
lambder
    .servePublicFiles()   // real files: hashed assets, ETag, compression
    .serveIndexHtml();    // the app shell for everything else
```

[Frontend hosting](./frontend-hosting.md) covers hosting a build from S3 or R2,
per-tenant roots, and rendering the shell through a template.

## What to read next

- [Configuration](./configuration.md) for every creation option.
- [Routing and actions](./routing.md) if the function also serves pages or
  receives scheduled events.
- [API policies](./api-policies.md) once the API surface needs authorization,
  rate limits or idempotency.
- [Testing](./testing.md) to mock the contract in frontend tests.
