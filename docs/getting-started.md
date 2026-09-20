# Getting started

From an empty Lambda function to a typed API call in the browser. Every
configuration option used here is described in full in
[Configuration](./configuration.md).

## Install

```bash
npm install lambder zod
```

Lambder needs Node 20 or later, which every current Lambda Node.js runtime
provides. On Lambda the AWS SDK v3 is already provided by the runtime, so add `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` as dev
dependencies and keep them out of the deployment package. Anywhere else (a
container, a long-running server, local tests) install them for real. Both are
loaded on the first session or store access, so an app that keeps no sessions
and uses no store needs neither. The
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
import { initLambder, LambderLocalFileSource, LambderDdbSessionStore, lambderGuard } from "lambder";
import { z } from "zod";
import * as path from "path";

interface SessionData { userId: string; username: string; }

const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    files: new LambderLocalFileSource({ root: path.resolve("./public") }),
    session: {
        store: new LambderDdbSessionStore({ tableName: "website-session", region: "us-east-1" }),
        sessionSalt: process.env.SESSION_SALT!,
    },
    // true allows any origin; or { origins: ["https://app.example.com"], credentials: true }
    cors: true,
    // Who may call what. Neither flag is on by default; both are worth
    // turning on from the first endpoint, so an API's openness is always a
    // written decision instead of an omission nobody notices later.
    guards: {
        sessionOnly: lambderGuard({ session: true, handler: () => {} }),
        open: lambderGuard({ handler: (_ctx, _params, _reason: string) => {} }),
    },
    requireSessionApiGuards: true,
    requirePublicApiGuards: true,
})
// the declaration continues in step 2: registration chains onto create()
```

Sessions rest in a store of your choosing; `LambderDdbSessionStore` needs a
DynamoDB table, and [DynamoDB tables](./dynamodb-tables.md) has the Terraform,
the TTL setting and the IAM policy. Drop the `session` option entirely if you
do not need sessions yet.

The two `require*ApiGuards` flags make `guards` a required field of every API
you register, checked at compile time and at registration. They are off in the
framework, because a no-op guard satisfies them and nothing should stand
between a new app and its first endpoint, but they are on here: an app that
declares them from the start never has to reconstruct later which of its
endpoints are open and why. `sessionOnly` and `open` are the two no-op guards
that record an opt-out, and `open` takes the reason as a parameter, so one
grep lists every public door in the app. Drop both flags and the `guards` map
if you would rather start without them. [APIs and
refusals](./api-policies.md#requiresessionapiguards) covers real guards, the
ones that authorize a caller rather than record a decision.

## 2. Define APIs

Zod schemas define the contract. Inputs are validated at runtime and inferred
at compile time, and the output type is checked against what the handler
returns.

Every registration returns an instance carrying the contract so far, so the
chain is not a matter of style: calling `lambder.addApi(...)` as its own
statement discards the instance the contract accumulated onto and leaves
`typeof lambder.ApiContract` empty.

```typescript
// handler.ts, continuing the declaration from step 1
    .addApi("getCompanyPage", {
        input: z.object({ companyName: z.string() }),
        output: z.object({ id: z.string(), name: z.string(), description: z.string() }),
        guards: { open: "public company pages" },
    }, async ({ apiPayload }, res) => {
        // apiPayload is typed { companyName: string } and already validated
        return res.api(await fetchCompany(apiPayload.companyName));
    })
    .addApi("loginUser", {
        input: z.object({ email: z.email(), password: z.string() }),
        output: z.object({ success: z.boolean() }),
        guards: { open: "the password check here IS the control" },
    }, async (ctx, res) => {
        const user = await authenticateUser(ctx.apiPayload.email, ctx.apiPayload.password);
        if (!user) return res.api({ success: false });

        await lambder.getSessionController(ctx).createSession(user.id, { userId: user.id, username: user.name });
        return res.api({ success: true });
    })
    // Endpoints that require a session use addSessionApi; ctx.session is
    // fetched, validated and typed for you.
    .addSessionApi("getProfile", {
        input: z.void(),
        output: z.object({ userId: z.string(), username: z.string() }),
        guards: "sessionOnly",
    }, async (ctx, res) => res.api({
        userId: ctx.session.data.userId,
        username: ctx.session.data.username,
    }));
```

[APIs and refusals](./apis.md) covers the rest: modular API files, guard data
on the context, and how to refuse a call without it reading as a crash.

## 3. Export the contract and the handler

```typescript
import type { LambderFlattenContract } from "lambder";

// The type the frontend imports. Type-only: no runtime code crosses over.
// An interface rather than a type alias, so that reading the contract stays
// cheap as endpoints are added; see apis.md for what that is worth.
export interface ApiContractType extends LambderFlattenContract<typeof lambder.ApiContract> {}

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
result type for each one. `api()` collapses every failure to `undefined`; when
a call site needs to know why a call failed, use `apiOutcome()`. Both are
covered in [Frontend client](./client.md).

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
- [The mock runtime](./mock.md) to serve the contract from mock handlers in development and tests.
