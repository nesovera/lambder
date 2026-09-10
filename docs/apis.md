# APIs and refusals

An API is a named endpoint with a Zod input schema and a Zod output schema.
Lambder validates the input at runtime, infers both types at compile time, and
accumulates every registration into one contract type the frontend imports.

## Defining APIs

```typescript
import { z } from "zod";

lambder
    .addApi("getCompanyPage", {
        input: z.object({ companyName: z.string() }),
        output: z.object({ id: z.string(), name: z.string(), description: z.string() }),
    }, async ({ apiPayload }, res) => {
        // apiPayload is typed and already validated
        const data = await fetchCompany(apiPayload.companyName);
        return res.api(data);   // the return value is type-checked against `output`
    });
```

The options object beside the schemas is where an API declares its policies:

| Field | Purpose |
| --- | --- |
| `input` | Zod schema for the payload. `z.void()` for none |
| `output` | Zod schema for the result. Checked against what the handler returns |
| `guards` | Named guards to run before the handler. See [API policies](./api-policies.md#guards) |
| `rateLimit` | Named rate-limit policies. See [API policies](./api-policies.md#rate-limits) |
| `idempotency` | `true` or `{ ttlSeconds }`. See [API policies](./api-policies.md#idempotency) |

## Session-protected APIs

`addSessionApi` fetches and validates the session before the handler runs, and
types `ctx.session` from the instance's session data type. A missing or expired
session answers the protocol's `{ sessionExpired: true }` envelope, which
`LambderCaller` turns into the caller's `sessionExpiredHandler`.

```typescript
lambder.addSessionApi("getProfile", {
    input: z.void(),
    output: z.object({ userId: z.string(), username: z.string() }),
}, async (ctx, res) => {
    return res.api({
        userId: ctx.session.data.userId,
        username: ctx.session.data.username,
    });
});
```

Registering the same API name twice throws. Dispatch is first-match, so a
second registration would be silently dead code.

## The inferred contract

```typescript
export type ApiContractType = typeof lambder.ApiContract;
export const handler = lambder.getHandler();
```

Each contract entry carries the API's `input` and `output`, its `guardInputs`
when a guardInput-mode guard applies, and its `guards` option exactly as
declared: `ApiContractType["getUser"]["guards"]` is the literal
`{ readonly orgPermission: "USERS.MANAGE" }`.

A client that keeps its own map of what an API needs, to decide whether to
render a screen before calling, pins that map to the declarations with
`satisfies` instead of a test that reads the server source:

```typescript
type PermissionNeededBy<K extends keyof ApiContractType> =
    ApiContractType[K] extends { guards: { orgPermission: infer N } } ? N : never;

const NEEDS = {
    getUser: "USERS.MANAGE",
} as const satisfies { [K in keyof ApiContractType]?: PermissionNeededBy<K> };
```

Renaming the permission on the server, or moving the API to a different one,
then fails the client's map to compile. Make the mapped type non-optional (over
the guarded API names) when the map must also stay complete as guarded APIs are
added.

## Modular APIs with `use()`

For larger applications, split APIs into modules. `use()` preserves the
inferred contract through the chain.

```typescript
// user-api.ts
import { z } from "zod";
import type { AppLambder } from "./app";

export const userApi = (lambder: AppLambder) => lambder
    .addApi("getUser", {
        input: z.object({ id: z.string() }),
        output: z.object({ id: z.string(), name: z.string() }),
    }, async (ctx, res) => res.api({ id: ctx.apiPayload.id, name: "User" }))
    .addApi("createUser", {
        input: z.object({ name: z.string(), email: z.string() }),
        output: z.object({ id: z.string() }),
    }, async (ctx, res) => res.api({ id: "123" }));

// index.ts
import { lambderApp } from "./app";
import { userApi } from "./user-api";

const lambder = lambderApp.use(userApi);

export type ApiContractType = typeof lambder.ApiContract;
export const handler = lambder.getHandler();
```

Derive `AppLambder` from the real instance rather than writing the annotation
by hand; see
[Configuration](./configuration.md#sharing-the-instance-type-across-files).

## Request flow per API

```
session (session APIs)
  → idempotency replay lookup
  → rate limits
  → guards
  → zod validation
  → idempotency claim
  → handler
  → idempotency store
```

The replay lookup runs first on purpose: a completed idempotent request answers
its stored response without burning rate-limit quota or re-running guards (the
original already passed them, and no handler executes either way).

## Refusals

A refusal ("you are not allowed", "quota exceeded") is not a crash. `res.die.*`
covers refusals where you hold the resolver, but shared helpers (permission
checks, validators) usually do not.

### `refuse()`

The one-liner for the common case. Callable from anywhere in an API call's
stack, it throws a typed refusal carrying the standard `LambderRefusalMessage`
shape (`{ type, code?, title?, content }`) that the pipeline maps onto the
envelope's `errorMessage`, so refusals never pollute crash logging and clients
get a parseable response:

```typescript
import { refuse } from "lambder";

if (!row) refuse("Record not found.");                                  // { type: "warning", content }
if (!isAdmin) refuse("Admins only.", { notAuthorized: true });          // + envelope flag
refuse("Too many attempts.", { type: "error", statusCode: 429 });       // custom rendering intent + status
if (exists) refuse("Already reported.", { code: "ALREADY_REPORTED" });  // + machine-readable identity
// TypeScript applies never-return narrowing: after `if (!row) refuse(...)`, row is defined.
```

### Refusal codes

`code` is the refusal's identity for machines: clients branch and translate on
it (a translated client never displays `content`, it looks the code up), and
`content` stays the human-readable fallback for codes a client does not know
yet. Keep your app's codes as one typed vocabulary in shared code.

The framework stamps the refusals it authors itself with
`LAMBDER_REFUSAL_CODES` (exported from `lambder` and `lambder/client`) under
the reserved `lambder/` prefix, so app codes never collide:

| Constant | Code | Raised when |
| --- | --- | --- |
| `rateLimited` | `lambder/rate-limited` | A rate-limit policy refused (429) |
| `duplicateInFlight` | `lambder/duplicate-in-flight` | The original of an idempotent request is still running (409) |
| `invalidIdempotencyKey` | `lambder/invalid-idempotency-key` | The `idempotencyKey` is malformed (400) |
| `apiNotFound` | `lambder/api-not-found` | No API is registered under the requested name |

A rate-limit policy's own `errorMessage` inherits `lambder/rate-limited` unless
it sets a code, so an `errorMessageHandler` can treat every rate limit alike and
still special-case the ones you name.

### `LambderApiError`

For full control of the `errorMessage` payload (apps with their own message
vocabulary), throw `LambderApiError` directly; `refuse()` is sugar over it:

```typescript
import { LambderApiError } from "lambder";

// In any helper, no resolver needed:
export const requirePermission = (granted: boolean) => {
    if (!granted) throw new LambderApiError("Permission denied.", {
        notAuthorized: true,                                         // envelope flag -> caller's notAuthorizedHandler
        errorMessage: { type: "warning", content: "Not allowed." },  // any shape your errorMessageHandler expects
        // sessionExpired: true,                                     // optional envelope flag
        // statusCode: 403,                                          // optional; default 200 (avoid 5xx and 422)
        // headers: { "Retry-After": "30" },                         // optional response headers
    });
};
```

`errorMessage` defaults to the error's message string, so
`throw new LambderApiError("Nope.")` alone is already visible to the client.
Thrown outside an API call (in a route handler, say) it behaves like a normal
error. The class is isomorphic and dependency-free, so shared server/browser
packages can import it safely. Detection is brand-based
(`isLambderApiError`), so it works even when two copies of lambder end up in
one bundle.

## Benefits of the typed contract

- No manual type definitions: types are inferred from the Zod schemas.
- One source of truth: the contract comes from the backend code.
- Runtime validation: Zod validates every input before the handler runs.
- Compile-time safety on both sides, with autocomplete on API names.
- Zero overhead: the frontend's import is type-only, so no runtime code
  crosses over.
