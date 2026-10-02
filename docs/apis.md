# APIs and refusals

An API is an endpoint with a Zod input schema and a Zod output schema, in a
named group: `companies.getPage` is the action `getPage` of the group
`companies`, called at `{apiPath}/companies/getPage`. Lambder validates the
input at runtime, infers both types at compile time, and folds every
registered group into one contract type the frontend imports.

## Defining APIs

An endpoint is a value. `defineApi(options, handler)` declares one, typed on
the instance's own types; `defineApiGroup(name, { action: ... })` gathers a
group's endpoints; `registerApiGroups(...groups)` registers them all at once.

```typescript
import { z } from "zod";
import { refuse } from "lambder";

// app.ts: the instance, and its declaration builders handed out
export const lambderApp = initLambder<SessionData>().create({ apiPath: "/api", session, guards });
export const { defineApi, defineApiGroup, lazyApiGroup } = lambderApp;

// companies.ts
export const companyApis = defineApiGroup("companies", {
    getPage: defineApi({
        input: z.object({ companyName: z.string() }),
        output: z.object({ id: z.string(), name: z.string(), description: z.string() }),
        guards: "anyone",
    }, async ({ apiPayload }) => {
        // apiPayload is typed and already validated
        const company = await fetchCompany(apiPayload.companyName);
        if (!company) refuse("No such company.");
        return company;   // type-checked against `output`, and parsed through it before it is sent
    }),
});

// index.ts: registration only
export const lambder = lambderApp.registerApiGroups(companyApis, orderApis);
```

A group's name and its actions are identifiers (a letter, then letters,
digits or underscores), because the endpoint's name is also its path and a
property of every caller: `caller.companies.getPage(input)`. A group may not
take a name a caller already answers for (`api`, `apiOutcome`, `request`,
`then` and the rest of `LAMBDER_RESERVED_GROUP_NAMES`), and an action may not
take one a function or any object answers for (`then`, `call`, `outcome`,
`toString`, `valueOf` and the rest of `LAMBDER_RESERVED_ACTION_NAMES`), so a
group turned into a string calls nothing. Declaring an
endpoint registers nothing; registration is where its options are checked
against the instance (an unknown guard or policy, a missing guard under
`requireApiGuards`, a refusal code outside the vocabulary), and a group
registered twice is refused, at compile time and at startup.

A handler takes the context and nothing else. It answers the call by
returning its output, and says no by throwing a refusal with `ctx.refuse()`
or [`refuse()`](#refusals), from the handler or from anything it calls. Those
are the only two answers a handler gives: it returns exactly what the API
declared, and every "no" is a refusal. Headers, cookies and debugging entries
go beside the answer, through the context (`ctx.setResponseHeader`,
`ctx.setCookie`, `ctx.logList.push`; see
[Responses](./responses.md#headers-and-cookies)).

**An output is an object or an array.** Never `null`, a primitive or nothing,
so a caller's success is never falsy: `caller.api()` returns the output on
success and `undefined` on every failure, and the two cannot be confused. An
output schema whose JSON form is anything else (`z.void()`, `z.boolean()`, a
nullable or an optional object, a `z.date()`, which JSON writes as a string) is a compile
error on the `output` option, and a handler that answers one anyway (an
`any` schema) is a crash. An API with nothing to answer declares
`output: z.object({})` and returns `{}`; a lookup that may find nothing
answers `{ order: null }` rather than `null`.

**The output schema is applied, not only typed.** What the handler returns is
parsed through `output` before the envelope is built, so what reaches the
client (and an idempotent replay) is the declared shape: zod strips the fields
the schema does not declare, fills its defaults and runs its transforms. That
matters because TypeScript accepts a value carrying more than its type: a row
read straight from a table, with a password hash beside the declared fields,
is assignable to a narrower output type, and without the parse it would go to
the client whole. The handler returns the schema's input form (`z.input`),
what the transforms take, so each transform runs once. A refusal carries no
output (a declared code's data is parsed the same way; see
[Declared refusals](#declared-refusals)).

**A success is only ever the handler's output.** A hook, a fallback, the
input validation handler and the global error handler answer an API call
through `res.apiRefusal()`, which writes a refusal: a `refusal` message or one
of the `versionExpired`, `sessionExpired` and `notAuthorized` flags, beside a
null payload (see [Responses](./responses.md#api-answers-outside-a-handler)).
A reader takes a 2xx envelope with no flag and no refusal for a success
only when its payload is an object or an array, so a body shaped like one by
hand, a proxy's, or an old stored answer reads as a server failure instead.
The success a caller reads is therefore exactly the contract's output type.

An output the schema rejects, or one that is not an object or an array, is
the handler breaking its own contract and is
answered as a crash (`LambderApiOutputValidationError`, named, with the
failing paths but never the values), not sent. The handler has run by then,
whatever it wrote or charged included, so under an idempotency key the crash
answer is recorded as the key's answer: a retry is told the same thing instead
of running the operation again. The parse is synchronous, so an output schema
cannot be async: an async refinement or transform in it makes zod throw, and
that throw, or one from a transform of your own, is the same
`LambderApiOutputValidationError`, with what was thrown as its `cause` and
`zodError` null (it is set only when the schema rejected the output). Input
schemas, guard slices and rate-limit key slices are parsed asynchronously and
may be async.

The options object beside the schemas is where an API declares its policies:

| Field | Purpose |
| --- | --- |
| `input` | Zod schema for the payload. `z.void()` for none |
| `output` | Zod schema for the result, whose JSON form is an object or an array. Type-checked against what the handler returns, and every output is parsed through it before it is sent |
| `guards` | Named guards to run before the handler. See [API policies](./api-policies.md#guards) |
| `rateLimit` | Named rate-limit policies. See [API policies](./api-policies.md#rate-limits) |
| `idempotency` | `true` or `{ ttlSeconds }`. See [API policies](./api-policies.md#idempotency) |
| `refusals` | The codes this API may refuse with, from the vocabulary given at creation: one code or a non-empty list. See [Declared refusals](#declared-refusals) |
| `compress` | Whether this API's answers are compressed for a caller that accepts it: `"auto"` (the default) when the body is large enough to gain, `false` never, `true` always. See [Responses](./responses.md#compression) |

`compress` is a transport setting of this server, not part of the API: it is
not in the contract, the signature or the generated options, and it applies
to whatever the call is answered with short of a crash, a refusal and a
replayed answer included. `false` is for an API whose answer compression
barely helps, such as one carrying a file's bytes as base64 (see
[Responses](./responses.md#compression) for what it does and does not save).

## Session endpoints: the guard decides

An endpoint says who may call it once, in its guards, and whether a session
is needed is part of that answer. A guard declared `session: true` needs one
(see [API policies](./api-policies.md#guards)), and an endpoint declaring such
a guard is a session endpoint: the session is fetched and validated before
the guards run, `ctx.session` is typed present from the instance's session
data type, and a missing or expired session answers the protocol's
`{ sessionExpired: true }` envelope, which `LambderCaller` turns into the
caller's `sessionExpiredHandler`. Every other endpoint is public, and there is
nowhere else to say it, so the mode cannot disagree with the authorization.

```typescript
const lambderApp = initLambder<SessionData>().create({
    apiPath: "/api",
    session,
    guards: {
        // The whole authorization of an endpoint about the signed-in user's own account.
        signedIn: initLambder<SessionData>().guard({ session: true, handler: async () => {} }),
    },
});

export const profileApis = lambderApp.defineApiGroup("profile", {
    get: lambderApp.defineApi({
        input: z.object({}),
        output: z.object({ userId: z.string(), username: z.string() }),
        guards: "signedIn",
    }, async (ctx) => ({
        userId: ctx.session.data.userId,
        username: ctx.session.data.username,
    })),
});
```

A per-session rate limit on an endpoint none of whose guards needs a session
is refused where it is written: a public call carries no session to count
against. A guard that needs a session on an instance created without the
`session` option is refused the same way.

## The inferred contract

```typescript
export const lambder = lambderApp.registerApiGroups(companyApis, profileApis);

export type ApiContractType = typeof lambder.ApiContract;
export const handler = lambder.getHandler();
```

`ApiContract` is a type-only property: it holds every registered endpoint,
keyed `group.action`, as a client calls it. Each declaration is typed on its
own, and the contract of one `registerApiGroups()` call is one flat mapped
type over its groups, so what an endpoint costs the compiler does not grow
with the endpoints registered before it; register every group in one call
where you can. Compile-time refusals at registration: a group typed `any` (its
endpoints would be `any` to every client, which is what a module whose types
were lost would do) and a group name given twice.

A small app's frontend imports `ApiContractType` from here as it is. Getting
the type at all compiles the server's schemas, so a large app writes the
contract out as a generated file instead and has its clients import that; see
[the contract as a generated file](#the-contract-as-a-generated-file).

Each contract entry carries the API's `input` and `output`, its `guardInputs`
when a guardInput-mode guard applies, its `guards` option exactly as
declared (`ApiContractType["orders.refund"]["guards"]` is the literal
`{ readonly staffPermission: "ORDERS.REFUND" }`), and its `refusals`: every code
it can refuse with, its own and its guards', each mapped to `{ data }` (the
data as it arrives) or `{}`. `refusals` is the one member that is not the
option as written, since a reader needs the guards' codes too; see
[Declared refusals](#declared-refusals).

`input` and `output` are the client's side of each schema. `input` is the
schema's input form (`z.input`): a field with a default is optional to send,
and a transformed field is sent as its source type. `output` is what arrives,
the schema's output as JSON (`LambderJsonOf`): a `z.date()` field is a
string, and a function, symbol or undefined member is not there. The handler
sees the other side of both, the parsed input and the output before its
transforms run, and
guard and rate-limit slices over the payload are checked against the form a
client posts.

A client that decides whether to render a screen before calling, by what an
API needs, can read that from a generated file of the guard's parameters
([one guard's parameters, for a browser](#one-guards-parameters-for-a-browser)).
One that keeps its own map pins it to the declarations with `satisfies`
instead of a test that reads the server source:

```typescript
type PermissionNeededBy<K extends keyof ApiContractType> =
    ApiContractType[K] extends { guards: { staffPermission: infer N } } ? N : never;

const NEEDS = {
    "orders.refund": "ORDERS.REFUND",
} as const satisfies { [K in keyof ApiContractType]?: PermissionNeededBy<K> };
```

Renaming the permission on the server, or moving the API to a different one,
then fails the client's map to compile. Make the mapped type non-optional (over
the guarded API names) when the map must also stay complete as guarded APIs are
added.

`LambderContractKeysWithGuard<Contract, "guardName">` is the names of the
endpoints whose `guards` option names that guard, in any of its forms. It is
what a test that calls every endpoint behind one guard loops over, and what a
list meant to hold exactly those endpoints is checked against. `satisfies`
refuses a name the guard does not cover; a name left off the list needs a
check of its own:

```typescript
type AdminApi = LambderContractKeysWithGuard<ApiContractType, "adminOnly">;
const ADMIN_APIS = ["admin.listUsers", "admin.deleteUser"] as const satisfies readonly AdminApi[];
// Fails to compile while an endpoint behind the guard is left off the list.
const adminApisComplete: [Exclude<AdminApi, (typeof ADMIN_APIS)[number]>] extends [never] ? true : false = true;
```

## The contract as a generated file

A client that imports `ApiContractType` from the server's entry compiles the
server to get it: every endpoint's schemas, the libraries they infer through,
and whatever else the entry imports. In a small app that costs nothing worth
measuring. In one with a couple of hundred endpoints it is most of the
client's type check: in a 193-endpoint app, 17 of the frontend check's 19
million type instantiations, and 2.4 of its 4.8 GB, went to deriving again a
contract the server had already worked out.

`writeApiContract` from `lambder/build` writes the contract out once, as plain
types in a module that imports nothing, and the client imports it from there
instead:

```typescript
// tools/generate-api-contract.ts
import { writeApiContract } from "lambder/build";

const result = await writeApiContract({
    module: "backend/index.ts",   // export const lambder = initLambder()...
    exportName: "lambder",        // default: the module's default export
    file: "shared/generated/apiContract.generated.ts",
    check: process.argv.includes("--check"),
});
console.log(result.lines.join("\n"));
process.exit(result.ok ? 0 : 1);
```

```typescript
// in the frontend
import type { ApiContractType } from "../shared/generated/apiContract.generated.js";
```

The contract is the `ApiContract` property of the instance `module` exports,
read through the TypeScript compiler under the server's `tsconfig.json` (the
nearest one above `module`, or the one `tsconfig` names), so path aliases
resolve as they do in the server's own check, and none of the server runs.
The app declares nothing for it. Every type is printed as the structure it resolves to: zod's
inferences, mapped and conditional types and the server's own types become
object types, unions and literals. The default library's interfaces (`Date`)
keep their names. A non-generic named type is printed once, as a declaration
of its own that the entries refer to, which is also how a recursive type (a
tree, a JSON value) refers to itself; any other type that recurses is named
after what it instantiates (`Tree<string>` is `TreeString`). Two types that
want one name (an interface `Row` in two modules) are told apart by a number,
the one declared first, by file and then position, keeping the name.
Properties keep the order they are written in, and names do not follow the
order APIs are registered in, so the file changes only when an API does. The
module exports one type alias, `typeName` (default `ApiContractType`), of an
object type with plain members: reading it is ordinary property access, and as an alias rather than an
interface it has the inferable index signature `LambderCaller`, the mock and
`LambderInvokeCaller` ask for.

Anything with no plain form fails the call and says where it sits: a function,
a symbol-keyed property, an enum, a class's private member, a type parameter
the contract leaves open. So does a type the compiler could not resolve, which
a compile error anywhere in the server's sources leaves in the contract where
a type was meant, and which would otherwise print as `any`; and so does an
entry module that does not compile. Property `readonly` modifiers are not
carried over, since assignability ignores them; readonly arrays and tuples
are. Under `exactOptionalPropertyTypes` an optional member prints as written,
without the `undefined` the compiler adds to it.

Every client of the app is a candidate: the frontend, another service calling
it through `LambderInvokeCaller`, and the app's own tests, which name it in
`lambderTestApp<SessionData, ApiContractType>(lambder)` so their calls are typed
against plain members. The server's own checks against its declarations (a
needs map's `satisfies`, say) keep reading `typeof lambder.ApiContract`, which
is exact and costs a server little.

Before it touches the file, a write compiles the new text beside the server's
sources and checks every entry against the contract in both directions, and
writes nothing when one differs. With `check: true` it writes nothing and fails
when the file on disk is not what the contract prints now, the gate for a CI
step. Either way the result names the APIs that moved (`~ changed`,
`+ added`, `- removed`), counting a change to a named declaration against
every API that reaches it. The check compares text, so keep the file out of
formatters; each declaration carries a `// prettier-ignore` line for Prettier.
`header`, `quotes` and `semicolons` shape the file to the project's style.

The compiler is the `typescript` package
installed beside lambder, 5.4 or later with the compiler API, which means 5.x
or 6.x (an optional peer dependency, left open so an app on TypeScript 7 still
installs lambder): TypeScript 7 ships no compiler API, so an app on 7 gives the
generator a 6.x of its own, in the package the generator script runs from, and
the generator says so when it finds a 7. Reading
the contract compiles the server once, and a write that changes the file
compiles it twice, in the process that calls `writeApiContract`; a large
server's needs a heap to match (`node --max-old-space-size=8192`).
[`generateApiFiles`](#generating-every-file-at-once) prints each contract in
a process of its own with that heap, so a script calling it needs no flag
for it.

## The options as a generated file

The contract carries every endpoint's `guards`, `rateLimit` and
`idempotency` options as types, which is what pins a client-side copy of a
declaration to the server's. Code that has to decide something at runtime
needs the same fact as a value: a mock restating the server's declarations, a
test walking the public surface, a screen asking which permission an endpoint
needs before it offers a control. Without one they copy the declarations by
hand and hold the copies honest with tests that read the source. The file
below is for the first two, which run in development and in tests; a screen
in production reads the smaller file of [one guard's
parameters](#one-guards-parameters-for-a-browser), because this one names
every endpoint.

`writeApiOptions` from `lambder/build` writes the declarations out once, as
three `as const` tables of plain data in a module that imports only types, and
runs beside `writeApiSignatures` in the same generator script:

```typescript
import { writeApiOptions } from "lambder/build";

const result = await writeApiOptions({
    module: "backend/index.ts",   // export const lambder = initLambder()...
    exportName: "lambder",
    file: "shared/generated/apiOptions.generated.ts",
    check: process.argv.includes("--check"),
});
console.log(result.lines.join("\n"));
process.exit(result.ok ? 0 : 1);
```

```typescript
// shared/generated/apiOptions.generated.ts, as written
export const apiOptions = {
    "orders.list": { "mode": "session", "guards": { "store": "ORDERS.MANAGE" } },
    "code.send": { "mode": "public", "guards": "captcha", "rateLimit": { "authPerIp": { "perMin": 3 }, "codePerEmail": true } },
    ...
} as const satisfies Record<string, LambderApiOptionEntry>;

export const rateLimitPolicies = {
    "authPerIp": { "perMin": 10, "perHour": 60, "per": "ip" },
    "codePerEmail": { "perMin": 4, "perDay": 30, "budget": "perPolicy", "per": "custom", "refusal": { ... } },
    ...
} as const satisfies Record<string, LambderRateLimitPolicyEntry>;

export const guardDeclarations = {
    "captcha": { "input": "guardInput", "session": false, "runAt": "afterInputValidation" },
    "store": { "input": "guardInput", "session": true, "runAt": "beforeInputValidation", "refusals": ["not-staff"] },
    ...
} as const satisfies Record<string, LambderGuardDeclarationEntry>;
```

The tables come from `lambder.apiOptionEntries()`, which the generator calls
on the instance the module exports: every API's mode and its declarative
options exactly as written, every rate-limit policy less its key handler, and
every guard's input mode, session requirement, place in the call and refusal
codes, each table sorted by name so the file diffs by endpoint and never
moves when registrations are reordered. The refusal vocabulary itself is not
written: it is shared code, and the mock declares the same object (see
[the mock runtime](./mock.md#declarations-policies-and-guards-from-the-generated-options)).

Nothing in the file is code, by construction. A guard's parameter is written
as the JSON it is, so it has to be plain data (a permission string, a list of
them, a reason); a parameter that is a function, a class instance such as a
zod schema, or anything else JSON would rewrite fails the write and names the
API. A policy's key handler is never written: its `per` says `"custom"` and
no more. A guard's input schema is never written either; its declaration says
only which of the three input modes it has. So no secret can reach the file,
because nothing that could hold one is written.

What reads it derives instead of copying. The tables are `as const`, so the
readers in `lambder/client` answer with literals: `LambderApisWithGuard<typeof
apiOptions, "store">` is the union of the APIs naming that guard,
`apisWithGuard(apiOptions, "store")` that same list as a value, in the
table's order, `LambderApisGuardedBy<typeof apiOptions, "adminOnly">` the
APIs whose guards option is exactly that, `LambderApisWithMode` the APIs of
one mode, and
`apiGuardParam(apiOptions, name, "store")` the parameter the API gave the
guard, typed as the literal it was declared with (`true` for a guard named
without one, `undefined` when the API does not declare it). A test's list of
the APIs behind a guard is then a type rather than a list somebody keeps. The
mock runtime reads its entries' declarations off
the table, rebuilds the policies from it through `lambderMockPoliciesFrom`,
and holds its guards to the declarations; see [the mock
runtime](./mock.md#declarations-policies-and-guards-from-the-generated-options).

With `check: true` the call writes nothing and fails when the file on disk
does not hold what the instance reports now, the gate for a CI step; either
way the result names what moved per table (`~ apiOptions orders.list`, `+
rateLimitPolicies codePerEmail`, `- guardDeclarations device`). The tables
are compared as the data the file holds, so re-indentation or a checkout's
line endings change nothing and a current file is left as it is; the tables
are JSON, double quotes included, whatever the project's style, and each
carries a `// prettier-ignore` line, because a formatter that swapped the
quotes would leave the file unreadable to the check. There is no
fresh-process pass: nothing here is digested, so nothing can differ per
process. `header` and `semicolons` shape the rest of the file.

### One guard's parameters, for a browser

The options file holds every declaration, which is what a mock and a test
need, and more than a browser should carry. A screen that imports
`apiOptions` as a value ships every endpoint's name, its mode and every
guard's parameter, the reason beside an open endpoint included, to every
visitor, which undoes what the contract's type-only import and the
signatures' hashed keys keep out of the bundle. A screen that gates on one
guard needs that guard's parameter, for the endpoints it gates on, and
nothing else. `writeApiGuardParams` writes that guard's parameters beside the
options file, one export per API, so a bundle carries the ones its screens
import and no others:

```typescript
import { writeApiGuardParams } from "lambder/build";

const result = await writeApiGuardParams({
    module: "backend/index.ts",
    exportName: "lambder",
    guard: "store",
    file: "web/src/generated/storeGuardParams.generated.ts",
    check: process.argv.includes("--check"),
});
```

```typescript
// web/src/generated/storeGuardParams.generated.ts, as written
import type { LambderApiGuardParam } from "lambder/client";

/** What orders.list gives the "store" guard. */
// prettier-ignore
export const ordersListGuardParam = "ORDERS.MANAGE" as const as LambderApiGuardParam<"orders.list", "store", "ORDERS.MANAGE">;

/** What staff.invite gives the "store" guard. */
// prettier-ignore
export const staffInviteGuardParam = ["STAFF.MANAGE","ORDERS.MANAGE"] as const as LambderApiGuardParam<"staff.invite", "store", readonly ["STAFF.MANAGE", "ORDERS.MANAGE"]>;
```

One export per API that declares the guard, named after the API
(`orders.list` exports `ordersListGuardParam`) and holding the parameter as
declared (`true` for the guard named without one). A screen imports the
ones it gates on:

```typescript
import { ordersListGuardParam } from "./generated/storeGuardParams.generated";

if (canCall(ordersListGuardParam)) showOrders();
```

The bundler keeps the exports the client imports and drops the rest, and none of
them carries the API's name into the bundle: the name sits in the export's
type and doc comment, which a build strips, and in its identifier, which a
minifier renames. What ships is the parameter alone.

Each export is typed `LambderApiGuardParam<API, guard, literal>`: the
literal the API declared, tagged with the API's name and the guard's in types
alone. A client reads the union of a guard's parameters off the module with a
type-only import, and a function typed to that union takes only generated
parameters, so a hand-written literal, which would restate the server's
declaration and could drift from it, does not compile:

```typescript
import type * as storeParams from "./generated/storeGuardParams.generated";

type StoreGuardParam = (typeof storeParams)[keyof typeof storeParams];
const canCall = (param: StoreGuardParam): boolean => { /* ... */ };

canCall("ORDERS.MANAGE"); // a type error: not a generated parameter
```

A guard the server does not declare fails the write, as do two APIs whose
names would export under one identifier (`order.sList` and `orderS.list`) and
a parameter of `null`, which the tag cannot carry. A guard no API declares
writes an empty module. `check`, `header` and `semicolons` work as they do
for the options file.

### The schemas, for the mock

The server validates every input against its API's zod schema and parses
every output through its schema, which drops the fields the schema does not
declare and fills its defaults. The contract reaches a client as types alone,
so a mock has no schema to do the same with: without one, every payload
reaches its handler, and an answer goes out with whatever the handler
returned. `writeApiSchemas` writes the server's schemas out as data the mock
rebuilds:

```typescript
import { writeApiSchemas } from "lambder/build";

const result = await writeApiSchemas({
    module: "backend/index.ts",
    exportName: "lambder",
    file: "web/src/mock/apiSchemas.generated.ts",
    check: process.argv.includes("--check"),
});
console.log(result.lines.join("\n"));
process.exit(result.ok ? 0 : 1);
```

```typescript
// web/src/mock/apiSchemas.generated.ts, as written
export const apiSchemas = {
    "orders.place": {
        "input": {
            "type": "object",
            "properties": {
                "name": { "type": "string", "minLength": 2, "maxLength": 40 },
                "giftWrap": { "default": false, "type": "boolean" },
                ...
            },
            "required": ["name"],
            "x-lambder-strip-unknown-keys": true
        },
        "output": { ... }
    },
    ...
} as const;
```

The schemas come from `lambder.apiSchemaEntries()`, every API's input and
output by name, and are written as JSON Schema (draft 2020-12) by zod's
`z.toJSONSchema`: the input in its input form, what a client posts (a
defaulted field optional), and the output in its output form, what a client
receives (a defaulted field there), since a mock handler returns its answer
as the client receives it. The module imports nothing and is the same on
every run. A zod object drops the keys it does not declare, which JSON Schema
has no word for, so each such object carries
`"x-lambder-strip-unknown-keys": true` and the mock drops them too; a strict
object carries `additionalProperties: false` and a loose one `{}`, as zod
writes them.

What JSON Schema cannot represent at all (a `z.date()`, a `bigint`, a `Map`,
a `Set`) fails the write, naming the API, the direction and the place, since
the mock would read it differently from the server: declare it as what it is
on the wire, such as `z.iso.datetime()` for a date. What it represents only
in part is written as far as it goes and listed, in the result's `losses` and
a line each:

- a refinement (`.refine()`, `.superRefine()`, `.check()`, a `z.custom()`
  schema): the mock does not run it;
- a transform (`.transform()`, `z.preprocess()`, a codec, `.trim()` and the
  other rewrites, `z.coerce`, `.catch()`): the mock does not apply it, so its
  handler reads the input as posted;
- the second schema of an input's `.pipe()`: the mock does not check it;
- a default a function computes on each parse: left out of the file.

```text
✓ Wrote web/src/mock/apiSchemas.generated.ts (4 APIs)
  apiSchemas: 0 changed, 4 added, 0 removed (0 unchanged)
  ...
  1 API carries what JSON Schema cannot hold, which the mock does not check:
  ! tickets.open input #/properties/seat: a refinement, which the mock does not run
```

The file names every endpoint and every field each takes and gives, which is
what the contract's type-only import keeps out of a browser, so it is for
development alone: [the mock](./mock.md#validating-against-the-servers-schemas)
imports it from its setup, which a production build never loads. `check`,
`header` and `semicolons` work as they do for the options file.

### Generating every file at once

Each writer above is a function a generator script calls. A script that
writes several of them, for several instances (a server and a function it
invokes, say), calls `generateApiFiles` once with every file it owns:

```typescript
import { generateApiFiles } from "lambder/build";

const result = await generateApiFiles({
    apps: {
        server: {
            module: "backend/index.ts",
            exportName: "lambder",
            tsconfig: "backend/tsconfig.json",
            contract: { file: "shared/generated/apiContract.generated.ts" },
            signatures: { file: "shared/generated/apiSignatures.generated.ts" },
            options: { file: "shared/generated/apiOptions.generated.ts" },
            guardParams: [{ guard: "store", file: "web/src/generated/storeGuardParams.generated.ts" }],
            schemas: { file: "web/src/mock/apiSchemas.generated.ts" },
        },
        imaging: {
            module: "imaging/index.ts",
            exportName: "lambder",
            contract: { file: "backend/generated/imagingApiContract.generated.ts", typeName: "ImagingApiContract" },
        },
    },
}, { check: process.argv.includes("--check") });
console.log(result.lines.join("\n"));
process.exit(result.ok ? 0 : 1);
```

- Each app gives its module once, for every file it is written to; each
  file takes the options its writer takes (`header`, `quotes`,
  `semicolons`, `typeName`, `guard`). Paths are relative to the working
  directory, as each writer takes them.
- The contracts are read first, through the compiler alone, each in a Node
  process of its own; then each module is imported once, in the script's
  process, and its signatures, options, guard parameters and schemas are
  written from that one instance.
- A contract's process is started with none of the script's command-line
  flags and a heap of `contractHeapMegabytes` (default 8192, Node's
  `--max-old-space-size`), which compiling a large server needs. The
  compiler imports none of the app's modules, so it needs no loader, and the
  script's own heap matters only to what it imports. Its answer is
  `writeApiContract`'s, the lines of a contract that could not be read or a
  stale file and the error of a writer that threw alike; a process that runs
  out of its heap fails its contract, saying to raise the option.
- A writer that fails does not stop the others: one call names every stale
  or broken file, and `ok` is false when any is. A config naming no apps, an
  app written to no file, a key the call does not read, or a
  `contractHeapMegabytes` that is not a whole number of megabytes throws.
- The script runs under whatever loader the app's modules need, for the
  signatures, options and guard parameters; its flags reach the fresh
  process the signatures are verified in.

## Groups across files, and lazy groups

A module exports its groups, and the entry registers them. A group only
some requests call can be registered lazily: `lazyApiGroup(name, load)`
imports it on the first call to one of its endpoints, so a cold start parses
none of it, nor anything only it imports, until then.

```typescript
// users.ts
import { z } from "zod";
import { defineApi, defineApiGroup } from "./app";

export const userApis = defineApiGroup("users", {
    get: defineApi({
        input: z.object({ id: z.string() }),
        output: z.object({ id: z.string(), name: z.string() }),
        guards: "signedIn",
    }, async (ctx) => ({ id: ctx.apiPayload.id, name: "User" })),
    create: defineApi({
        input: z.object({ name: z.string(), email: z.string() }),
        output: z.object({ id: z.string() }),
        guards: "signedIn",
    }, async () => ({ id: "123" })),
});

// index.ts
import { lambderApp, lazyApiGroup } from "./app";
import { userApis } from "./users";

export const lambder = lambderApp.registerApiGroups(
    userApis,
    // Loaded, and its registration checked, on the first call to reports.*.
    lazyApiGroup("reports", () => import("./reports").then((m) => m.reportApis)),
);

export type ApiContractType = typeof lambder.ApiContract;
export const handler = lambder.getHandler();
```

A group too large for one file is declared in parts, one per file, each a
plain object of endpoints, and assembled where it is registered or in a file
of its own. An action two parts declare is refused, at compile time and at
startup, rather than one silently replacing the other as a spread would:

```typescript
// orders/read.ts
export const orderReadApis = {
    get: defineApi({ /* ... */ }, async (ctx) => { /* ... */ }),
    search: defineApi({ /* ... */ }, async (ctx) => { /* ... */ }),
};

// orders/write.ts
export const orderWriteApis = {
    place: defineApi({ /* ... */ }, async (ctx) => { /* ... */ }),
};

// orders/index.ts
export const orderApis = defineApiGroup("orders", orderReadApis, orderWriteApis);
```

A lazy group's contract is the loaded group's, read off its type, and the
group it loads must carry the name it was registered under. Its registration
runs when it loads, so a build step or a boot check that has to see every
endpoint calls `await lambder.loadApiGroups()` first; `apiSignatures()`,
`apiSignatureEntries()` and `apiOptionEntries()` do so themselves.

The groups of one `registerApiGroups()` call take their place in the
first-match chain where the call stands, as a route does: a route or action
registered before them sees their calls first, and one registered after them
never does. A call to an action its group does not have is answered as any
unmatched API call is, the fallback hooks first. The beforeRender hooks run
before a lazy group loads, so a hook that refuses a request (a gate on a
staging host, say) with a response spares it the import. A hook that throws
a refusal, or charges a per-API budget, loads the group instead, since the
refusal is checked against the endpoint called and the budget counted
against it, as for an eager group.

A request under `apiPath` that nothing matched is the API's to answer: a GET
to a call path, or a path of another depth, is answered as an unknown API
rather than by the public files, the shell or the route fallback. A root
`apiPath` (`"/"`) shares every path with the site, the site root included, so
there only the calls are the API's, and every other request walks the
fallback chain.

`use(plugin)` hands the instance to a function that registers routes, hooks
or actions on it and continues the chain; endpoints are registered as groups,
never through it.

## Request flow per API

An API call is a POST to `{apiPath}/{group}/{action}` with
`Content-Type: application/json`, which every Lambder caller sends; the body
carries the envelope (payload, version, signature, CSRF token, guard inputs,
idempotency key), and the endpoint is the path, so a gateway, a CDN and a log
can meter, limit and read calls per endpoint without opening the body. A
body that is not a JSON object (a number, a string, `true`, `null`, an array,
or not JSON at all) carries no envelope, and is answered
`lambder/invalid-request-payload` (400) before any hook or route sees the
call. A POST of any other type is not an API call and reaches the API
fallback. A JSON POST to `apiPath` itself whose body names an endpoint is how callers
posted before endpoints had paths: it comes from a page built then, and is
answered `versionExpired`, which reloads the page. JSON is the one type a browser
will not send cross-origin without asking first, so this is what puts every
cross-origin call through the CORS config: a plain HTML form on another site
could otherwise post a login envelope (`enctype="text/plain"` lays out JSON
exactly) and plant the attacker's session in a visitor's browser.

```
envelope check → version floor → signature gate → payload restore
  → rate limits keyed on the request alone (per: "ip")
  → session (endpoints whose guards need one)
  → idempotency replay lookup
  → rate limits keyed per session (per: "session"), and custom keys
    charged before the guards (chargeAt: "beforeGuards")
  → guards
  → zod validation
  → guards placed after validation (runAt: "afterInputValidation")
  → rate limits keyed by a custom key (a payload field), by default
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
sends, or an `apiInput` slice of the payload), whether the endpoint takes
an idempotency key, and every refusal code it can send with its data's
schema. Rate limits, guard parameters and the handler are not
part of it, because changing them changes nothing for a client.

The refusal codes count in full, a guard's included: a client's refusal type
lists exactly the codes the endpoint declares, so a client built before a code
existed would be handed one its types say cannot arrive. Adding a code, or
changing a code's data, reloads that endpoint's clients on the next deploy; a
code added to a guard reloads every endpoint declaring the guard. A code's
data is received, so it is digested in the output position, where an
extensibleEnum's values leave the digest. The schemas
are digested as zod emits them, descriptions included, with two edits: the
`default` keyword is dropped, because a default's value is server behaviour
rather than shape and a function default would write a fresh clock reading or
random value on every conversion (whether the field may be omitted stays,
through `required`); and `required` lists are sorted, so reordering fields
changes nothing. What JSON Schema cannot express (a transform's output, a
custom check) digests as `{}`.

A list that grows with the product (roles, permissions, statuses, locales) is
the one shape change that usually reaches no client, and the digest cannot
tell that on its own. Carried in a widely returned payload such as a session,
one new permission would change the signature of every endpoint returning
it. Mark such an enum with `extensibleEnum` where the schema is declared, and
its values leave the digest wherever it is output:

```typescript
import { extensibleEnum } from "lambder/client";

export const PermissionSchema = extensibleEnum(z.enum(["users.read", "users.manage"]));
```

The mark is a promise that every reader tolerates a value it was not built
with (a fallback label, a permission check that ignores what it does not
know), and nothing checks it: a client that switches over every value with no
default renders a new one as nothing, or throws. Where the enum is input its
values still count, because a value removed from the list is a request an
older client may still send and the server now refuses, so a client that
sends the list back reloads before it can. The schema's type and its
validation are unchanged on both sides. The mark is zod metadata, so an enum
rebuilt from a marked one (`z.enum(marked.options)`) is unmarked and counts in
full, which costs a reload rather than missing one.

One rule follows for the schemas themselves: build them from static values. A
schema that reads the clock, a random source or the environment when it is
constructed (`z.number().max(Date.now())`, an enum from a directory listing)
digests differently on every build, so that endpoint's clients reload on every
deploy whether or not it changed. `writeApiSignatures` below catches that
before a deploy, by checking what it wrote from a second process.

`lambder.apiSignatures()` returns every registered endpoint's signature,
keyed by the endpoint's hashed name, as a `LambderApiSignatureMap`, and
`writeApiSignatures` from `lambder/build` writes it to the module both the
frontend and the server ship with. A generator script names the module that
exports the finished instance, as it does for `writeApiContract`, and the
function imports it; run it before every build, not by hand:

```typescript
// tools/generate-api-signatures.ts
import { writeApiSignatures } from "lambder/build";

const result = await writeApiSignatures({
    module: "backend/index.ts",   // export const lambder = ..., with every API registered
    exportName: "lambder",        // default: the module's default export
    file: "shared/generated/apiSignatures.generated.ts",   // importable by the frontend and the server
    check: process.argv.includes("--check"),
});
console.log(result.lines.join("\n"));
process.exit(result.ok ? 0 : 1);
```

It says which endpoints moved since the file on disk, by name (`~ echo`,
`+ added`; a removed endpoint by its key, since a key is a one-way hash of a
name that no longer exists), which is how wide the next deploy's reload will
be. With `check: true` it writes nothing and fails when the file is stale, the
gate for a CI step. The comparison reads the map the file holds, so a checkout
that rewrote its line endings, or a formatter that re-indented it or took the
quotes off its keys (Prettier's default `quoteProps`, Biome's, ESLint's
`quote-props`), leaves it current, and it is not rewritten either: the file is
written only when its map changes, to a temporary file renamed over the old
one, so a build reading it meanwhile never sees half of it. A symlink is
written through, to the file it names. The map carries a `// prettier-ignore`
line, so Prettier leaves it as written. `header`, `quotes` and `semicolons`
shape the file to the project's style, and a change to them shows with the
next change of the map (or after deleting the file).

`module` is a path relative to the working directory, or a file URL, as a
`URL` (`new URL("../backend/index.ts", import.meta.url)`) or as the string
`import.meta.resolve()` answers. It is imported in the generator's own
process, so a TypeScript module needs the loader the script runs under
(`tsx`, `node --import tsx`). A module that does not load, or an export that
is not an instance, throws before anything is written.

After a write, and after a check that finds the file current, the file is
checked again from a fresh Node process, which is where a schema that digests
differently in every process (it reads the clock or a random source) shows,
named, rather than as signatures that change on every build.
`verifyInFreshProcess: false` skips it. The fresh process loads the module
alone, never the generator script, so nothing the script does before or after
the call runs twice; the module's own top-level code runs there, as it would
for any import of it. The process gets the generator's Node flags less the
inspector, watch mode, the test runner and the eval flags (`-e`, `-p`, `-pe`,
`--input-type`), so a TypeScript module loads there as it did in the
generator when its loader is on the command line (`node --import tsx`, the
`tsx` CLI) or in `NODE_OPTIONS`. A loader registered from inside the script is
not there, and a module that fails to load there fails the check with the
reason.

`lambder.apiSignatureEntries()` is the same signatures with the endpoint name
each one came from, sorted the same way, which is what the naming above reads.
The map carries no names on purpose, and the entries are a build-time view by
construction, coming off the server instance that a generator imports and a
client never does.

The frontend passes the map to `LambderCaller` as `apiSignatures`, the server
passes the same map to `create()` as `apiSignatures`, and every call then
carries the signature of the endpoint it names. The server compares it with
its own copy of the map. A match runs. A mismatch answers the `versionExpired`
envelope, which reaches the caller's `versionExpiredHandler` (usually a
reload). A signed call for a name the map does not hold answers
`versionExpired` as well, since the client was built against a contract that
had it. A call carrying no signature is never gated, so a script, a test or a
client built without the map is served whatever it was built against.

Both sides read the one file on purpose. Nothing is digested at request time,
so the two sides cannot disagree on a digest: the only computation is the
generator's, and a schema it happens to digest differently on two builds costs
its clients a reload, never a refused endpoint.

What this buys is that a deploy forces a reload only on the clients that call
an endpoint whose shape actually changed; an open tab whose endpoints are
unchanged keeps working. `apiVersion` gates nothing on its own: it is stamped
on every answer's envelope so a client can tell which build answered.

The one version check is `minApiVersion`, a floor under the gate: a
client naming a version below it is answered `versionExpired` whatever its
signatures say. That is the lever for a change the digest cannot see, a
security fix or a field whose meaning changed under the same shape. Set it to
the oldest build you are still willing to serve. Versions compare as dotted
numbers, so `1.2.10` is above `1.2.9`, and both `apiVersion` and
`minApiVersion` have to be written that way: a stamp the comparison cannot
read (`"dev"`, a commit sha) would count as zero and answer `versionExpired`
to every client of the build that set it, so it is refused at creation
instead. A floor above `apiVersion` is refused at creation too, since it would
refuse the build's own clients: `apiVersion: "1.2.0"` with
`minApiVersion: "1.5.0"` throws.

A frontend shipped with a stale map would answer `versionExpired` on a changed
endpoint, reload, and get the same bundle back. `LambderCaller` breaks that
loop (see [Frontend client](./client.md#the-signature-map)), but the fix is to
generate the file as part of the build so it can never be stale.

## Refusals

A refusal ("you are not allowed", "quota exceeded") is not a crash, and it is
not an output either. An API handler refuses by throwing, with `ctx.refuse()`,
`refuse()` or a `LambderApiRefusal`, and the throw may come from anywhere in
the call's stack: the handler, a guard, a hook, or a shared helper (a
permission check, a validator) that knows nothing about the request it runs
in. It is rendered as the refusal envelope by the core's one mapping, the same
on the server and in the mock runtime.

A refusal is never stored as an idempotent answer: a retry under the same key
runs the handler again, which decides afresh (see
[API policies](./api-policies.md#semantics)).

### `refuse()`

The one-liner for the common case. Callable from anywhere in an API call's
stack, it throws a refusal carrying the standard message shape
(`{ type, code?, title?, content, data? }`) that the pipeline maps onto the
envelope's `refusal`, so refusals never pollute crash logging and clients
get a parseable response:

```typescript
import { refuse } from "lambder";

if (!row) refuse("Record not found.");                                  // { type: "warning", content }
if (!isAdmin) refuse("Admins only.", { notAuthorized: true });          // + envelope flag
refuse("Too many attempts.", { type: "error", statusCode: 429 });       // custom rendering intent + status
if (exists) refuse("Already reported.", { code: "already-reported" });  // + a declared code (below)
// TypeScript applies never-return narrowing: after `if (!row) refuse(...)`, row is defined.
```

`refuse(content, options?)` takes `type` (`"warning"` by default, or
`"error"` or `"info"`), `code` and `data` (a declared code and its data; see
below), `title`, the envelope flags `notAuthorized` and `sessionExpired`,
`statusCode` (200 by default: the envelope is the channel, so avoid 5xx,
which a caller reads as a crash, and 422, which is input validation's),
`headers` for the refusal's answer (a `Retry-After`, say) and `cause`, kept
on the thrown error. A refusal that leaves with `sessionExpired`, set here or
by its declared code, also ends the session the call held: the server
deletes it, so it is over on both ends, and leaves the cookies alone, as it
does when its own session read finds none (see
[Sessions](./sessions.md#session-expired-responses)).

### Declared refusals

`code` is the refusal's identity for machines: clients branch and translate on
it (a translated client never displays `content`, it looks the code up), and
`content` stays the human-readable fallback. An app declares its codes once,
as a vocabulary on the init, each with the schema of the data it carries or
none, the status every refusal with it leaves with and whether it sets the
`notAuthorized` or the `sessionExpired` flag; every API names the codes it
may refuse with, and so does every guard:

```typescript
const lambderInit = initLambder<SessionData>().declareRefusals({
    "order-closed": { status: 409 },
    "wallet-short": { data: z.object({ available: z.number(), currency: z.string().default("USD") }) },
    "not-a-manager": { notAuthorized: true, status: 403 },
    "login-gone": { sessionExpired: true },
});

const managerOnly = lambderInit.guard({
    session: true,
    refusals: ["not-a-manager"],
    handler: (ctx) => {
        if (ctx.session.data.role !== "manager") ctx.refuse("Managers only.", { code: "not-a-manager" });
    },
});

export const lambderApp = lambderInit.create({ apiPath: "/api", session, guards: { managerOnly } });

export const orderApis = lambderApp.defineApiGroup("order", {
    pay: lambderApp.defineApi({
        input: z.object({ orderId: z.string(), amount: z.number() }),
        output: z.object({ paid: z.literal(true) }),
        guards: "managerOnly",
        refusals: ["order-closed", "wallet-short"],
    }, async (ctx) => {
        const order = await loadOrder(ctx.apiPayload.orderId);
        if (order.closed) return ctx.refuse("This order is closed.", { code: "order-closed" });
        if (order.wallet < ctx.apiPayload.amount) {
            return ctx.refuse("The wallet holds less than the total.", { code: "wallet-short", data: { available: order.wallet } });
        }
        return { paid: true };
    }),
});
```

- **The vocabulary** (`declareRefusals` on the init) holds every code once, so
  a code means one thing wherever it is raised: one data shape, one status
  (200 unless the declaration says otherwise, never 422 or a 5xx, which a
  reader files as something else) and one answer to whether it sets a flag:
  `notAuthorized` for a caller that is not allowed, or `sessionExpired` for a
  session the handler found no longer good (its login deleted, say), which a
  caller answers as it does the pipeline's own and which ends that session on
  the server. A code is the string that
  goes on the wire, anything outside the framework's `lambder/` prefix; its
  data, when it declares any, is an object or an array, as an output is. A
  misspelled declaration key, a `lambder/` code, a 422 or 5xx status and a
  flag other than `true` are compile errors and errors at the call, and a
  code declaring both flags is an error at the call, since a caller routes a
  refusal one way. An app made of parts
  declares one map of codes per part and hands `declareRefusals` the list,
  `declareRefusals([orderRefusals, walletRefusals])`, as it hands `create()`
  its guards and policies; a code two maps declare is a compile error and a
  throw at the call.
- **An API's `refusals` option** names one code or a non-empty list. A code
  the vocabulary does not hold is a compile error and a registration error.
  `create()` itself takes no vocabulary: the init carries it.
- **A guard's `refusals` option** names the codes the guard raises; they join
  the codes of every API that declares the guard. A guard built with the
  init's `guard()` has `ctx.refuse` typed to those codes and is refused as it
  is built when it names a code the vocabulary does not hold; one built with
  the standalone `lambderGuard()` meets the vocabulary at `create()`.
- **`ctx.refuse(content, options?)`** on an API handler's context takes
  `refuse()`'s arguments typed to the endpoint: `code` is one of its codes,
  `data` is required where that code declares data and refused where it does
  not, and a declared code takes no `statusCode` or flag of its own, since
  its declaration owns them. TypeScript narrows the code after a
  never-returning call only when every name in the call is explicitly
  annotated, which a handler's `ctx` is not, so write `return ctx.refuse(...)`
  where the lines after it rely on it. A shared helper or a hook, with no
  endpoint in hand, raises a code with the init's `refuse`, typed to the
  whole vocabulary, or with the free `refuse()`; which endpoint may send the
  code is checked where the refusal is rendered either way.
- **`declareRefusals(vocabulary, { requireCodes: true })`** makes every
  refusal an API answers with name a code: an uncoded `refuse("...")` from a
  handler, a guard or a helper is then a crash rather than an answer,
  `ctx.refuse` and the init's `refuse` require a code, and a translating
  client never meets a refusal it cannot look up. Framework codes still pass,
  and a hook's or an error handler's `res.apiRefusal()` may still answer
  without one.

**The declaration is enforced where a refusal is rendered.** The pipeline
checks every thrown refusal against its endpoint: an uncoded refusal and a
framework code go out as they are; a declared code leaves with its
declaration's status and flag and has its data parsed through the code's
schema (synchronously, as an output is: undeclared fields stripped, defaults
filled, transforms run), and the parsed data is what is sent. Anything else
is a crash rather than an answer (`LambderApiRefusalValidationError`, naming
the code and the failing paths but never the values, with the refusal as
thrown as its `cause`): a code the endpoint does not declare, data on a
refusal whose code declares none, no data on one whose code carries data,
data its code's schema rejects, `lambder/rate-limited` without its policy
and wait, a declared code raised with a status or flag of its own, or an
uncoded refusal where the app requires codes. A refusal a
hook throws for an API call is checked against the endpoint the call names,
and one for a name no API is registered under may carry a framework code or
none. A test run over `lambder/testing` surfaces the crash at once, which is
where an undeclared code is found.

**What a caller reads is exact.** The contract entry records every code the
endpoint can refuse with, and the caller's outcome types `refusal` as one
arm per code plus one for the framework's codes and the uncoded refusal, so a
`switch (message.code)` narrows `data` in each case and a `default: never`
holds:

```typescript
const outcome = await caller.apiOutcome("order.pay", { orderId, amount });
if (!outcome.ok && outcome.refusal?.code === "wallet-short") {
    showTopUp(outcome.refusal.data.available);   // typed { available: number; currency: string }
}
```

`LambderContractRefusalMessage<Contract, "order.pay">` is that message type
for code that holds one outside an outcome, and
`LambderContractAnyRefusalMessage<Contract>` the same across every endpoint,
what a caller's constructor `refusalHandler` is handed. A test asserts on
the code rather than the wording, with `assertApiRefusal(outcome,
"wallet-short")`, which narrows `outcome.refusal.data` to the code's type
(see [Testing](./testing.md#asserting-on-outcomes)). The declared codes are
part of the endpoint's signature (see
[Signatures](#signatures-when-a-client-must-update)).

### Checking what a handler can reach

A handler's `ctx.refuse` is typed to its endpoint's codes, so a wrong code
written in the handler does not compile. A shared helper's refusal cannot
be held that way: it raises with the init's `refuse` or the free `refuse()`
because it serves many endpoints, and a code it raises for one that does
not declare it compiles, and crashes only when a call reaches that line.
`checkApiRefusals` from `lambder/build` closes the gap. It reads the project
through the TypeScript compiler, and for every handler Lambder hands a typed
`refuse` (an endpoint's, a guard's, a mock entry's) follows the handler into
every function it can reach: what it calls, a method of what it constructs,
a function it hands along, a module it loads with `import()`. A handler need
not be written in place: one the app wraps or holds in an object is followed
through the wrapper's argument or the property. Every code raised there is
held to the codes the handler's `ctx.refuse` takes, the ones the type system
computed from the endpoint's declaration and its guards'. A refusal class of
the app's own counts where it is constructed, whether it declares a
constructor or inherits `LambderApiRefusal`'s.

```typescript
import { checkApiRefusals } from "lambder/build";

const result = await checkApiRefusals({ tsconfig: "server/tsconfig.json" });
console.log(result.lines.join("\n"));
process.exit(result.ok ? 0 : 1);
```

It names six things: a code a handler can reach and may not send, with the
line that raises it; a code a handler's own `refusals` option names that
nothing it reaches raises, which a caller would be told to handle for
nothing; a refusal with no code, where `requireCodes` (the default) says
codes are required; a refusal whose code is typed as any string, since
nothing can say which code it will send; a handler whose function it
cannot find, such as the parameter of an app's own wrapper around
`defineApi`, since nothing it reaches was checked; and a handler handed no
typed `refuse`, since there is nothing to hold what it reaches to. The last
is a guard built by an init that declared no vocabulary and given no
`refusals` option, a mock guard from `initLambderMock()` without
`declareRefusals` most often: declare the vocabulary on that init, or give
the guard the codes it may send (`refusals: []` for none). A project in which
it finds no handler to check fails too, rather than passing with nothing
checked. `requireTypedRefuse: false` lets a handler handed no typed `refuse`
stand, listed in the lines and not a finding. A mock guard built by a mock
init that declared the vocabulary is checked as a server guard is, against
its own `refusals`, which a mock given the `guardDeclarations` table holds
to the server guard's (see [the mock
runtime](./mock.md#declarations-policies-and-guards-from-the-generated-options)).
A refuse counts however the app names it: imported under another name, held
in a variable, destructured under another name, or passed as a parameter
typed as one.

A code held in a constant reads as its literal. A code a helper takes as a
parameter reads as every code the parameter's type allows, at every call of
the helper: the check does not follow which one each caller passes, so such
a helper is best split into one per code. It follows the project's own code
alone: a dependency's functions are not read, and a call through an
interface with nothing behind it reaches nothing. Run it where the app runs
its other build checks, or from a test; it compiles the project, so it
takes as long as a type check.

### Framework codes

The framework stamps the refusals it authors itself with
`LAMBDER_REFUSAL_CODES` (exported from `lambder` and `lambder/client`) under
the reserved `lambder/` prefix, so app codes never collide. No API declares
them: every endpoint may send them. One carries data, `lambder/rate-limited`;
the others carry none.

| Constant | Code | Raised when |
| --- | --- | --- |
| `rateLimited` | `lambder/rate-limited` | A rate-limit policy refused (429). Its data is `{ policy, retryAfterSeconds }` (`LambderRateLimitRefusalData`): the policy's name and the `Retry-After` header's seconds |
| `duplicateInFlight` | `lambder/duplicate-in-flight` | The original of an idempotent request is still running (409) |
| `idempotencyKeyReused` | `lambder/idempotency-key-reused` | The `idempotencyKey` was first used for a request with another payload, or another guard input that counts (409) |
| `invalidIdempotencyKey` | `lambder/invalid-idempotency-key` | The `idempotencyKey` is malformed (400) |
| `apiNotFound` | `lambder/api-not-found` | No API is registered under the requested name |
| `invalidRequestPayload` | `lambder/invalid-request-payload` | The call's body is not a JSON object, or a compressed request payload (`payloadGz` or `payloadBr`) is malformed, carries both fields, or exceeds `maxRequestPayloadBytes` (400) |
| `notMocked` | `lambder/not-mocked` | The mock runtime was asked for an endpoint registered as `notMocked` (200; the mock runtime only) |
| `uploadEmpty` | `lambder/upload-empty` | An upload bucket was asked to sign a ticket for a file with no bytes (see [Direct uploads](./uploads.md)) |
| `uploadTypeRejected` | `lambder/upload-type-rejected` | An upload bucket was asked to sign a ticket for a content type the rule does not accept |
| `uploadTooLarge` | `lambder/upload-too-large` | An upload bucket was asked to sign a ticket for a file larger than the rule accepts |

A rate-limit refusal is always `lambder/rate-limited`: a policy's
`refusal` sets its type, title and content, and a code or data there is
refused at creation. Its data names the policy that refused, so a
`refusalHandler` treats every rate limit alike or words each policy its own
way, and the policy's name reaches every client (see [What a client
reads](./api-policies.md#what-a-client-reads)). The code is sent only with
that data: a `refuse()` with it and without the data is a crash, and
`res.apiRefusal` does not take it.

`LambderRefusalMessage` with no argument is the framework's codes and the
uncoded refusal alone, so a `default: never` assertion holds over it and a
framework code added in a later version breaks the switch rather than
falling through it. `lambder/rate-limited` is an arm of its own, so its case
reads `message.data.policy` typed, and the switch narrows the whole message:
the assertion is `const unreachable: never = message`. Messages an app WRITES outside a handler take
`LambderUncheckedRefusalMessage`, where any code is welcome: that is what
`LambderApiRefusal` carries before its endpoint checks it.

### `LambderApiRefusal`

For full control of the `refusal` payload, throw `LambderApiRefusal`
directly; `refuse()` is sugar over it:

```typescript
import { LambderApiRefusal } from "lambder";

// In any helper, with nothing of the request in hand:
export const requirePermission = (granted: boolean) => {
    if (!granted) throw new LambderApiRefusal("Permission denied.", {
        notAuthorized: true,                                         // envelope flag -> caller's notAuthorizedHandler
        refusal: { type: "warning", content: "Not allowed." },  // a declared code goes in `code`, its data in `data`
        // sessionExpired: true,                                     // optional envelope flag
        // statusCode: 403,                                          // optional; default 200 (avoid 5xx and 422)
        // headers: { "Retry-After": "30" },                         // optional response headers
    });
};
```

`refusal` defaults to `{ type: "error", content }` with the error's
message as the content, so `throw new LambderApiRefusal("Nope.")` alone is
already visible to the client.
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
