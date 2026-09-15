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
signature gate → payload restore
  → rate limits keyed on the request alone (per: "ip")
  → session (session APIs)
  → idempotency replay lookup
  → the remaining rate limits (per: "session", custom keys)
  → guards
  → zod validation
  → idempotency claim
  → handler
  → idempotency store
```

The replay lookup runs before the policies below it on purpose: a completed
idempotent request answers its stored response without burning that quota or
re-running guards (the original already passed them, and no handler executes
either way). An `ip`-keyed policy is checked before the session read and the
replay lookup instead, because those store reads are what it exists to bound,
so a retry does count against an `ip` budget. See
[API policies](./api-policies.md#request-flow).

## Signatures: when a client must update

Every endpoint has a signature: a short digest of its client-facing shape,
computed from the registration itself. It covers the name and mode, the
`input` and `output` schemas as JSON Schema, every guard the endpoint
declares with the schema that guard validates (a `guardInput` the client
sends, or an `apiInput` slice of the payload), and whether the endpoint takes
an idempotency key. Rate limits, guard parameters and the handler are not
part of it, because changing them changes nothing for a client. The schemas
are digested exactly as zod emits them, descriptions included; what JSON
Schema cannot express (a transform's output, a custom check) digests as `{}`.

`lambder.apiSignatures()` returns every registered endpoint's signature,
keyed by the endpoint's hashed name, as a `LambderApiSignatureMap`. A
generator imports the finished instance, awaits it, and writes the object to
a file the frontend ships with its build. Run it before every frontend build,
not by hand:

```typescript
// tools/generate-api-signatures.ts
import { writeFileSync } from "node:fs";
import { lambder } from "../backend/index.js";   // the instance with every API registered

const signatures = await lambder.apiSignatures();
writeFileSync("frontend/src/generated/apiSignatures.generated.ts",
    "// Generated from the server's registrations by tools/generate-api-signatures.ts. Do not edit.\n"
    + "import type { LambderApiSignatureMap } from \"lambder/client\";\n"
    + `export const apiSignatures: LambderApiSignatureMap = ${JSON.stringify(signatures, null, 4)};\n`);
```

The frontend passes the map to `LambderCaller` as `apiSignatures`, and every
call then carries the signature of the endpoint it names. The server compares
it with the digest of what it serves now. A match runs. A mismatch answers the
`versionExpired` envelope, which reaches the caller's `versionExpiredHandler`
(usually a reload). A signed call for a name the server no longer has answers
`versionExpired` as well, since the client was built against a contract that
had it. A call carrying no signature is never gated, so a script, a test or a
client built without the map behaves as before.

What this buys is that a deploy forces a reload only on the clients that call
an endpoint whose shape actually changed; an open tab whose endpoints are
unchanged keeps working. `apiVersion` gates nothing any more: it is stamped on
every answer's envelope so a client can tell which build answered.

A frontend shipped with a stale map would answer `versionExpired` on a changed
endpoint, reload, and get the same bundle back. `LambderCaller` breaks that
loop (see [Frontend client](./client.md#the-signature-map)), but the fix is to
generate the file as part of the build so it can never be stale.

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
| `invalidRequestPayload` | `lambder/invalid-request-payload` | A compressed request payload (`payloadGz` or `payloadBr`) is malformed, carries both fields, or exceeds `maxRequestPayloadBytes` (400) |
| `notMocked` | `lambder/not-mocked` | The mock runtime was asked for an endpoint registered as `notMocked` (200; the mock runtime only) |

A rate-limit policy's own `errorMessage` inherits `lambder/rate-limited` unless
it sets a code, so an `errorMessageHandler` can treat every rate limit alike and
still special-case the ones you name.

On the client, name your own vocabulary as the type argument of
`LambderRefusalMessage` and the switch is checked: every framework code plus
yours, and nothing else.

```typescript
import { LAMBDER_REFUSAL_CODES, type LambderRefusalMessage } from "lambder/client";

type AppCode = "app/not-verified" | "app/quota-exhausted";

const describe = (message: LambderRefusalMessage<AppCode>): string => {
    switch (message.code) {
        case "app/not-verified": return t("verifyYourAddress");
        case "app/quota-exhausted": return t("buyMore");
        case LAMBDER_REFUSAL_CODES.rateLimited: return t("slowDown");
        // ... the other lambder/ codes ...
        default: return message.content;   // a code this client does not know yet
    }
};
```

Leave the argument off (`LambderRefusalMessage`) and the codes are the
framework's alone, so a `default: never` assertion holds and adding a code to
the framework breaks the switch rather than falling through it. Messages your
app WRITES take `LambderAppRefusalMessage`, where any code is welcome: that is
what a rate-limit policy's `errorMessage` and the mock's failure injection
accept.

### `LambderApiRefusal`

For full control of the `errorMessage` payload (apps with their own message
vocabulary), throw `LambderApiRefusal` directly; `refuse()` is sugar over it:

```typescript
import { LambderApiRefusal } from "lambder";

// In any helper, no resolver needed:
export const requirePermission = (granted: boolean) => {
    if (!granted) throw new LambderApiRefusal("Permission denied.", {
        notAuthorized: true,                                         // envelope flag -> caller's notAuthorizedHandler
        errorMessage: { type: "warning", content: "Not allowed." },  // any shape your errorMessageHandler expects
        // sessionExpired: true,                                     // optional envelope flag
        // statusCode: 403,                                          // optional; default 200 (avoid 5xx and 422)
        // headers: { "Retry-After": "30" },                         // optional response headers
    });
};
```

`errorMessage` defaults to the error's message string, so
`throw new LambderApiRefusal("Nope.")` alone is already visible to the client.
Thrown outside an API call (in a route handler, say) it behaves like a normal
error. The class is isomorphic and dependency-free, so shared server/browser
packages can import it safely. Detection is brand-based
(`isLambderApiRefusal`), so it works even when two copies of lambder end up in
one bundle.

## Benefits of the typed contract

- No manual type definitions: types are inferred from the Zod schemas.
- One source of truth: the contract comes from the backend code.
- Runtime validation: Zod validates every input before the handler runs.
- Compile-time safety on both sides, with autocomplete on API names.
- Zero overhead: the frontend's import is type-only, so no runtime code
  crosses over.
