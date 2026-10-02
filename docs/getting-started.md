# Getting started

From an empty Lambda function to a typed API call in the browser. Every
configuration option used here is described in full in
[Configuration](./configuration.md).

## Install

```bash
npm install lambder zod
```

Lambder needs Node 20 or later, which every current Lambda Node.js runtime
provides. On Lambda the AWS SDK v3 is already provided by the runtime, so add
`@aws-sdk/client-dynamodb` as a dev dependency and keep it out of the
deployment package. Anywhere else (a container, a long-running server, local
tests) install it for real. It is the one package the DynamoDB session store
and every other DynamoDB store need, and it is loaded on the first session or
store access, so an app that keeps no sessions and uses no store does not need
it. The [README's install section](../README.md#installation) has the full
table.

## 1. Create the instance

The whole configuration is given at creation, in one declaration. `initLambder`
is curried so the session data type is fixed first and everything else (policy
names, guard metadata) is INFERRED from the options. TypeScript type arguments
are all-or-nothing per call, so a plain `new Lambder<SessionData>({...})` would
silently widen the inferred policy types, which is why the curried creator is
the canonical entry.

```typescript
// app.ts
import { initLambder, LambderLocalFileSource, LambderDdbSessionStore, lambderGuard } from "lambder";
import * as path from "path";

export interface SessionData { userId: string; username: string; }

export const lambderApp = initLambder<SessionData>().create({
    apiPath: "/api",
    files: new LambderLocalFileSource({ root: path.resolve("./public") }),
    session: {
        store: new LambderDdbSessionStore({ tableName: "website-session", region: "us-east-1" }),
        sessionSalt: process.env.SESSION_SALT!,
    },
    // true allows any origin; or { origins: ["https://app.example.com"], credentials: true }
    cors: true,
    // Who may call what. requireApiGuards is off by default; it is worth
    // turning on from the first endpoint, so an endpoint's openness is always
    // a written decision instead of an omission nobody notices later.
    guards: {
        signedIn: lambderGuard({ session: true, handler: () => {} }),
        open: lambderGuard({ handler: (_ctx, _params, _reason: string) => {} }),
    },
    requireApiGuards: true,
});

// The instance's declaration builders, typed to it, for the files that declare endpoints.
export const { defineApi, defineApiGroup, lazyApiGroup } = lambderApp;
```

Sessions rest in a store of your choosing; `LambderDdbSessionStore` needs a
DynamoDB table, and [DynamoDB tables](./ddb-tables.md) has the Terraform,
the TTL setting and the IAM policy. Drop the `session` option entirely if you
do not need sessions yet.

`requireApiGuards` makes `guards` a required field of every endpoint, checked
at compile time and at registration. It is off in the framework, because a
no-op guard satisfies it and nothing should stand between a new app and its
first endpoint, but it is on here: an app that declares it from the start
never has to reconstruct later which of its endpoints are open and why.
`signedIn` and `open` are the two no-op guards that record an opt-out, and
`open` takes the reason as a parameter, so one grep lists every public door in
the app. `signedIn` declares `session: true`, which is what makes an endpoint
declaring it a session endpoint (see step 2). [API
policies](./api-policies.md#requireapiguards) covers real guards, the ones
that authorize a caller rather than record a decision.

## 2. Define APIs

Zod schemas define the contract. Inputs are validated at runtime and inferred
at compile time. A handler takes the context and returns its output: the type
is checked against the output schema, and the value is parsed through it
before it is sent, so fields it does not declare are stripped. A handler that
has to say no throws `refuse()` instead of returning.

An endpoint is a value declared with `defineApi`, in a named group:
`companies.getPage` below is the action `getPage` of the group `companies`,
called at `/api/companies/getPage`.

```typescript
// companies.ts
import { z } from "zod";
import { refuse } from "lambder";
import { defineApi, defineApiGroup } from "./app";

export const companyApis = defineApiGroup("companies", {
    getPage: defineApi({
        input: z.object({ companyName: z.string() }),
        output: z.object({ id: z.string(), name: z.string(), description: z.string() }),
        guards: { open: "public company pages" },
    }, async ({ apiPayload }) => {
        // apiPayload is typed { companyName: string } and already validated
        return await fetchCompany(apiPayload.companyName);
    }),
});

// account.ts
export const accountApis = defineApiGroup("account", {
    login: defineApi({
        input: z.object({ email: z.email(), password: z.string() }),
        output: z.object({ username: z.string() }),
        guards: { open: "the password check here IS the control" },
    }, async (ctx) => {
        const user = await authenticateUser(ctx.apiPayload.email, ctx.apiPayload.password);
        // A refusal, not an output: the caller's refusalHandler shows it.
        if (!user) refuse("Wrong email or password.");

        // ctx.sessionController is this request's session controller, typed SessionData.
        await ctx.sessionController.createSession(user.id, { userId: user.id, username: user.name });
        return { username: user.name };
    }),
    // signedIn needs a session, so this is a session endpoint: ctx.session is
    // fetched, validated and typed for you, and a call without one is
    // answered sessionExpired.
    profile: defineApi({
        input: z.object({}),
        output: z.object({ userId: z.string(), username: z.string() }),
        guards: "signedIn",
    }, async (ctx) => ({
        userId: ctx.session.data.userId,
        username: ctx.session.data.username,
    })),
});
```

[APIs and refusals](./apis.md) covers the rest: groups across files, lazy
groups, guard data on the context, and how to refuse a call without it
reading as a crash.

## 3. Register, and export the contract and the handler

```typescript
// handler.ts
import { lambderApp } from "./app";
import { companyApis } from "./companies";
import { accountApis } from "./account";

export const lambder = lambderApp.registerApiGroups(companyApis, accountApis);

// The type the frontend imports. Type-only: no runtime code crosses over. A
// large app generates it into a file of its own instead; see apis.md.
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
    refusalHandler: (message) => showToast(message),
    sessionExpiredHandler: () => redirectToLogin(),
});

const company = await caller.companies.getPage({ companyName: "Acme" });
```

TypeScript now knows every group, its endpoints, the required input shape and
the result type for each one. A call collapses every failure to `undefined`;
when a call site needs to know why a call failed, use
`caller.companies.getPage.outcome(...)`. Code that has the endpoint's name as a
value calls `caller.api("companies.getPage", input)` and
`caller.apiOutcome(...)`. All of it is covered in
[Frontend client](./client.md).

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
