# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries are grouped by the published npm version; a minor line's feature notes
sit on its first published patch, and later patches list only what they changed.
Releases up to 3.2.6 carry git tags; the ones after it were published without
one, so versions are not cross-linked to tag comparisons here.

## [8.0.2] - 2026-09-25

A major, out of a review of 7.3.1. Most of it closes holes: session writes
that could undo a logout or a password change, a login any website could
submit through a plain form, output fields that reached the client past their
schema, rate limits an IPv6 client or a guessed key could step around, and
idempotency keys that replayed another request's answer. The rest makes the
framework behave the same on every gateway, and in the mock as on the server,
and adds crash reporting, `ctx.sessionController`, `ctx.rateLimit`, the memory
cache and `writeApiSignatures`.

The wire format is unchanged in both directions apart from one new refusal
code (`lambder/idempotency-key-reused`, 409) and an `errorMessage` that is
always the message object (a 7.x caller already read both forms), so a
deployed callee and a 7.x client still understand each other. The one
exception is a 7.x `LambderInvokeCaller` call that forwarded a Content-Type of
its own in `headers`: it won over the JSON one there, and an 8.x callee does
not read such a call as an API call.

Stored state mostly carries over, with three exceptions. Every live session
is signed out once: a session record carries `dataVersion` now, and a 7.x
record, which has none, reads as no session until its TTL retires it (the
partition key is an HMAC of the sessionKey now as well, so a new session
never lands in a 7.x partition). An idempotency record a 7.x server wrote
carries no fingerprint, and until it expires a key that finds one is refused
as reused (409, which a key scope moves past) rather than replayed. A 7.x
cache `lock` item is ignored and expires by its TTL; cached values read as
before.

The compiler finds most of what an upgrade from 7 has to change: the session
and idempotency store contracts, the session crypto, the contract's input and
output types, the context's new members. Fourteen it cannot:

- A hand-built API call (fetch, curl, a tool) has to send
  `Content-Type: application/json`, or it is not an API call at all.
- A hand-built API answer (an MSW handler, a test stub, a proxy) has to carry
  `apiVersion` (`null` will do), or the caller reads it as a `server`
  failure rather than a success.
- A handler whose payload does not match its output schema now crashes, and
  extra fields it returns are stripped before they are sent, a refusal's
  payload included. An output schema with an async refinement or transform
  crashes on every call (`LambderApiOutputValidationError`) rather than
  answering; move the async check into the handler.
- `ctx.path` is decoded, so code that decoded it itself decodes twice. A
  percent sign in it is kept as `%25` (see below).
- String routes match case-sensitively: `/Admin` no longer reaches
  `addRoute("/admin")`. Register each spelling an app answers, or use a
  RegExp with the `i` flag.
- Behind a REST API, compression is off until `compression` is named, and
  binary files and compressed answers need `binaryMediaTypes: ["*/*"]`.
- The IAM policies need two more actions. The session table needs
  `dynamodb:UpdateItem`: every renewal and data write is an `UpdateItem`
  where 7.x used `PutItem`. Without it every `updateSessionData` fails its
  request, and renewal writes fail and are logged, so sessions stop sliding
  and users are signed out once their TTL runs from creation. The rate-limit
  table needs `dynamodb:GetItem`, for the read on a throttled partition;
  without it every key-range throttle goes to `failOpen`.
  `docs/dynamodb-tables.md` lists both.
- A custom-keyed rate limit is charged after the guards. A limit meant to
  count the wrong guesses of something a guard checks (a one-time code keyed
  per email) counts none of them until its policy says
  `chargeAt: "beforeGuards"`.
- An idempotency key belongs to the request it was first sent with. A
  single-use token carried inside the payload (checked by an `apiInput`
  guard) makes every genuine retry a 409 `lambder/idempotency-key-reused`:
  move it to `guardInputs`. A client that sends one fixed key with edited
  requests gets the same 409.
- `errorMessage` is always `{ type, content }` on the wire. A client that is
  not a Lambder caller (a native app, a script, a test asserting on the raw
  envelope) and read a string reads the object's `content`.
- `cors: { credentials: true }` with every origin allowed makes `create()`
  throw at cold start: name the origins, or a predicate.
- Templates refuse more slot positions when they compile: inside a tag where
  an attribute name goes (`<input <!--slot:x/-->>`), inside the quoted value
  of an `on*` attribute, `style` or `srcdoc`, inside a comment right before a
  `-`, `!` or `>` that a value ending in `--` would turn into its end, and
  wherever the branches of an if/else (or a slot's default content and its
  value) leave the HTML in different positions before the next slot or block.
  A URL attribute whose scheme a slot can reach renders `about:invalid` unless
  the scheme is http, https, mailto or tel. `` html`...` `` and `` xml`...` ``
  apply the same rules to their interpolations and throw when called, not
  compiled, so a call site that interpolates into one of those positions fails
  on its first render.
- The session controller's `refreshSessionData()` and `updateSessionData()`
  throw `LambderSessionNotFoundError` where they answered null, and an API
  call answers that as `sessionExpired`, a public API's included. A call site
  written `(await refreshSessionData())?.data ?? null` still compiles and
  never sees its null: catch the error where a signed-out answer is meant.
- A schema field annotated `z.ZodType<T>`, or built with `z.coerce` or
  `z.preprocess`, has `unknown` as its input, and the contract's `input`, the
  handler's `res.api` type and the guard and rate-limit slices read `z.input`
  now, so such a field goes unchecked on the typed caller and in the handler.
  Annotate it `z.ZodType<T, T>`, or write `satisfies` in place of `as`.

### Added

- **`runAt: "afterInputValidation"` on a guard** runs it after the input schema
  passes rather than before: for a guard that spends something on the
  request, such as a single-use captcha token, which a request refused for a
  mistyped field would otherwise have wasted. Default placement is unchanged.
- **`trustedHostHeaders`**: headers that may name the host the viewer asked
  for, e.g. `["x-forwarded-host"]` for a Function URL behind CloudFront, which
  sends the origin its own lambda-url Host, so cookie domains and host
  routing saw the wrong host. Nothing is trusted by default, as with
  `trustedClientIpHeaders`, and a value that is not a host is not taken.
- **`notFoundStatuses` on `LambderHttpFileSource`**: the statuses read as "no
  such file" (default below).
- **Mock `onInvalidInput`**: the answer to an input that fails its schema,
  for a server app that sets `setApiInputValidationErrorHandler`, stated as
  data (`{ payload?, config?, statusCode? }`, `res.api(payload, config)` with
  its status); `null` answers the standard 422. The mock answered 422 where
  such a server answered 200 with an errorMessage.
- **`ctx.rawPath`**: the request path as the gateway delivered it, stage
  stripped, beside the decoded `ctx.path`.
- **The file reader remembers a miss** for `memoryCache.missTtlSeconds` (60
  by default, `0` to ask every time). An SPA over S3 or an HTTP origin paid a
  source round trip, an S3 `GetObject` answering NoSuchKey, on every page
  navigation before the shell was served, in warm containers too. The misses
  are bounded by the bytes of their paths (4 MB), which the caller chooses.
  The file cache beside it now evicts the least recently served file rather
  than the first one read, so a hot bundle outlives a file fetched once; both
  sit on `lru-cache`, which Lambder already depended on.
- **`crashes`: one reporter for every crash, and who may read one.**
  `create({ crashes: { report, reveal } })`.
  - `report(error, site)` is told every crash wherever it happened, with
    `site.kind` saying where: `"api"`, `"route"`, `"event"` (a non-HTTP
    action that threw, or an event no action matched) or `"startup"` (a
    `created` hook). It is awaited before the answer goes out, never told a
    refusal, and a reporter that throws is logged and swallowed. A global
    error handler that throws while answering a crash is reported as a second
    crash with what it threw as its cause. An event's error is still rethrown
    to Lambda after the report, so retries and dead-letter queues are
    unchanged. Before this, a crash in an `addAction` or a `created` hook
    reached no hook at all, and an app wrapped `getHandler()` to see it.
  - `reveal(ctx)` decides whether the framework's own 500 carries the crash:
    `describeCrash` on an API call's `crash` field beside the call's
    `logList`, the stack as text on a route. A callee reached only by trusted
    invokers sets `reveal: () => true` instead of writing a global error
    handler to attach `describeCrash`. It governs the framework's answer
    only; a reveal that throws counts as no. Default: nobody.
- **`ctx.sessionController` on the server's context.** Every context the
  instance renders carries the request's session controller, typed to the
  app's session data, so a handler, guard or hook reaches it without holding
  the instance (and without the import cycle a guards module that needs the
  instance runs into). `lambder.getSessionController(ctx)` stays, for a
  context the instance did not render (one `createContext()` built). The
  tools are bound onto each context and bound again onto a context a
  `beforeRender` hook hands back, spread copies included.
- **`initLambder<SessionData>().guard()` and `.rateLimitKey()`**: the policy
  builders typed to the app's session, where the standalone `lambderGuard()`
  leaves `ctx.session.data` as `any`. The mock's `guard` and `rateLimitKey`
  are the same builders bound to its contexts.
- **`ctx.rateLimit(policy, key?)` and `ctx.isRateLimited(policy, key?)`**: a
  named policy charged by code, for a key only the handler knows (one
  recipient of an invitation). `rateLimit` refuses the way a declared limit
  does (a 429 envelope with Retry-After and the policy's `errorMessage` on an
  API call, a plain 429 on a route); `isRateLimited` answers the check
  result (`LambderRateLimitCheckResult`), with `retryAfterSeconds`, for a
  handler whose output says "too many" its own way. Both run on the instance's limiter, so `failOpen`, key bounding
  and `lambder/testing`'s memory limiter apply, none of which a direct call to
  a limiter's `isRateLimited` gets. A policy may now leave `per` out, which
  makes it one the code charging it keys; an API cannot declare such a
  policy. Policy names and the key argument are checked at compile time where
  the types say (a handler's context), and when the charge runs elsewhere (a
  hook's or a guard's context, or a policy typed as the general
  `LambderApiRateLimitPolicyConfig`). A per-API policy charged from a hook or
  the fallback for a call no registered API matched counts under no API, so a
  fresh posted name is no fresh counter. Mock handlers have both too.
- **`LambderMemoryCache` and the `LambderCache` interface.** The DynamoDB
  cache's twin for tests, with the same rules: the same key and value limits
  (the key and value checks are shared modules both caches go through), the
  same JSON round trip, TTL, sort-key order and `getOrSet` answers, and the
  same counts from `delete` and `deletePartition` (live entries only). A
  conformance suite drives both. `LambderDdbCache` implements the interface.
- **`lambder/build` with `writeApiSignatures(instance, { file })`.** Writes
  the signature module both sides ship, or checks it (`check: true`), naming
  the endpoints whose signatures moved. It compares the map the file holds, so
  line endings or a formatter (one that re-indents the file or takes the
  quotes off its keys) neither make a file stale nor get it rewritten, and the
  map carries a `// prettier-ignore` line. A write goes to a temporary file
  renamed over the old one, through a symlink to the file it names. With
  `verifyInFreshProcess: { module, exportName }` it loads the module that
  holds the instance in a fresh Node process, never the calling script, and
  checks the file against what it digests there, after a write and after a
  check that finds the file current, which is where a schema that digests
  differently per process shows. `module` is a path or a file URL, as a `URL`
  or as the string `import.meta.resolve()` answers. The fresh process gets the
  generator's Node flags less the inspector, watch mode, the test runner and
  the eval flags (`-e`, `-p`, `-pe`, `--input-type`); `exportName` defaults to
  `"default"`. `header`, `quotes` and `semicolons` match a project's style.
  Every app with `apiSignatures` wrote this generator itself from a sketch in
  the docs.
- **`LambderContractKeysWithGuard<Contract, "guardName">`**: the endpoints
  whose guards option names that guard, in any form, for a list a test loops
  over. `satisfies` refuses a name the guard does not cover; the JSDoc shows
  the one-line check that also refuses a list missing one.
- **`chargeAt: "beforeGuards"` on a custom-keyed rate-limit policy** charges
  it before the guards and the input schema, so the attempts they refuse are
  counted: a limit on guessing a one-time code a guard checks, keyed per
  email. The default stays `"afterGuards"` (below).
- **`LambderApiOutputValidationError`**: the crash a handler's answer causes
  when its output schema does not accept it, for a crash reporter to tell
  apart, with the `apiName`, the `zodError` when the schema rejected the
  payload (null when parsing threw), and what was thrown as its `cause`.
- **A `servePublicFiles` path mapper receives the file path** as its second
  argument, `(ctx, filePath) => ...`: the file `ctx.path` names, its kept
  escapes turned back (see `ctx.path` below).
- `LambderSessionChanges` and `LambderSessionUpdateResult` are exported, the
  types a session store of your own writes its `update` with.
- **`refusalMessageOf(value)`**: an envelope's errorMessage as the message
  object (a plain string becomes `{ type: "error", content }`), exported from
  `lambder` and `lambder/client`.
- **`crashes.reportTimeoutMs`**: how long a crash's answer waits for
  `crashes.report` (default 3000). A report still running then is logged
  with the crash as unfinished and the request is answered; the report
  itself is not cancelled.
- **`notFoundErrorNames` on `LambderS3FileSource`**: the S3 error names read
  as "no such file", as `notFoundStatuses` is on `LambderHttpFileSource`
  (default below).

### Changed (breaking)

- **A custom-keyed rate limit is charged after the guards and the input
  validation.** The order is now: session-keyed limits (and custom keys
  charged `"beforeGuards"`), guards, input validation, guards placed after
  it, custom-key limits, handler. What refuses a request for free runs first
  and what spends something last. The key is a value the caller chose (an
  email in the payload): charged before a captcha guard, it let a caller who
  never solved the captcha spend a victim's per-email budget and keep them
  locked out of reset, register and send-code, and charged before the input
  schema, a request refused for its input spent that budget too. `per: "ip"`
  still runs before the session read and `per: "session"` before the guards.
  After the guards, an attempt they refuse is not counted, so a limit on
  guessing what a guard checks (a one-time code, keyed per email) would count
  none of the wrong guesses: such a policy says `chargeAt: "beforeGuards"`
  and is charged where 7.x charged it.
- **`LambderHttpFileSource` reads a 403 as a missing file**, beside 404 and
  410. A private S3 bucket behind CloudFront answers a missing key 403 when
  its reader may not list the bucket, so every SPA route failed with a 500
  before the shell was served. `notFoundStatuses: [404, 410]` makes a 403 an
  error again, for an origin that answers missing keys 404.
- **`LambderS3FileSource` reads AccessDenied as a missing file by default**,
  for the same reason: a reader without `s3:ListBucket` is told AccessDenied
  for a missing key. S3's key refusals (KeyTooLongError, InvalidURI) and R2's
  InvalidObjectName read the same way, so a long path is a 404 rather than a
  crash. A reader granted `s3:ListBucket` that wants a refused credential to
  surface passes a `notFoundErrorNames` without AccessDenied.
- **An answer that carries Set-Cookie is never publicly cacheable.** When its
  Cache-Control is neither `private` nor `no-store`, `public` becomes
  `private`, and `s-maxage` and `immutable` are dropped, on every exit, the
  304 and the crash answer included. A hook that set a cookie (a guest
  session, a session read that re-issues the cookies) on a content-hashed
  asset sent it as `public, max-age=31536000, immutable`, which a shared
  cache that keeps Set-Cookie hands to everyone.
- **`createContext(event, lambdaContext, options?)`** takes
  `{ apiPath?, trustedClientIpHeaders?, trustedHostHeaders? }`
  (`LambderContextOptions`) in place of positional arguments; `apiPath`
  defaults to `"/api"`, as at `create()`.
- **String routes match case-sensitively**, as API Gateway routes and
  CloudFront behaviors do. `/ADMIN/users` reached `addRoute("/admin/:x")`
  past an authorizer or a behavior on `/admin/*`, which the gateway never
  matched.
- **`ctx.path` is decoded, whichever gateway sent it.** A REST API and a
  Function URL deliver the path percent-encoded and an HTTP API decoded, so
  `addRoute("/hakkımızda")` answered 404 on two of the three, a file named
  `team photo.jpg` was never found there (and `serveIndexHtml` answered an
  `<img>` for it with the HTML shell), and regex routes saw a different
  string per gateway. `ctx.path` is now the path decoded exactly once: an HTTP
  API's is taken as delivered, and a Function URL is told apart by its own
  `*.lambda-url.<region>.on.aws` domain, which its events always carry. Two
  escapes stay in it, so it reads back unambiguously and no decoded text can
  pass for an escape (`/%2561dmin` is never `/admin`, which would get past an
  authorizer or a WAF rule in front of the function that checked the path
  once): a slash inside a segment stays `%2F`, so it cannot become a
  separator, and a percent sign stays `%25`. A path param and a RegExp
  route's captures turn both back, and keep a decoded `#` or `?`
  (`/tags/C%23` is the tag `C#`); `servePublicFiles` looks up the file the
  path names, its `%25` read as `%`, and a path with an encoded slash names
  none. An app that decoded `ctx.path` itself should stop. The path as
  delivered is `ctx.rawPath`. The v2 events `lambder/testing` and
  `LambderInvokeCaller` synthesize are an HTTP API's, their path decoded; the
  v1 ones (`eventFormat: "v1"`) carry it as written, as a REST API's do.
  The server tells those events by their own `requestContext.apiId`
  (`lambder-invoke`, `lambder-local`) and reads their path as decoded whatever
  host they name, so a caller or a test visitor naming a Function URL's
  `*.lambda-url.*` host does not have it decoded a second time, where
  `/%2561dmin` reached `/admin`.
- **On a REST API, compression is off unless `compression` is named**, and
  **text leaves as text** on every gateway. A REST API decodes a base64 body
  only for its `binaryMediaTypes`, so compressed answers and every served
  file (CSS and JS included) reached the browser as base64 unless those were
  `*/*`. A text body that is not compressed (a string, or a text-typed Buffer
  that is valid UTF-8) now goes out with `isBase64Encoded: false`; binary
  files and compressed bodies still need `binaryMediaTypes: ["*/*"]` there.
- **ETags are taken over the uncompressed body and name the encoding**
  (`"<hash>-br"`), so a revalidation that ends in a 304 compresses nothing.
  Every tag changes once, which costs each client one full answer.
- **The default immutable Cache-Control takes only bundler output**:
  everything under `_next/static/`, and under `assets/` or `static/` a name
  ending in its hash. The old rule matched from a name's first hyphen, so
  `android-chrome-192x192.png`, `og-image-1200x630.png` or
  `privacy-policy-v2.html` were cached for a year wherever they lived, and a
  replaced copy never reached a returning browser. Inside `assets/` or
  `static/`, a hand-named file whose last part could be a hash
  (`assets/og-image-1200x630.png`) is still taken for bundler output. An
  8-character last part counts as a hash only when it looks random (a capital,
  a lowercase letter and a digit, or at least three capitals and a lowercase
  letter), so `assets/Inter-SemiBold.woff2`, `assets/icon-Settings.svg` and
  `assets/og-image-v2-final.png` keep the ordinary Cache-Control, as does
  about one Vite hash in twenty. Pass `immutablePattern` for another layout.
- **Served text files carry `charset=utf-8`** (`text/css; charset=utf-8`), so
  a UTF-8 `.txt`, or an `.html` with no meta charset, is not read in the
  browser's legacy encoding. A source's own content type is kept as given.
- **A template slot inside an unquoted attribute value is refused even with
  a prefix before it** (`class=big-<!--slot:x/-->`), where a space in the
  value starts a new attribute, and **so is a slot inside a tag where an
  attribute name goes** (`<input <!--slot:x/-->>`), where any value is a new
  attribute: vary attributes with `<!--if:...-->` around whole-tag variants,
  or put the slot inside a quoted value. The check now reads the tag, past
  the template's own tokens, so an `=` inside a quoted value or in text no
  longer counts as one.
- **A template slot inside the quoted value of an event handler (`onclick`
  and every other `on` attribute), `style` or `srcdoc` is refused** when the
  template compiles. The browser decodes the escapes and then reads that
  value as JavaScript, CSS or a whole document, so escaping cannot protect it.
- **A template's URL attribute is checked when it renders** (`href`, `src`,
  `action`, `formaction`, `xlink:href` and the other single-URL attributes).
  When a slot can reach the value's scheme and that scheme is not http,
  https, mailto or tel (`javascript:` and `data:` included), the value
  renders as `about:invalid`. The whole rendered value is checked, so a
  scheme split across two slots, or completed by the template's own text
  after a slot, is caught too. Relative URLs and values whose scheme the
  template fixed render as written.
- **`html` and `xml` apply the same rules to their interpolations.** They
  read each call site's static strings to find where every interpolation
  lands, and throw where escaping cannot protect the value: an unquoted
  attribute value (`class=${x}`), a tag where an attribute name goes
  (`<input ${x}>`), the quoted value of an `on` attribute, `style` or
  `srcdoc`, and the content of a `<script>` or `<style>` element. A quoted URL
  attribute value holding an interpolation gets the template's scheme check.
  The rules follow the template, not the value, so they hold for strings,
  numbers, nested `html` fragments, `raw()` and empty values alike, and a
  call site that breaks one throws on every call. Quote the attribute, pass
  script data in a `data-` attribute or through `jsonScript()`, or build the
  whole tag conditionally; a `data:` URL writes its scheme in the template
  (`src="data:image/png;base64,${pngBase64}"`).
- **`getOrSet` answers the stored JSON on every call**, the call that filled
  the entry included, on `LambderDdbCache` and `LambderMemoryCache` alike.
  The filling call used to answer the loader's own object, so a `Date` was a
  `Date` once and a string forever after, and a field the JSON dropped was
  there only the first time. A value handed back uncached because the cache
  failed open has the same shape. A loader's `undefined` is no longer stored
  or logged as a failure: it comes back uncached and the next call loads
  again (answer `null` to cache "not found").
- **An idempotency key belongs to the request it was first sent with.** The
  claim and the stored record keep a fingerprint of the request's payload
  (key order aside, and a key named `__proto__` kept as data), and the same
  key with a different payload is refused with
  `lambder/idempotency-key-reused` (409) instead of being handed the first
  request's answer. Guard inputs stay out of it: a captcha or proof token is
  single use, so a genuine retry carries a new one and still replays. Such a
  token belongs in `guardInputs`; one carried inside the payload (checked by an
  `apiInput` guard) is part of the fingerprint. `LambderIdempotencyStore.begin`
  takes the `fingerprint`, reports the one it holds with `"pending"` and
  `"done"`, and `complete` stores it; a store of your own keeps it the same way.
  The fingerprint is a required `string` on the stored record and on the
  `"pending"` answer. A record a store cannot tie to a request (one another
  writer left in its table) reports `""`, which no request matches, so its
  key is refused as reused; a claim refused with no record behind it (no
  room to hold one) reports the caller's own fingerprint, so the engine
  answers the in-flight 409 and the client keeps its key.
- **`LambderIdempotencyStore.abandon()` releases only a pending claim.** A
  settled record stays, even when the owner that stored it asks.
  `LambderDdbIdempotencyStore` deletes on `ownerToken = :owner AND
  #state = :pending`, and a store of your own does the same.
- **`idempotencyKey` also takes a key scope** (`createIdempotencyKeyScope()`),
  on `LambderCaller` and `LambderInvokeCaller` alike: the call sends its
  current key and moves to a new one once an answer settles the operation,
  so a corrected form after a refusal is sent under a new key. A success
  settles it, and so does a key refused as reused. A refusal of this request
  does too, unless an earlier attempt under the key went unanswered (a
  timeout, a 5xx, an original still in flight): guards, validation and rate
  limits refuse before the replay record is claimed, so the key is kept and
  the next attempt replays the original rather than running it again. A rate
  limit, an expired session and a stale version keep the key, and an answer
  for a key the scope has already moved past changes nothing. A refusal
  while another attempt under the key is still in flight keeps it too (a
  double-tap refused by a single-use captcha guard while the first tap runs).
  A double-tap's duplicate-in-flight answer leaves the key to the first tap's
  own answer, so a first tap refused ("only 5 in stock") still moves the scope
  on and the corrected order goes under a new key.
  `LambderIdempotencyKeyScope` is a class now, made by
  `createIdempotencyKeyScope()`, rather than an object type a site could
  build itself, and only the callers start and settle its attempts.
- **`createIdempotencyKey()` and `createIdempotencyKeyScope()` are standalone
  functions** of the root entry and `lambder/client`, in place of the
  `LambderCaller` statics of the same names, since the invoke caller takes
  their keys too. `LambderCaller.createIdempotencyKey()` becomes
  `createIdempotencyKey()`.
- **A payload is parsed through the API's output schema before it is sent.**
  The type system accepts a value carrying more than its type (a row read
  straight from a table is assignable to a narrower output), and those extra
  fields, secrets included, went to the client and into the idempotency store.
  zod now strips them, fills defaults and runs transforms; a payload the
  schema rejects is answered as a crash rather than sent. That covers every
  payload the handler's `res.api()` answers, a refusal's beside an
  `errorMessage` or a flag included; only `null` passes as it is. A hook, the
  input validation handler and the global error handler answer in shapes of
  their own and are sent as given. The handler writes the schema's input form
  (`z.input`), what the transforms take, so each runs once: a handler for an
  output with a transform writes the transform's source type. Output schemas
  are parsed synchronously, so one cannot be async: an async refinement or
  transform, or a transform that throws, is the same crash, with the thrown
  error as its cause. The handler has run by the time its answer is refused,
  so under an idempotency key the framework's crash answer is recorded as the
  key's answer, and a retry is told the same thing rather than running the
  operation again.
- **The contract records the client's side of each schema.** `input` is the
  schema's `z.input` (a defaulted field is optional to send, a transformed
  field is posted as its source type) and `output` its output as JSON
  (`LambderJsonOf`: a `z.date()` field is a string, an `undefined` inside an
  array is `null`, and `unknown` and recursive JSON such as `z.json()` stay as
  they are, a key whose value may be undefined is optional since JSON leaves
  it out, and a `Map` or `Set` is `{}`). At the top of an output a `void` or
  `undefined` schema stays as it is, since an envelope carries no payload
  rather than a JSON `undefined`, and an output that may be undefined keeps
  that member (`LambderJsonOutputOf`). Guard and rate-limit `apiInput`
  slices are checked against the posted form. An endpoint with a transform in
  its input used to be uncallable through the typed caller, and a `z.date()`
  output typed `Date` arrived as a string. A mock entry's `input` schema is
  pinned the same way: it takes exactly the posted form, and what it parses to
  must still read as it, so the server's schema restated with a `.default()`
  passes and one whose transform changes a field's type does not.
- **A POST to `apiPath` is an API call only with `Content-Type:
  application/json`.** Every Lambder caller sends it, and owns it: a
  Content-Type among a call's own headers (a forwarded form post's) does not
  replace it. A POST of another type reaches the API fallback, and the mock's
  MSW adapter and invoke transport read it the same way. Before, the body was
  read as JSON whatever its type, so a plain HTML form on any website (no
  preflight) could post a login envelope and plant the attacker's session
  cookies in a visitor's browser.
- **`cors: { credentials: true }` needs an allowlist or a predicate in
  `origins`**; create() refuses it with every origin allowed, which echoed
  whatever Origin asked and let any website read a signed-in user's answers.
- **A `cors.origins` predicate is asked once per request**, right after the
  request is read and before any hook or handler runs, and its answer holds
  for every answer the request ends in, a crash's included. A predicate that
  throws (`new URL(origin)` on `Origin: null`) counts as refused and is
  logged once.
- **`LambderCaller`'s `isCorsEnabled` is optional**, and
  `lambderFetchTransport()`'s `cors` defaults to whether the call's `apiPath`
  is on another origin than the page's, where it was `false`. Credentialed
  cross-origin mode applies exactly when a browser needs it; an explicit
  value still wins.
- **`LambderSessionStore` has `create` and `update` in place of `put` and
  `markDataExpired`.** No write replaces a record any more: `create` writes a
  new session and refuses an existing one, and `update(hashes, changes,
  condition?)` changes only the named fields, only while the record exists,
  answering `"updated"`, `"missing"` or `"stale"`. `delete` hands back the
  record it removed, or null when there was none. A store of your own
  implements the three; `LambderDdbSessionStore` does them with conditional
  writes and `ReturnValues` (a refused update tells stale from missing by the
  item it hands back, with no read after it), and `listSecretHashes` reads
  consistently.
- **`LambderSessionRecord` has a required `dataVersion`**, created at 0, and
  `update`'s condition is `{ dataVersion }`. A store adds one to
  `dataVersion`, in the same atomic write, on every update whose changes carry
  `data` or `dataExpiresAt`, even when the value written is unchanged, and
  applies a conditioned update only while `dataVersion` equals the
  condition's, answering `"stale"` otherwise. `dataExpiresAt` is a plain
  deadline. `LambderDdbSessionStore` reads an item without `dataVersion` as no
  session, and the manager reads a record without a numeric one the same way,
  whatever store handed it back.
- **The session manager's `deleteSession()` answers false when there was no
  record to delete**; 7.x always answered true.
- **The session partition key is HMAC-SHA256 of the sessionKey keyed by
  `sessionSalt`**, in place of sha256 of the sessionKey followed by the salt,
  so two deployments sharing a table cannot collide when a sessionKey absorbs
  the difference between their salts. Every existing session is signed out
  once. `LambderSessionCrypto` has a required `hmacSha256Hex(key, value)`,
  which `LambderWebCrypto` and `LambderPlainSessionCrypto` implement and a
  crypto of your own adds.
- **`updateSessionData` and `refreshSessionData` no longer slide the
  expiry**; a session read does, which is also what re-issues the cookies.
  The manager's `updateSessionData` answers null, and the controller's
  throws `LambderSessionNotFoundError`, when the session was ended while the
  request held it; an API call answers that as sessionExpired rather than as
  a crash. The controller's `refreshSessionData` throws the same when the
  session is over, whether the `dataRefresh` callback ended it or something
  else did, rather than answering null and clearing the session cookies by
  name, which could delete a session another response had just set.
- **`regenerateSession()` carries the data over as it was stored**, not as
  the request read it, and leaves no session behind for a session ended
  during the request: the manager's answers null and the controller's throws
  `LambderSessionNotFoundError`. It writes the new record before deleting the
  old one, and takes the new one back out when the old one is already gone,
  so a rotation racing "log out everywhere" cannot slip its new record past
  the subject-wide delete's listing. With `dataRefresh`, the new session's
  data starts due, so its next read renews it from the source of truth. It
  deleted without checking and created a new session from the request's
  copy, so a thief's request that rotated after the owner's password change
  came away with a live session, and a rotation after
  `expireSessionDataAllByKey` kept the revoked data.
- **A refusal's `errorMessage` is the message object, on the wire and for every
  reader.** A plain string a handler writes (`new LambderApiRefusal("Denied.")`,
  `res.api(null, { errorMessage: "Denied." })`, the framework's own crash
  answer) goes out as `{ type: "error", content: "Denied." }`, and
  `LambderApiRefusal`'s `errorMessage` property is that object. `LambderCaller`
  and `LambderInvokeCaller` outcomes, `LambderInvokeError` and
  `errorMessageHandler` hand over `LambderAppRefusalMessage`, never a string. A
  reader that compared `envelope.errorMessage` to a string compares its
  `content`. A handler typed for the old union still compiles. An outcome
  narrowed to `reason: "errorMessage"` carries `errorMessage` as a required
  field, on both callers.
- **`LambderRenderContext` has four more members** (`sessionController`,
  `rateLimit`, `isRateLimited`, `rawPath`) and a fifth type parameter, the
  app's policies. A context written out by hand as an object literal has to
  add them.
- **Handler contexts carry the app's session type.** A handler registered
  with `addApi`, `addSessionApi` or a literal-path `addRoute` reads
  `ctx.session` as the app's `SessionData` rather than `any`, which can
  surface type errors that were hidden. The `guards` option of `create()` is
  typed to the app's session too. A RegExp route, a hook and a fallback still
  read it as `any`.
- The mock's `ctx.sessions` is `ctx.sessionController`, the server's name for
  it, so it is not one letter from `ctx.session` (the record). It is bound
  the way the server's is, as a non-enumerable member, so it does not show in
  `Object.keys(ctx)` or a spread copy of a mock context; destructuring reads
  it as before. `ctx.rateLimit` and `ctx.isRateLimited` are bound beside it.
- `LambderApiEnvelopeBody`'s `apiVersion` is required (`string | null`), as
  every envelope carries it: a hand-built answer typed with it without one no
  longer compiles.
- **`LambderDdbCache` keeps a `getOrSet` fill's lease on the entry's manifest
  item** instead of a separate `lock` item. The manifest item holds either
  the value or, while a fill runs, only the lease (`leaseOwner`), whose
  `expiresAt` is the end of the lease, so the table's TTL removes an
  abandoned one. The IAM actions are unchanged.
- **`getOrSet` checks `ttlSeconds`, `leaseSeconds` and `waitForFillMs`
  before it reads or loads**, on both caches, and an invalid one throws to
  the caller. The fail-open caught it, logged, handed back the loader's value
  and left caching off.
- **The `@aws-sdk/client-dynamodb` peer dependency starts at 3.868.0**, the
  first version whose throttling errors name their reasons. Below it the
  rate limiter never recognizes a key-range throttle.
  On Lambda, a deployment that relies on the runtime's bundled SDK needs a
  runtime whose client is at least that, or bundles its own (see the README).
- create() does not check at runtime for `LambderDdbSessionStore` fields
  (`tableName`, `partitionKey` and the rest) on the session option; the
  compile-time key check refuses them.
- `LambderCacheKey` is declared in the cache contract now; the export name is
  unchanged. `LambderDdbCacheSetOptions` and `LambderDdbCacheListOptions` are
  gone: both caches take the shared `LambderCacheSetOptions` and
  `LambderCacheListOptions`.

### Fixed

- **A `lambder/testing` visitor posts its own jar's CSRF token** where a
  `document` holds one too (a test with a DOM): it posted the page's, and
  every session call answered `sessionExpired`.
- **A flood on one rate-limit key is refused, and only that key.** DynamoDB
  throttles a partition at roughly a thousand writes a second, and the
  limiter passed the throttle on as a failure, which `failOpen` turned into
  no limit at all for exactly the flood the limit exists for. A key-range
  throttle (`KeyRangeThroughputExceeded` among the error's throttling
  reasons) falls on every key of the partition, so the limiter reads the
  window's own count with a consistent read: a key at or over its limit is
  refused with a Retry-After of 5 seconds, and a key under it (a neighbour of
  the flood, or of a session or cache spike on a shared table) has the
  throttle passed on for `failOpen` to decide, as does a throttle of the
  table or the account.
- **A key over a later window's cap is refused on a throttled partition.** The
  limiter read only the throttled window, so at each minute rollover a key
  over its daily cap went to `failOpen`. It now reads every window the attempt
  was not counted against, in parallel, and refuses when any is at its limit.
  Each process remembers such a window for 5 seconds and refuses the key's
  repeats without touching the table. A key whose read is throttled as well
  rethrows its first throttle, which `failOpen` logs once rather than per
  request.
- **An idempotency scope's caller identity and sessionKey are bounded** like a
  rate-limit key: past 1024 bytes they become `i:h:<sha256>` and
  `s:h:<sha256>`. A long `callerIdentity` (a device token) put the scope past
  DynamoDB's key limit, and `failOpen` turned the refusal into no idempotency
  for that caller.
- **Key bounds measure the key as written**, escaped separators included.
  1,000 `|` characters passed the 1024-byte bound, overflowed the partition
  key and failed open.
- **A replay is built from a copy of the stored record**, so a store that
  hands back its own object cannot have the replaying call's Set-Cookie
  written into it.
- **A guard or rate-limit `apiInput` slice is checked against a union input
  whole**: a slice only some members carry is a compile error rather than a
  422 on every request of the others.
- **Retry-After is measured on the limiter's clock**
  (`LambderRateLimiter.clockMilliseconds`, optional; both shipped limiters
  have it).
- **DynamoDB stores share one default client per region.** Sessions, rate
  limits, idempotency and the cache each built their own client when given
  none: four connection pools and, on a cold container, four TLS handshakes
  and credential lookups inside the first request. A store given a `client`
  keeps using it.
- **The mock hands a handler a parse of the request's JSON**, as every
  server-bound transport sends it. The direct transport handed over the
  page's own object: a handler that stored the payload shared it with the
  form, later edits changed the "saved" record with no call, and a `Date` or
  a key set to `undefined` reached the handler as no server ever sees one.
- **A mock memory-mode page stays signed in after a logout and a login.**
  `signIn` mirrors the CSRF cookie into `document.cookie` for the MSW
  adapter, a page's caller reads its token from there, and a memory
  transport never writes there again, so the next login's token landed in
  the jar only and the stale one failed the pairing. In memory mode (and with
  a jar you pass) the jar is the page's cookie store and its CSRF token is
  the one posted.
- **The MSW adapter no longer reads the request's Cookie header.** MSW fills
  it from its own store, which captured the HttpOnly session cookie and kept
  it in localStorage across reloads: after a user switch both sessions went
  out and every call answered sessionExpired, a cleared jar stayed signed
  in, and the raw token showed in request events. A call's cookies are the
  adapter's jar and `document.cookie`.
- **i18n detects the language on every read.** The first detection was kept
  for the life of the process, so a path-based detector never saw `/en/`
  become `/tr/`. A throwing detector is reported once.
- **i18n fills parameters in one pass**, so a value is inserted as it is: a
  display name `Eve {org}` no longer had its `{org}` filled by the next
  parameter.
- **A response object kept between requests no longer collects another
  caller's headers.** A handler, hook or error handler that answered with an
  object it keeps (a module-level 404) had the call's Set-Cookie, CORS,
  `Vary`, `Content-Encoding` and `ETag` written into it, and the next caller
  was sent the previous caller's session cookie. Each request now writes into
  its own copy, and a response an afterRender hook answers with is copied
  before the hooks after it write into it.
- **`redirectTrailingSlash` percent-encodes the Location, and so does
  `res.redirect()`.** A TAB or line break in the path (`/%09/evil.example/`)
  reached the header as it was, a browser drops those before resolving, and
  `//evil.example` is another host; a decoded `ctx.path` carries them on every
  gateway now, so an app redirecting to a path built from it was exposed the
  same way. `res.redirect()` percent-encodes control characters, a space, a
  backslash and anything outside ASCII in every Location, leaves `%` alone,
  and collapses a path's leading run of slashes and backslashes to one slash,
  so `//evil.example` built from the path stays on the site; another host is
  named with its scheme.
- **The DynamoDB cache's memory layer keeps to `memoryMaxBytes`.** A small
  compressed value was a view into zlib's much larger output buffer and was
  counted as its own few bytes, so a warm container could hold many times
  its budget. The layer now keeps each value in a buffer of exactly its own
  size, and counts each entry with its key and a fixed overhead.
- **Waiters on a cache fill wait as long as the lease**, and a second more:
  `waitForFillMs` defaults to (`leaseSeconds` + 1) × 1000 instead of 5 s, so a
  loader slower than 5 s is no longer run again by every container that asked
  for the key, and a waiter is still there to take over the lease of a holder
  that crashed (a lease expires in whole seconds). A container refused the
  lease because a value is already there serves it from the refusal, which
  carries the item as the table's leader holds it (a chunked value's chunks
  are read consistently), rather than loading: the read that found it missing
  may have come from a replica that had not seen another container's fill yet,
  and the loader would have run twice. A holder whose loader runs past the
  lease has its publish refused by the takeover and is told so with
  `console.warn`: such a call needs a `leaseSeconds` longer than its loader
  takes, or under demand the entry never fills.
- **Overwriting a chunked cache value deletes the old version's chunks**,
  which stayed in the table until their TTL (a year by default), and which
  `delete`, `deletePartition` and `listSortKeys` then paid to read.
- **A cache read no longer deletes a fresh entry over replica lag.** Chunks
  an eventually consistent read did not find yet, or that a newer write had
  just replaced, counted as corruption and dropped the manifest. The read
  now tries once more with a consistent read and drops only what fails that.
- **A cache that fails open no longer logs the key**, which is the app's
  data (an email address, a user id).
- **API Gateway's own JSON errors no longer resolve as successes.** A 413, a
  throttle, a WAF or missing-route 403 and an authorizer 401 answer
  `{"message": ...}`, which read as an envelope with no payload: `ok: true`,
  no `errorHandler`, the gateway text shown as an app message, and a refused
  save that looked saved. An object is an envelope only when it carries
  `apiVersion`, on a 5xx too, so a gateway's 502 `{"message": ...}` or a
  proxy's body never lands on `response`, `errorMessage` or the invoke
  caller's `crash`. A non-2xx answer that names no reason is a `server`
  failure, with its status and `retryAfterSeconds`, a 503's `Retry-After`
  included.
- **A stale `sessionExpired` no longer signs a fresh login out.** A call sent
  before a login (a poll, another tab) that answered after it deleted the
  CSRF cookie the login had just set. The caller now acts on it only while
  the cookie is still the one it sent, or is gone. It reads the token right
  before sending, after any guard-input provider, so a rotation answered
  meanwhile does not pair the new session cookie with the old token.
  Over a cookie jar (the mock's memory mode, `lambder/testing`,
  `lambderCookieJarTransport`) it compares the jar's CSRF token, which the
  transport reports on the answer as `csrfTokens: { posted, held() }`, since
  that session never reaches `document.cookie`.
- **A timeout or abort while the answer's body downloads is reported as
  one**, not as a malformed answer: the fetch transport reads the body inside
  the call.
- **A corrected or edited retry is no longer handed another request's
  stored answer.** A key reused after a refusal replayed that refusal for
  the whole window (qty 2 told "only 5 in stock", from the qty 10 before
  it), and an edited retry after a timeout was told the first order went
  through while only the first was placed.
- **A DynamoDB claim the SDK retried after it had landed recognizes itself**
  instead of answering its own original 409, and a refused claim costs one
  write rather than a write and a read (`ALL_OLD`).
- **A `per: "ip"` limit counts an IPv6 caller by its /64**
  (`rateLimits.ipv6PrefixLength`, default 64). Any IPv6 subscriber holds at
  least a /64 and may rotate the address inside it, so one counter per full
  address let it through on every request. An IPv4-mapped address counts as
  its IPv4 address, and the port CloudFront-Viewer-Address always appends is
  taken off by the header it came from, not guessed from the text, so a
  compressed address cannot carry its port into the /64
  (`2600:3c00::1111:91ff:fe93:1234:443` counts under `2600:3c00::/64`). An
  unbracketed IPv6 address in any other header is read as the address it
  spells.
- An async refinement in an input schema, a guard slice or a rate-limit key
  slice validates instead of making zod throw on every call.
- Under a CORS allowlist or predicate every answer carries `Vary: Origin`,
  including one to a refused or absent Origin, so a cache cannot serve it to
  an allowed origin.
- **A logout, "log out everywhere", a password change or a revocation can no
  longer be undone by a session write already in flight**, and "log out
  everywhere" or a password change not by a rotation either. Every renewal,
  data write and refresh wrote the whole record back unconditionally, so a
  poll that slid the session as the user logged out re-created it (and
  re-issued the cookies), and a thief's in-flight request brought a stolen
  session back after the owner changed their password. Writes are now
  conditional on the record existing, renewal writes only the expiry fields, a
  data write that finds the data version moved since its read lands marked
  due, so a revocation marked or already applied meanwhile stays in force, and
  a rotation leaves no session behind for a session ended meanwhile. Deleting
  every session of a subject lists them again when it finds a listed one
  already gone, which is how a rotation that replaced it in between shows. It
  lists at most four times; when a rotation completed inside every pass, it
  logs that with `console.error` and the manager's `deleteSessionAll()` and
  `deleteSessionAllByKey()` answer false, since a session may still stand. A
  plain logout in one tab racing a rotation in another ends the session it
  read; the rotated one lives on.
- **`updateSessionData()` no longer pushes back the `dataRefresh`
  deadline.** Only the refresh callback's output is stamped fresh, so an app
  that writes session data more often than `ttlSeconds` (usually
  `{ ...ctx.session.data, x }`, still carrying the roles read at login)
  still refreshes on schedule, and a session rotated by
  `regenerateSession()` stays due when the handler writes data right after.
- **A revocation in the same second as the stored deadline holds.**
  `expireSessionDataAllByKey()` marked data stale by writing the current
  second, so a mark in the second the deadline already read, or a second
  mark within one second, changed nothing, and a refresh already in flight
  landed the revoked data for a full `ttlSeconds`. Conditional session
  writes compare the data version instead.
- **A `LambderSessionNotFoundError` thrown from a route, a session route or a
  `beforeRender` or `afterRender` hook is answered as a missing session**
  (the `setSessionExpiredRouteHandler` answer or the default 401, or the
  sessionExpired envelope on an API call), not as a 500 and a crash report.
  It happens when the session was ended while the request held it.
  So is `LambderSessionAmbiguousError`, now a subclass of
  `LambderSessionNotFoundError`, when a route, a hook or an API handler calls
  `fetchSession()` on a request whose cookies name more than one live session.
  It answered a 500 and a crash report there, where `fetchSessionIfExists()`
  read it as no session; the answer carries the clearing cookies.
- **The context a `beforeRender` hook hands back is the request's from then
  on.** The handler received it, but the `afterRender` hooks, the global error
  handler and a crash's `site.ctx` and `reveal(ctx)` received the context as
  it arrived, without what the hook added and without the session a session
  route or API read onto the replacement.
- **Active users are no longer signed out at creation plus TTL** by an app
  that writes session data often: the data write slid the record but not the
  cookies, and renewal then saw nothing to slide.
- **"Log out everywhere" finds a session created a moment before it** (the
  listing reads consistently), and a subject's sessions are deleted or
  expired a bounded number at a time rather than one round trip after
  another.
- **Session data holding an `undefined` no longer fails the DynamoDB write**
  with compression off (a login that answered 500 in production only): the
  plain attribute is written from the same JSON the compressed one is.
- Session cookies carry `Max-Age` beside `Expires`, so a device whose clock
  runs ahead does not drop a short-lived session early.
- **A crash nothing answered is no longer silent.** With no reporter, the
  framework's own 500 logs the crash with `console.error` (and a global error
  handler that threw, beside it). That invocation succeeds, so Lambda's error
  metric never counted it, and nothing else recorded it.
- **A stored idempotency answer survives a `complete()` that reported a
  failure after landing.** The engine releases the claim after any failed
  store, and the release deleted on the owner token alone, which the stored
  record still carries: a write whose response was lost took its record with
  it, and the client's retry ran the operation again.
- **An invoke cannot set `ctx.ip` or `ctx.host` through forwarded headers.**
  The server tells an invoke by its `requestContext.apiId`, which no gateway
  lets a client write, and reads neither `trustedClientIpHeaders` nor
  `trustedHostHeaders` on one, so the invoker's `clientIp` and `host` are the
  only channel. A gateway lambda that forwarded a browser's headers handed a
  callee that trusted `x-real-ip` or `x-forwarded-host` an address and a host
  the browser chose.
  The invoke event also drops an `x-forwarded-for` the caller forwards, so an
  8.x gateway lambda forwarding a browser's headers to a callee still on 7.x
  that trusts that header hands it no address the browser chose. A
  browser-shaped request (`lambder/testing`, `lambderHandlerTransport`) keeps
  every header it is given, a forwarding header included, so a test exercises
  the app's own `trustedClientIpHeaders`; 7.x dropped `x-forwarded-for` there
  too.
- **An HTTP API sending payload format 1.0 has its path read as already
  decoded**, as its 2.0 events are, so `/%2561dmin` stays text instead of
  reaching `/admin` past a route an authorizer guards, and a named stage is
  dropped from the front of its path.
- **A stale bundle with two or more stale endpoints no longer reloads
  forever.** Each refusal overwrote the other's record, so no load saw a
  repeat. The caller keeps every call refused within the window, by endpoint,
  signature and version, with the time it was refused, per tab and per origin
  in `sessionStorage`. Only a call recorded before the document loaded counts
  as a repeat, so a retry or a second caller in the same page is asked about,
  not reported as a loop. A page asks one `versionExpiredHandler` at a time,
  however many of its calls, and of its callers, answer `versionExpired`:
  refusals heard while it runs call nothing, and one heard after it returned
  with the page still open asks again, so a per-call handler that does
  something else, or a reload cancelled at a `beforeunload` prompt, leaves no
  later call failing silently. Without `sessionStorage` nothing survives a
  reload, so the protection lasts for the page only.
- **Server-side `t()` answers in `defaultLanguage`**, not the process
  locale: Node 21 and later define `navigator.languages` from it. Browser
  detection runs only where there is a `document`.
- **A `getOrSet` fill that finishes after a `set`, `delete` or
  `deletePartition` of its key does not store the value its loader read
  before that write**, on either cache. On `LambderDdbCache` the write
  replaced or removed the fill's lease, so the fill's publish is refused, the
  chunks it wrote are deleted, and its value goes back to its callers
  uncached; a fill whose lease lapsed and was taken over is refused the same
  way. A `getOrSet` made after the write starts its own load rather than
  joining the overtaken one.
  `delete` removes the manifest item by its key and `deletePartition` finds
  the partition's items with a consistent Query, so a lease another container
  took a moment before goes too.
- **A `LambderDdbCache` read whose reply arrives after a `set`, `delete` or
  `deletePartition` in the same instance does not put the replaced value back
  in the memory layer**, and two overlapping writes of one key leave no memory
  copy. For a few seconds after an instance writes a key (or drops its
  partition) it reads that key with consistent reads, so a read that starts
  after the write and reaches a replica that has not applied it cannot answer
  or keep the old value either. Only the key written is affected: reads and
  writes of other keys in flight keep their values in memory.
- **`LambderDdbCache.delete` and `deletePartition` remove what another
  container wrote a moment before.** Both found the items to delete with an
  eventually consistent Query, which can miss an item the table accepted
  within replica lag: `delete` answered false and a value published just
  before it stayed, served by every container for its TTL, and a fill's lease
  stayed, so that fill published a value its loader read before the change.
  `delete` removes the manifest item by its key and finds its chunks with a
  consistent Query; `deletePartition` queries consistently.
- **`LambderDdbCache.delete` answers `true` only when a live value was
  there**, and `deletePartition` counts only live values, as
  `LambderMemoryCache` does: a fill's lease, a value past its TTL the table
  had not removed yet, orphan chunks and a 7.x `lock` item all counted.
  `delete` leaves a 7.x `lock` item to its TTL.
- **Calls that share one `getOrSet` load each get a parse of their own**, on
  both caches, as every read does. They got one object between them, so one
  caller's change to its answer showed in the others'.
- **A throwing `cors.origins` predicate no longer fails the request** with a
  502 and a second, misattributed crash report (see the predicate above).
- **A stalled `crashes.report` no longer turns every crash into a Lambda
  timeout** (see `crashes.reportTimeoutMs`).
- **`html` and `xml` no longer let a user-supplied value run script.**
  `` html`<a href="${user.website}">` `` with `javascript:alert(document.cookie)`
  produced a live link, and an interpolation inside `onclick="..."` ran once
  the browser decoded the escapes. The tagged templates and
  `LambderTemplatingEngine` slots share one implementation of the position
  rules and the URL check.
- **`LambderTemplatingEngine` reads `<script>` and `<style>` content as raw
  text up to the element's own end tag.** A `<` and a quote inside a script
  no longer hide an unquoted slot after it, and `</scripts>` does not end a
  script. A `<script>` mentioned in a comment or an attribute value, or a
  custom element such as `<style-box>`, no longer makes a slot refused.
- **A template slot's position is read along the template's branches.** The
  check read the text of both branches of an `<!--if:...-->` run together, so
  an attribute name the if/else chose (`<a
  <!--if:x-->title<!--else-->onclick<!--/if:x-->="<!--slot:v/-->">`) read as
  `titleonclick`, neither refused nor URL-checked, while the else branch
  rendered the slot inside a live `onclick` (and `href` against `data-lang`
  gave an unchecked `href`). Each branch is now read from where its block
  starts, a slot's default content and its value are two branches, and the
  branches have to leave the HTML in the same position before the next slot or
  block, or the template is refused when it compiles, naming the block. Vary
  whole tags or elements inside the branches. The check is one pass over the
  template instead of a rescan from the start per slot.
- **Comments end where the browser ends them.** `<!-->`, `<!--->` and `--!>`
  close a comment, and the check kept reading what followed as comment text,
  so a slot or interpolation after it in an unquoted attribute (`<!--><a
  title=<!--slot:v/-->>`) passed and rendered a live attribute list. A value
  in a comment right before a `-`, `!` or `>` that would end the comment after
  a value ending in `--` is refused too; put a space after it.
- **The position check reads markup the way a browser's tokenizer does.** The
  attributes of an end tag, bogus comments and DOCTYPEs (`<!x ...>`,
  `<?...>`), the content of `<title>`, `<textarea>`, `<xmp>`, `<iframe>`,
  `<noembed>` and `<noframes>`, a script's `<!--<script>` escape, a no-break
  space inside a tag, and an `=` that starts an attribute name each left the
  check inside a quote, or outside a script, that the browser had left or was
  still in, so a slot or interpolation passed in an unquoted value or inside a
  script.
- **The position check fails closed where inline SVG and MathML read the
  template apart from plain HTML.** It read the content of `<title>`,
  `<textarea>`, `<xmp>`, `<iframe>`, `<noembed>` and `<noframes>` as text
  everywhere, and a CDATA section as a bogus comment ending at its first `>`,
  where inside `<svg>` or `<math>` that content is markup and the section runs
  to `]]>`, so `<svg><title><img src=x onerror="${v}">` rendered a live
  handler. Once such content holds a tag, or a CDATA section runs past its
  first `>`, every value from there on is refused, past the element's end tag
  too, in `html` and in `LambderTemplatingEngine` alike; plain
  `<title>${v}</title>` and `<textarea>${v}</textarea>` render escaped as
  before. And `html` and `xml` throw when a call's template does not end in
  plain text (inside a tag, an attribute value, a comment, or the content of a
  `<script>` or a text-only element): a nested fragment is inserted without
  being read, so one that ended mid-markup (`${html`<a href=`}${url}>`) moved
  the interpolations after it and rendered a value unquoted.

### Documentation

- [docs/sessions.md](./docs/sessions.md) recommended `regenerateSession()`
  after a password change, which rotates only the caller's own session; it
  now says `endSessionAll()` then `createSession()`.
- [docs/routing.md](./docs/routing.md#crashes) says a crash reporter's
  `site.ctx` carries the request's secrets (the session cookie, a login's
  password in the body, the session record), so a reporter forwards the
  fields a crash needs rather than the whole context.
- [docs/configuration.md](./docs/configuration.md#trustedhostheaders) says a
  Function URL with auth `NONE` can be called directly with any
  `x-forwarded-host`, so the header is trustworthy only when the function is
  reachable solely through the distribution (`AWS_IAM` auth plus CloudFront
  origin access control).
- [docs/testing.md](./docs/testing.md) said the production stores are out of
  reach under the test app; that holds for the stores the instance holds. A new
  section says which Lambder classes an app constructs itself and what to swap
  each for (`LambderMemoryCache`, `ctx.rateLimit`,
  `LambderInvokeCaller.localTransport`).
- [docs/templating.md](./docs/templating.md#branches) describes the branch
  rule, and says what the URL check leaves to the app: SVG animation targets
  and a meta refresh `content` are not checked, and a value starting with `/`
  or `\` turns a root-relative `href="/..."` protocol-relative.

## [7.3.1] - 2026-09-21

### Added

- **`lambder/testing`: a real app under test, in one call.** `lambderTestApp(lambder)`
  takes the instance an app already exports and returns a `LambderTestApp`:
  memory stores put under the instance, and simulated browsers in front of it,
  with no HTTP and no AWS. Every piece existed before (the in-process handler
  transport, the cookie jar, the memory stores), but each app had to assemble
  them, and none could do the one thing that needs the framework's help: an
  app is a module-level instance whose handlers and guards close over it, so a
  test cannot be handed a copy over other stores, because the copy's closures
  still reach the original and the production table under it. The stores are
  therefore replaced **in place**, through a door keyed by a symbol no entry
  point exports, so nothing on an instance's typed surface offers it to a
  serving app. Nothing about the app is restructured, its guards, policies,
  session model, hooks and error handlers all run as written, and from the
  moment the test app exists the stores the app was created with are out of
  the instance's reach.
  - **Visitors.** `app.visitor()` is one simulated browser: its own cookie
    jar, its own address (so a `per: "ip"` limit counts visitors apart, as it
    does for two people in production), a typed `api` / `apiOutcome` over the
    real pipeline, and `request(method, path)` for everything that is not an
    API call (routes, redirects, session routes, public files), sharing the
    same jar. `app.signIn(sessionKey, data)` returns a visitor already signed
    in, minted by the app's own session model, so no login endpoint has to
    exist. It throws, and says why, when the app's cookie domain does not
    cover the visitor's host, instead of leaving every later call to answer
    `sessionExpired`. `guardInputsProvider`, `headers`, `host`, `clientIp`,
    `apiVersion` and `apiSignatures` are per visitor.
  - **The mock app's verbs**, over the real handlers: `signIn`, `signOut`,
    `expireSessionData`, `reset`, plus `event()` for what is not an HTTP
    request (a schedule, SNS, SQS) and the stores themselves for assertions.
  - **What the app threw.** A crash is answered by the app's global error
    handler or by the framework's 500, and either answer deliberately says
    nothing about the error, which leaves a test author with "status 500". The
    test app watches what the instance throws without changing what it
    answers: `visitor.apiOutcome` sets the thrown error as the failure's
    `error.cause`, per call even with others in flight, and `app.crashes`
    lists every one since the last reset.
  - **Options** sit where `create()` takes them (`session.store`,
    `rateLimits.limiter`, `idempotency.store`, `files`), each defaulting to a
    fresh memory store, or for `files` to the app's own source.
  - **`eventFormat: "v1" | "v2"`** (default `"v2"`): the gateway shape the
    handler is called with, so an app behind a REST API can run its suite on
    the event production delivers. `synthesizeLambdaHttpEvent` and
    `lambderHandlerTransport` take the same option; a REST API event carries
    its cookies in the Cookie header and every header in both delivery forms,
    and the asserted client address stays the gateway's observation
    (`requestContext.identity.sourceIp`) rather than a header, as on 2.0.
  - The test app owns no clock, on purpose: faking `Date` with the test runner
    moves the framework, the memory stores and the app's own handlers
    together, which a clock of the test app's could not.
- **`assertApiSuccess` and `assertApiFailure`**, from `lambder/testing` and
  `lambder/mock`. They narrow an outcome through an `asserts` signature, so
  what the proved arm carries reads on the next line, and they throw a plain
  Error naming what the outcome actually was, with the failure's own error as
  its cause. `assertApiFailure(outcome, reason?, { code?, status? })` types
  the reason against the union it was handed, so a misspelled one does not
  compile, and narrows per arm, since `server` shares its arm with three other
  reasons and `Extract` would have dropped it. Typed structurally over `ok`
  and `reason`, so a `LambderInvokeOutcome` narrows through the same two
  functions, and no test runner is imported.
- **[docs/testing.md](./docs/testing.md)**: testing a Lambder app in one page.
  It was spread across ten pages as asides before.

### Changed

- The session manager asks "may this crypto sit in front of this store" of
  every store it is given, a swapped one included, rather than only in its
  constructor.
- **The suite uses its own tools where the subject is what an app does.**
  The routing, hook, plugin, action, redirect and thrown-response tests run
  on the test app: a visitor's `request()` in place of a hand-built event, a
  context and a body decoder, `app.event()` for the non-HTTP actions, a typed
  `api()` for the plugin tests (which now also prove the contract flows
  through `use()` to a caller), and `signIn()` in place of session records
  forged with an SDK mock and hand-made hashes. Seven files lost their private
  copies of the event and context builders. The hand-written `if(!outcome.ok)`
  narrowing in the mock app's, the invoke caller's and the transports' tests
  became the two assertions.
- The tests whose subject is the wire stay on hand-built events, because the
  event or the raw answer is what they test: event parsing, response
  finalization, compression, cookies and CORS headers, the policy and refusal
  answers (status, envelope, Retry-After), error answers, the two gateway
  formats, and the transports themselves. `tests/helpers.ts` says which is
  which.

## [7.2.4] - 2026-09-19

### Changed

- **The mock's options are checked against the contract at compile time.**
  Only the guard map was before, so a mock whose other options no longer fit
  the contract compiled and then threw when its registry loaded, which in a
  dev server is a blank page and an error in the browser console. Now each of
  these is a type error at `create()`:
  - `rateLimits.policies` leaving out a policy an endpoint references (a
    policy added on the server and not to the mock);
  - `sessions`, `idempotency` or `rateLimits` left out (or switched off)
    while the contract has an endpoint that needs it, the way `guards`
    already was;
  - a guard with `session: true`, or a policy keyed `per: "session"`, where a
    public endpoint names it;
  - a `perPolicy` budget on a policy whose windows an endpoint overrides.

  Each of these was already refused at registration, so a mock that compiles
  now behaves as it did. The runtime checks stay for callers the types do not
  reach.

### Added

- **`LambderContractRateLimitNames<C, M?>`**, from both entries: every
  rate-limit policy name the contract references, the twin of
  `LambderContractGuardNames`. Both now take an optional mode to read only the
  public or only the session endpoints.

## [7.2.3] - 2026-09-19

### Added

- **`extensibleEnum(schema)`**, exported from both entries: marks an enum
  whose readers tolerate values they were not built with, and the signature
  digest leaves its values out wherever it is output. A list that grows with
  the product (roles, permissions, statuses) and rides in a widely returned
  payload changed the signature of every endpoint returning it, so one new
  permission reloaded every open tab. With the mark, the list growing or
  shrinking reloads only the clients of endpoints that take it as input,
  where its values still count because a removed value is a request the
  server now refuses. The schema's type and validation are unchanged; the
  mark is zod metadata, read from zod's shared registry. An unmarked enum
  digests exactly as before, so upgrading changes no signature.

## [7.2.2] - 2026-09-18

### Added

- **Languages loaded on demand in `createLambderI18n`.** Any language block
  except the default one, in `base`, `extend` and `extendPartial`, can be a
  loader instead of the dictionary: a function resolving to the dictionary or
  to a module whose default export is one, so `tr: () => import("./tr")` is
  the whole thing and a bundler gives each language its own file. Until now
  every declared language had to be written inline, so every visitor
  downloaded every language. A loader is checked against the same contract as
  an inline block, and a missing key is a compile error that names it. The
  default block stays inline: it is the contract and the fallback every
  lookup ends in, and creation refuses a loader there.
- **`i18n.loadLanguage(code?)`** runs a language's loaders (the active
  language by default) across every instance sharing the root, and resolves
  once their dictionaries are merged. Until then `t` falls back per key to
  the default language, as it does for any missing translation. Concurrent
  calls share each load, and change listeners fire once per load. A loader
  that answered never runs again; one that rejected rejects the call and runs
  again on the next. Creating an extension loads nothing, so one created
  after its language was loaded awaits its own `loadLanguage()`, which runs
  only what is still missing. `setLanguage` and `resetLanguage` start the
  loaders of the language they switch to, and listeners fire again when they
  land; loading first switches without a flash of the default language.
  Configs without loaders behave exactly as before. The
  `LambderI18nDictionaryLoader` type is exported from both entries.

## [7.2.1] - 2026-09-15

### Added

- **`lambder.apiSignatureEntries()`**: the same signatures `apiSignatures()`
  returns, each with the endpoint name it was digested from, sorted by key as
  the map is. The map carries no names, so a generator holding only the map
  could report that four signatures changed but not which endpoints; reading
  the entries it can name them. A build-time view by construction: it comes
  off the server instance, which a generator imports and a client never does.
  `apiSignatures()` is now this with the names dropped, so there is still one
  computation. The `LambderApiSignatureEntry` type is exported from the root.

## [7.1.5] - 2026-09-15

### Added

- **`minApiVersion`**, on `create()` and on the mock runtime: a floor under
  the signature gate. A call naming a `version` below it answers
  `versionExpired` whatever its signature says, which is the lever for a
  change the digest cannot see (a security fix, a field whose meaning changed
  under the same shape). Versions compare as dotted numbers, so `1.2.10` is
  above `1.2.9`; a call naming no version is not judged, as one carrying no
  signature is not gated. Creation refuses a floor that is not a dotted
  version; a floor above `apiVersion` is taken as `apiVersion`, with a
  warning, so a mistaken floor cannot refuse the build's own clients.
  `compareDottedVersions` and `isDottedVersion` are exported from both
  entries.
### Changed

- **`apiNameKeyOf` memoizes nothing.** It hashed each name it was asked about
  into a module-level map, kept for the life of the process. On the server
  that name comes off the wire, in the pre-pass that runs before anything has
  checked that it is an endpoint at all and before any rate limit, so a
  request naming anything grew the map by an entry, and one naming a
  megabyte's worth grew it by a megabyte. Nothing is kept now: the digest the
  gate rests on is the generator's, computed once at build time, and what is
  left per call is one hash of a short name against a map already in memory.
- **`apiVersion` must be a dotted version** (`"1.2.10"`), on `create()` and on
  the mock runtime, where any string was taken before. `minApiVersion` reads
  it as numbers, and a stamp the comparison cannot read (`"dev"`, a commit
  sha, a build date) counted as zero, so setting a floor answered
  `versionExpired` to every client of the build that set it. The clamp that
  exists to stop exactly that could not see the case. Creation refuses it
  instead, whether or not a floor is set today.
- **The server reads the generated map too.** `create()` takes
  `apiSignatures`, the same file the frontend ships with, and the pipeline
  compares a call's signature with the map's entry; nothing is digested at
  request time any more. The one computation is the generator's, so a schema
  digested differently on two builds costs its clients one reload per deploy
  and can no longer leave an endpoint refused for every caller.
  `LambderApiSignatureDigests` and the `LambderApiSignatureSource` type are
  gone, and `LambderApiPipeline.prepare(request)` takes no definition. A
  server given no map gates nothing, as the mock runtime does.
- **The signature digest hashes shape, not values.** The `default` keyword
  zod emits is dropped before hashing: a default's value is server
  behaviour, and for a function default (`.default(() => new Date())`,
  `.prefault`, `.catch`) zod wrote whatever the function returned at
  conversion, so the endpoint digested differently on every computation and
  the generated map could never match the server. Whether the field may be
  omitted still counts, through `required`, which is now sorted as well so
  that reordering fields changes nothing. Endpoints with a defaulted field
  get a new signature once.

## [7.1.1] - 2026-09-15

The version gate is replaced by a signature gate: whether a client is stale is
decided per endpoint, by a signature of the endpoint's client-facing shape that
the client carries and the server digests from its own registrations. A deploy
now forces a reload only on the clients that call an endpoint whose shape
changed; a tab whose endpoints are unchanged keeps working. The wire format
gains one optional request field, `signature`; answers are unchanged, and a
caller that sends no signature is treated as before, minus the version check.

### Changed

- **`apiVersion` no longer gates.** A request naming another version is not
  refused any more; the string is stamped on every answer's envelope and does
  nothing else. `LambderApiPipeline.isVersionStale` is gone, and `create()`
  no longer refuses `apiVersion: ""`, since there is no gate for it to turn
  off. An app that relied on the equality gate hands its callers
  `apiSignatures` instead (below).
- **`LambderApiPipeline.prepare(request, definition)`** takes the definition
  the request's name resolved to, or null, because the signature gate needs
  it. Both adapters resolve the name before the pre-pass now, which is also
  why a signed request for an unknown name answers `versionExpired` rather
  than `apiNotFound`: the client was built against a contract that had it.
- **`LambderApiRequest` carries `signature: string | null`**, so a request
  literal built by hand needs the field. `LambderApiDefinition` gains an
  optional `output` schema, which `addApi`/`addSessionApi` record.

### Added

- **`lambder.apiSignatures()`**: every registered endpoint's signature keyed
  by its hashed name, a `LambderApiSignatureMap`. A generator imports the
  finished instance, awaits this, and writes the object to a file the
  frontend ships with its build. The signature covers the name, the mode, the
  input and output schemas as JSON Schema, each declared guard's schema, and
  whether the endpoint takes an idempotency key; rate limits, guard
  parameters and the handler are left out, so changing them never forces a
  reload. Keys are hashed so the file lists no endpoint names. See
  docs/apis.md, "Signatures: when a client must update".
- **`apiSignatures` on `LambderCaller` and `LambderInvokeCaller`**: the
  generated map. Each call sends its endpoint's signature; a name the map
  lacks fails the call before it is sent, as an `unknown` outcome whose error
  says to regenerate. Optional: a caller without the map is never gated.
- **`apiSignatures` on the mock runtime**: given the same map, the runtime
  refuses a stale signature exactly as the server would; without it every
  signature passes, since it holds no server schema to digest. The request
  event carries `signature`.
- **Reload-loop protection in `LambderCaller`.** A `versionExpired` for the
  same endpoint and signature within five minutes of the last one means the
  reload brought the same bundle back (a frontend shipped with a stale map, a
  cached bundle, a server deploy that failed behind it). The handler is not
  called again; the failure goes to `errorHandler` and the outcome still says
  `versionExpired`. Once confirmed, every `versionExpired` inside the window
  counts, and after it a reload is allowed again. Kept per tab in
  `sessionStorage`, in memory where there is none. `RELOAD_LOOP_WINDOW_MS` is
  exported.
- `apiNameKeyOf`, `lookupApiSignature`, `readApiSignature`,
  `API_SIGNATURE_HEX_LENGTH` and the `LambderApiSignatureMap` type from both
  entries; `apiSignatureOf`, `LambderApiSignatureDigests` and the
  `LambderApiSignatureSource` type from the root.

## [7.0.0] - 2026-09-15

A major. The API pipeline moved out of the Lambda server into an isomorphic
core that the server and a new mock runtime both execute, the session layer
went behind a store interface, guards lost their resolver argument, and the
MSW adapter was replaced by a mock runtime. The wire format is unchanged in
both directions, so a deployed callee and an older client still understand
each other; the breaks are all in code.

Live sessions survive the upgrade. The DynamoDB item is unchanged, and so are
the token format, the hash constructions and the cookie names, so an existing
session validates against v7 given the same `sessionSalt`, the same cookie
keys, and a `LambderDdbSessionStore` over the same table and key attributes.
`LambderSessionStore` and `LambderSessionRecord` are generic over the session
data now, which is a type-level change alone: it renames nothing at rest. The
one thing to carry over deliberately is the region: it was required as
`session.tableRegion` and is optional as the store's `region`, so leaving it
out silently falls back to the SDK's default chain.

### Breaking

- **The `session` option takes a store.** `session: { store, sessionSalt, ... }`
  replaces `tableName`, `tableRegion`, `partitionKey`, `sortKey` and
  `compression`, which moved onto `new LambderDdbSessionStore({ tableName,
  region, partitionKey, sortKey, compression })`. `LambderSessionManager`
  takes `{ store, sessionSalt, crypto?, ... }`, and every read is async,
  because a store and a hash both are.
- **A leftover `tableName`, `tableRegion`, `partitionKey`, `sortKey` or
  `compression` on the `session` option now throws at creation.** This is the
  one break the compiler cannot find: `create()` is generic over
  `const TOptions`, which switches excess-property checking off for the whole
  options object, so those fields compile and would otherwise be dropped in
  silence while the store fell back to its own table defaults.
- **`LambderSessionManager.getSession` is gone.** It was the combined shape the
  `lookupSession` / `renewSession` split replaced, with no caller left: read
  with `lookupSession` and renew with `renewSession`, which is what lets a
  caller weighing several cookies decide which one is the visitor's before
  anything is written on their behalf.
- **`LambderSessionManager.isSessionValid` is two methods**,
  `isSessionTokenValid(record, sessionToken)` and
  `isSessionCsrfTokenValid(record, csrfToken)`, both typed `string | null`
  rather than `unknown`, with no trailing skip flag. A boolean at the call
  site said nothing about which half it turned off.
- **`LambderSessionController.isSessionValid` is gone.** It had no caller and
  it was the same combined shape `getSession` was removed for; it also used
  to default to the request's FIRST session cookie, which on a request
  carrying several is whichever copy the browser happened to put first, not
  the one the read resolved. An app verifying a token itself reaches for the
  manager's `isSessionTokenValid` and `isSessionCsrfTokenValid`.
- **`LambderSessionStore` and `LambderSessionRecord` are generic over the
  session data** (`LambderSessionStore<SessionData = unknown>`), so
  `ctx.session.data` is no longer laundered through `any`. Both shipped stores
  take the parameter; the `session.store` option itself stays typed over `any`
  on purpose, so an app's session type comes from `initLambder<SessionData>()`
  rather than from its table.
- **`createSession` refuses a TTL that is not a positive whole number of
  seconds.** A NaN from an unparsed environment variable used to write a record
  nothing ever retires and no read ever accepts.
- **`LambderSessionStore` implementations must declare `isMemoryOnly`**, and
  `LambderSessionCrypto` implementations must declare `isCryptographic`. The
  session manager refuses to put non-cryptographic hashing in front of a store
  that outlives the process, which no docstring could enforce.
- **`LambderSessionController`'s constructor changed shape**:
  `lambderSessionManager` is `manager`, `sessionTokenCookieKey` is
  `tokenCookieKey`, `sessionCsrfCookieKey` is `csrfCookieKey`, the public
  fields were renamed to match, and `request` (the call's cookies and posted
  CSRF token) is now required. Apps reach the controller through
  `lambder.getSessionController(ctx)` and never construct one.
- **A session record is `LambderSessionRecord`**: `sessionKeyHash` and
  `secretHash` in place of the table's own `pk`/`sk` attributes, and no index
  signature.
- **An empty `sessionSalt` throws at creation.** It salts the hash that
  partitions the store, so an unset environment variable stringifying to
  nothing has to be loud rather than silently partitioning everything alike.
- **`addSessionApi` and `addSessionRoute` are compile errors on an instance
  created without the `session` option**, the way `idempotency` already was.
  The registration-time throw stays behind them, for a caller that reaches
  registration through a cast or from JavaScript.
- **`ctx.session` is typed `LambderSessionRecord<SessionData> | null` on every
  render context** instead of the literal `null`, so reading `ctx.session?.data`
  after `createSession` compiles and the session route no longer needs a double
  cast.
- **`ctx.post` is typed `Record<string, unknown>`**, so a reader narrows a
  posted value before using it.
- **The global error handler takes three arguments.** The fourth
  `logListToApiResponse` parameter is gone, since `ctx.logList` is on the
  context the handler already receives.
- **Creation refuses an `apiPath` that does not start with `/`, an empty
  `apiVersion`, and a `maxResponseBytes` that is not a positive integer**, each
  naming the option it is about.
- **An option key the type does not have is now a compile error, at the top
  level and inside a nested option.** `create()` is generic over
  `const TOptions`, and inferring a generic from an object literal switches
  excess-property checking off for the whole literal, nested objects included,
  so `requireSessionApiGuard` (no trailing "s"), `maxResponseByte` or
  `idempotency: { failOpn: false }` compiled, was dropped in silence, and left
  the app running on the default. The two guard flags are the ones that hurt,
  since both exist to make a missing authorization declaration a compile error,
  and a one-character typo turned that back off with no signal from the
  compiler or the runtime. Surplus keys now map to `never`, which puts the
  error on the key itself, in `session` and `session.cookie`, `idempotency`,
  `rateLimits` and each of its `policies`, and each guard in `guards`. The
  mock's `create()` refuses the same way.
- **Mock handlers take the call context, not the payload.** A handler was
  `(payload) => output` under `LambderMSW.mockApi`; a `lambder/mock` handler is
  `(ctx) => output`, with the payload on `ctx.payload`. The compiler catches a
  handler that reads its first argument, and does NOT catch one that ignores it
  or casts it, so rename the parameter before migrating and let every read
  become an error.
- **`mock.create()` requires its options argument**, and requires `guards`
  whenever the contract declares a guard name: a guard the mock does not
  declare cannot run, so the mock answered 200 where the server answers
  notAuthorized. The bare form is `mock.create({})`. `LambderMockApp`'s
  constructor no longer defaults its options argument either, for the same
  reason.
- **A mock entry must restate `rateLimit` and `idempotency`** when the
  contract declares them, the way it already had to restate `guards`. Optional,
  they were the droppable half: the restatement is the only thing that tells
  the runtime to take a claim or apply a limit, so an entry that left one out
  answered 200 where the server answers a replay, a 409 or a 429.
- **The mock's `idempotency` option is a named type,
  `LambderMockIdempotencyOptions`**, and carries the server's full set:
  `defaultTtlSeconds`, `defaultPendingTtlSeconds`, `failOpen`, `store` and
  `callerIdentity` (bound to the mock call context). Without `callerIdentity` a
  mock replayed a public endpoint's stored answer where the server, configured
  with one, misses.
- **A not-mocked session endpoint is declared with `sessionNotMocked`.**
  `notMocked` now takes public names only. The refusal runs through the
  pipeline so the steps before dispatch still happen, and the session read is
  one of them, so declaring every not-mocked endpoint public switched that step
  off and answered "not mocked" where the server answers `sessionExpired`. The
  mode cannot be recovered at runtime, because the contract is a type.
- **A rate-limit policy's custom key is typed for the runtime that will call
  it.** `LambderApiRateLimitPolicyConfig` and `LambderRateLimitPer` are generic
  over the context, the server's policies map is bound to the render context
  and the mock's to the mock call context, and `lambderRateLimitKeyBuilder`
  binds the builder the way `lambderGuardBuilder` already did. A handler built
  with the server's `lambderRateLimitKey()` used to compile against the mock
  and then read `ip`/`method`/`path` as `undefined`, so every caller collapsed
  onto one counter and a per-IP limit a test was written to prove proved
  nothing. Build mock keys with `rateLimitKey` from `initLambderMock()`.
- **`rateLimits.failOpen` replaces the limiter's own.** Fail-open is a decision
  about the request rather than about a store, so it sits beside `policies`
  (default true) and applies to any `LambderRateLimiter`, including one of your
  own, which previously had no fail-open at all. `LambderDdbRateLimiter`'s own
  `failOpen` option is gone with it: a DynamoDB error propagates, and the engine
  decides.
- **`rateLimit: {}`, `rateLimit: []` and `rateLimit: { policy: undefined }` are
  compile errors**, built from the same non-empty construction the `guards`
  option uses. All three declared a limit and enforced none.
- **A guards option with nothing in it throws at creation**, and so does a
  `rateLimits` option with no policies in it. Declaring the option is declaring
  a guard or a policy; an empty map used to leave the engine unconfigured and
  then report every API that named a guard or a policy as if the option had
  never been given.
- **Guard handlers no longer receive a resolver.** A guard is
  `(ctx, input, param)`, was `(ctx, input, res, param)`. Guards say no with
  `refuse()` or a thrown `LambderApiRefusal`. Building a response from a guard
  was never a supported idea, and a guard that "denied" by RETURNING one
  already failed open in 6.0.2, so both spellings are now rejected: the
  builder refuses a handler whose return type is a `LambderResponse`, and the
  engine throws if one reaches it through a cast. (Rate-limit key handlers are
  unchanged: they were already `(ctx, payload)`.)
- **`LambderApiGuard` types its handler's context.** The two parameters carry
  the adapter's plain and session-typed contexts, so the server's guards map is
  pinned to the render contexts and the mock's to the mock call contexts. A
  server guard dropped into a mock map compiled, read `ctx.ip` as `undefined`,
  and then authorized or refused everything.
- **`LambderRefusalMessage` takes the app's code vocabulary as a type
  argument.** `code` was `LambderRefusalCode | (string & {})`, which narrows to
  nothing: a `switch` case was not assignable and the `default: never`
  assertion failed, so the exhaustiveness the refusal codes exist for was
  unavailable. `LambderRefusalMessage<"app/...">` adds your codes, plain
  `LambderRefusalMessage` is the framework's alone, and the new
  `LambderAppRefusalMessage` is what options an app WRITES take (a policy's
  `errorMessage`, the mock's failure injection).
- **`LambderApiRequest.idempotencyKey` is `unknown`.** It is client data: the
  shape check and the client-facing 400 belong to the idempotency engine, and
  the old `string | undefined` entitled every reader to treat a number or an
  object as a key.
- **`onInvalidInput` may return `null`** to ask for the standard 422, so "no
  handler, standard 422" is implemented once, in the pipeline.
- **`parsePreflightSlice` and `toGuardEntries` are no longer root exports.**
  They are the engines' own helpers; `parsePreflightSlice` now lives beside
  `LambderApiValidationRefusal` and `toGuardEntries` is private to the guards
  engine.
- **`LambderApiOutcome`'s failure side is discriminated by `reason`**:
  `network`, `timeout`, `server` and `unknown` always carry `error`,
  `validation` always carries `zodError`, and `versionExpired`,
  `sessionExpired`, `notAuthorized` and `errorMessage` always carry `response`.
  The arms are exported as `LambderApiCallFailure`,
  `LambderApiValidationFailure` and `LambderApiEnvelopeFailure`, beside
  `LambderApiSuccessOutcome` and `LambderApiAnswerOutcome` (what
  `resolveApiOutcome` returns). Code that read `outcome.response?` or
  `outcome.error?` without narrowing on `reason` now narrows first, and needs
  no `!`.
- **`api()` and `apiOutcome()` on both callers compute their output from the
  contract** in the return type instead of taking a free type parameter, so a
  call-site annotation can no longer replace it, and take the payload as part
  of a rest tuple, so it is a compile error to omit it unless the API's input
  accepts `undefined`.
- **`LambderCallOptions.headers` and `LambderInvokeCallOptions.headers` are
  `Record<string, string>`**; a number as a header value no longer compiles.
- **A rejected invoke that carries the Lambda SDK's own service-exception marks**
  (`AccessDeniedException`, `ResourceNotFoundException`,
  `RequestEntityTooLargeException`, a throttle) **is `protocol` rather than
  `network`**, and a `LambderInvokeTransport` may throw
  `LambderTransportFailure` to name its own reason. Genuine connectivity
  failures stay `network`.
- **`LambderCookieJar.storeSetCookies` takes the full target, `secure`
  included.** A target known to speak plain http now refuses a `Secure` cookie
  instead of storing one it would never send.
- **`LambderDdbCache` no longer defaults `region` to `"us-east-1"`.** Leaving
  the option out now means the AWS SDK's own default chain, the way the rate
  limiter, the idempotency store and the session store have always behaved. An
  app that deployed outside Virginia and relied on the old default has to name
  the region.
- **`LambderExpiringMap.set()` throws unless `expiresAt` is a positive whole
  number of epoch seconds**, and `size` and `values()` never sweep, so
  reading the map never writes to it.
- **A rate-limit window capped at anything but a non-negative integer throws
  at creation**, and so does a per-API override of one, and so does an
  override that takes away the policy's last enforced window. A limiter is
  handed only limits it can act on, which is where the two implementations
  used to disagree.
- **An idempotency replay window that a store cannot act on throws at
  creation**, both as `defaultTtlSeconds` and as an API's own `ttlSeconds`.
- **Every `per: "ip"` rate limit changes its key**, because `ctx.ip` no longer
  reads a forwarding header unless `trustedClientIpHeaders` names one. Nothing
  in an app's code has to change for this to happen, so it is listed here as
  well as under Security; an app behind Cloudflare must set the option or its
  limits will key on the gateway address.
- **The policy layer moved into `src/api/`** and `LambderApiPolicies.ts` is
  `LambderApiPolicyEngine.ts`, named for the one thing it exports (same names
  from the root entry; only deep imports break). `policies/` and `api/` were
  one unit split across two directories: they imported each other in both
  directions, every file in `policies/` was already named `LambderApiXxx`,
  and docs/api-core.md described the policies as pipeline steps.
- **`LambderMockApp` split into four collaborators it composes**:
  `LambderMockEntryRegistry` (registered entries and the overrides over them),
  `LambderMockCallRecorder` (subscriptions and the bounded call log),
  `LambderMockFailureInjector` (queued and standing failures, the offline
  switch, latency, and the answers an injected failure renders) and
  `LambderMockBrowserCookies` (the jars the runtime built for itself and the
  copies it planted in the page's own cookie storage, the one piece that
  touches `document`). They were four state machines in one class,
  sharing no field and meeting only at `handleRequest`. Each owns its own state
  now, and the app's **surface is unchanged**: every method a caller used is
  still there, delegating. The four are deliberately not exported, since the
  runtime is reached through the app. `LambderMockTransportError` moved to
  `mock/LambderMockFailureInjector.ts`, and is still exported from
  `lambder/mock`.
- **`LambderSessionStore` moved to `shared/`, `LambderMemorySessionStore` to
  `stores/`, and `shared/LambderRateLimitWindows.ts` is
  `shared/LambderRateLimiter.ts`** (same names from the root entry; only deep
  imports break). The three store interfaces sat in three different places
  while docs/api-core.md presented them as one symmetric set, and the memory
  session store sat apart from its two siblings, so a reader looking for it
  beside them did not find it.
- **The file-source family is laid out like the other three store families.**
  `shared/LambderFileSource.ts` holds `LambderFile`, the `LambderFileSource`
  interface and `remoteStoreFile`, beside `LambderSessionStore`,
  `LambderRateLimiter` and `LambderIdempotencyStore`;
  `stores/LambderLocalFileSource.ts` holds the local implementation beside
  `LambderS3FileSource` and `LambderHttpFileSource`; `core/LambderFiles.ts`
  keeps the reader and owns the path rule (`toRelativePath` is module-local
  there, its only caller). Root exports are unchanged; a deep import of
  `core/LambderFiles.js` or `stores/LambderFileSource.js` for a source is not.
- **`lambderCookieJarTransport` moved to its own module,
  `shared/lambderCookieJarTransport.ts`.** The name and all three entries
  (`lambder`, `lambder/client`, `lambder/mock`) are unchanged; only a deep
  import of `shared/LambderApiTransport.js` has to move.
- **`compressPayloadBrotli` and `DEFAULT_INVOKE_REQUEST_COMPRESSION_SETTINGS`
  moved to `shared/LambderRequestPayload.ts`**, beside their gzip twins. The
  root entry exports them under the same names.
- **The invoke outcome vocabulary moved to `invoke/LambderInvokeOutcome.ts`**
  (`LambderInvokeError`, `isLambderInvokeError`, `LambderInvokeOutcome`,
  `LambderInvokeFailure`, `LambderInvokeFailureReason`,
  `LambderInvokeFunctionError`; same names from the root entry). It is what a
  caller of the caller reads, and reading it meant opening the caller's own module;
  `shared/LambderApiOutcome.ts` already serves the browser side this way.
- **The idempotency store's types moved to `shared/LambderIdempotencyStore`**,
  and the rate-limit vocabulary (`LambderRateLimitWindow`,
  `LambderRateLimitPolicy`, `LambderRateLimitExceeded`,
  `LambderRateLimitResult`, `RATE_LIMIT_WINDOWS`) moved from
  `stores/LambderDdbRateLimiter` to `shared/LambderRateLimiter`, so a store
  implements an interface without importing an engine or an SDK. Same names
  from the root entry; only a deep import breaks.
- **`LambderHttpEventFormat` is declared in `LambderContext`** rather than in
  `LambderResponse`, which removes the type cycle between the two. The root
  export is unchanged.
- **`DieResolverMethods` and `LambderResponseInit` are no longer exported from
  their modules**; neither was reachable from an entry point.
- **`ctx._otherInternal` is gone.** `ctx.api` is the parsed API request (null
  on a route, so `isApiCall` is `ctx.api !== null` and `requestVersion` is
  `ctx.api?.version`), `ctx.eventFormat` the payload format,
  `ctx.responseHeaders` the header accumulator `res.setHeader`/`res.addHeader`
  write to, and `ctx.logList` the logList channel.
- **`LambderRateLimitKeyFn`'s context type widened to `any`.** Code that
  annotates a key handler with the type loses the context's typing and gets
  no error where it used to. The `lambderRateLimitKey()` builder still pins
  it, so building keys through the builder is unaffected.
- `restoreBytes` returns a `Uint8Array` (a `Buffer` on Node).
- `LambderApiAnswer` (the resolver's `api` method type) is now
  `LambderResolverApiMethod`; the name `LambderApiAnswer` is the core's answer
  type.
- `LAMBDER_INVOKE_HEADER`, `LAMBDER_INVOKED_BY_HEADER` and
  `LAMBDER_INVOKE_PROTOCOL` moved to `invoke/LambderLambdaEvent.ts` (same
  exports from the root entry).
- **`LambderRefusalCode` gained `lambder/not-mocked`**, so an exhaustive
  switch over the union stops compiling until it handles the new member.
- **`LambderMswModule` changed shape and moved** to `lambder/mock`:
  `HttpResponse` is the constructor plus `error()`, where it was `{ json() }`.
- **`lambder/testing` and `LambderMSW` are gone**, replaced by `lambder/mock`
  and `LambderMockApp`.
- **`decompressPayloadGzip` is gone from `lambder/client`.** Inside the
  framework the core's `restoreCompressedPayload` replaces it, but that is a
  server-entry export and takes a request rather than a base64 string, so a
  browser consumer that decoded payloads itself has no drop-in replacement.
- **Two aliases are gone, with nothing kept in their place**:
  `LambderSessionContext` is `LambderSessionRecord` and
  `LambderInvokeHttpResult` is `LambderLambdaHttpResult`. Both named exactly
  what they aliased.
- **A caller outside a browser sends `siteHost: ""`** where 6.0.2 threw a
  `ReferenceError` on `window`. Nothing in the framework reads the field, but
  an app that routes on it sees the change.
- **`res.api(null, {})` is a compile error on an endpoint whose output is
  not nullable.** The null overload takes `LambderApiNullAnswerConfig`, the
  response config with at least one reason field (`errorMessage`, `message`,
  `notAuthorized`, `sessionExpired` or `versionExpired`). A bare null with no
  reason reached the caller as a success whose payload was null, which no
  caller could tell from an endpoint that answered nothing on purpose.
- **The exported pipeline's `guards` option is bound to its own public
  context**, the way its `rateLimits` option already was, so a guard built for
  another adapter is a compile error there too.
- **A session token half may be up to 1024 hex characters, in either case.**
  The bound that keeps a planted oversized cookie out of the store used to be
  256 lowercase characters, which `LambderPlainSessionCrypto` (it hex-encodes
  its input rather than hashing it) crossed for a session key and salt over
  128 characters, and which a custom crypto minting uppercase or longer
  halves crossed on every session: such sessions read as "no session" with no
  warning. The store's partition-key limit is still comfortably clear.
- **Names that were one word, or named for something they are not, are
  renamed; nothing is kept under the old name.** `LambderApiError` is
  `LambderApiRefusal`, `isLambderApiError` is `isLambderApiRefusal`,
  `LambderApiErrorOptions` is `LambderApiRefusalOptions`, and
  `LambderApiValidationRefusal` with `isLambderApiValidationRefusal` follow: it is
  the thing a guard or a handler throws to say no, and everything around it
  was already called a refusal. `LambderDdbIdempotency` and
  `LambderMemoryIdempotency` are `LambderDdbIdempotencyStore` and
  `LambderMemoryIdempotencyStore` (and `LambderDdbIdempotencyOptions` is
  `LambderDdbIdempotencyStoreOptions`), the noun their interface and their two
  sibling families carry. `LambderMockFailureKind` is
  `LambderMockFailureReason`, like every other `...FailureReason`.
  `LambderApiResponse`, the contract's per-endpoint envelope, is
  `LambderApiEnvelopeBody`, so it no longer reads as the API flavour of the
  server's `LambderResponse`. `MergeContract` is `LambderMergeContract`,
  `ApiContractShape` is `LambderApiContractShape`, `HttpStatusCode` is
  `LambderHttpStatusCode` (a name half a dozen HTTP libraries use),
  `ConditionFunction` is `LambderRouteConditionFn`, `RouteCondition` is
  `LambderRouteCondition` and `PathParamsOf` is `LambderPathParamsOf`: the
  last five were the public type names still carrying no prefix.
  The deep-import paths move with them (`shared/LambderApiRefusal.ts`,
  `api/LambderApiValidationRefusal.ts`, `stores/LambderDdbIdempotencyStore.ts`,
  `stores/LambderMemoryIdempotencyStore.ts`), and `shared/node-polyfills.ts`,
  which polyfills nothing and probes for four optional Node modules, is
  `shared/LambderNodeModules.ts`.
- **`errorMessage` is typed on both sides**: `LambderAppRefusalMessage | string`
  on `LambderApiRefusalOptions`, on the envelope, on the caller's failure
  outcome and on `errorMessageHandler`, where it was `any` everywhere. A
  handler that read `message.content` had no type to read it from; an app
  with its own vocabulary puts it in `code` and the fields a refusal message
  carries.

- **`engines.node` is `>=20`.** The package's own `lru-cache` dependency
  declares `"20 || >=22"`, so the old `>=18` claim emitted `EBADENGINE` on
  install and failed outright under `engine-strict`. Node 18 is out of support
  and AWS has deprecated the `nodejs18.x` runtime; every current Lambda
  Node.js runtime clears the floor.
- **An idempotent API demands its key at the call site.** When a contract
  entry declares `idempotency`, the call's options argument is required and
  carries `idempotencyKey: string`, built the way `guardInputs` already was
  and read off the contract with `LambderContractIdempotencyOf`. A server
  declaration that reads as protection used to provide none if the caller
  forgot the key: the server runs a keyless call, which dedupes nothing, so a
  double submit placed two orders. Both callers get it from the shared call
  typing.
- **`LambderInvokeFailure` is a discriminated union, like
  `LambderApiOutcome`.** `validation` always carries `zodError`, `crash`
  always carries `functionError`, `payloadTooLarge` always carries `bytes`,
  the envelope reasons always carry `response`, and the delivery reasons carry
  it when the callee answered; `error`, `logList` and `cookies` are on a
  shared base. Narrowing on `reason` narrows the fields, so a reader writes
  no optional chains and no `!` for evidence the reason guarantees. The arms
  are exported as `LambderInvokeValidationFailure`,
  `LambderInvokeCrashFailure`, `LambderInvokePayloadTooLargeFailure`,
  `LambderInvokeEnvelopeFailure` and `LambderInvokeDeliveryFailure`.
- **`createSession` refuses an empty `sessionKey`.** It names the subject the
  session belongs to and partitions the store, and `lookupSession` rejects a
  record without one, so an empty key wrote a record no read could ever
  accept while handing the caller a valid-looking cookie pair: every request
  after it read as a silent logout. Same class as the TTL refusal beside it.
- **`LambderSessionControllerOptions.tokenCookieKey` and `csrfCookieKey` are
  required.** The defaults live once, in `shared/LambderSessionCookieNames.ts`,
  and are applied where the app's session options are read; the controller
  defaulted them a second time, which meant a controller built without them
  read cookies the app does not write. Only code constructing
  `LambderSessionController` directly is affected;
  `lambder.getSessionController(ctx)` is unchanged.
- **`finalizeResponse` takes `Pick<ctx, "method" | "header">`** rather than
  the raw `headers` map, so the two request headers it reads go through the
  context's own case-insensitive lookup and the second copy of that lookup is
  gone.
- **`LambderMockFailure` and `LambderMockTransportError` spell their
  discriminant `reason`, not `kind`.** `mockApp.failNext("x", { reason:
  "rateLimited" })`, `err.reason`. Every sibling in the package already used
  the word; the rename of `LambderMockFailureKind` to
  `LambderMockFailureReason` had stopped at the type's name. The string form
  (`failNext("x", "network")`) is unchanged.
- **`LambderMockOverride` is `{ restore(): void }` alone.** The handle's
  `[Symbol.dispose]` member, and with it `using stub = mockApp.override(...)`,
  is gone: that member is declared only under `lib: ESNext`, so the published
  `.d.ts` answered TS2550 for a consumer on `lib: ES2022` who did nothing but
  import the entry with `skipLibCheck` off, and the Node fallback it came with
  did not do what its comment said. A try/finally around `stub.restore()`
  scopes an override in every project and needs no lib.
- **A mock entry may be a bare handler only where the contract declares
  nothing for the endpoint.** The form was gated on guards alone, so for every
  endpoint with no guards the mandatory `rateLimit` and `idempotency`
  restatements were optional again: the handler ran twice for one key where
  the server replays, and a `perMin` limit never answered 429. `publicApi` and
  `sessionApi` take the options form wherever the contract declares guards, a
  rate limit or idempotency.
- **`LambderMockApp.signOut(sessionKey, { jar?, host? })`** takes the jar it
  should clear, symmetric with `signIn`.
- **The three per-API policy option shapes live in
  `src/shared/LambderApiOptionValues.ts`**: `LambderGuardsOptionValue` (was
  `api/LambderApiGuards.ts`), `LambderRateLimitOptionValue` and
  `LambderRateLimitOverride` (were `api/LambderApiRateLimits.ts`) and
  `LambderApiIdempotencyOption` (was `api/LambderApiDefinition.ts`). A
  contract records the options an API declared and the engines read the same
  shapes back, so the declarations belong below both; before this,
  `shared/LambderApiContract.ts` imported three types out of `api/`, which was
  a four-module cycle. Root entry names are unchanged; only the deep-import
  path moved.
- **`LambderAnswerHeaders` moved from `api/` to `shared/`**
  (`src/shared/LambderAnswerHeaders.ts`, with `getAnswerHeader`,
  `setAnswerHeader` and `addAnswerHeader`). It is a pure header accumulator
  with no API vocabulary in it, and `core/`, `mock/`, `session/` and `api/`
  all build on it. Root entry names are unchanged.
- **`LambderCreatedHook` is declared beside the class in `core/Lambder.ts`**
  rather than in `core/LambderCreateOptions.ts`. Its parameter is the
  instance, and that back-edge made the options module unreadable without the
  class and made `dist/core/LambderCreateOptions.d.ts` import the whole class
  declaration for any app naming a single option type. The root entry exports
  the name from `./core/Lambder.js`; the name is unchanged.
- **Four internal pass-through re-exports are gone, and every importer names
  the module that declares the type.** `LambderSessionRecord` and
  `LambderSessionStore` are read from `shared/LambderSessionStore.js` rather
  than through `session/LambderSessionManager.js`; `LambderApiMode` from
  `shared/LambderApiContract.js` rather than through
  `api/LambderApiDefinition.js`; `LambderHttpStatusCode` from
  `shared/LambderHttpStatus.js` rather than through `core/LambderResponse.js`;
  and `LAMBDER_INVOKE_HEADER`, `LAMBDER_INVOKED_BY_HEADER` and
  `LAMBDER_INVOKE_PROTOCOL` from their home module
  `invoke/LambderLambdaEvent.js` rather than through
  `invoke/LambderInvokeCaller.js`. `LambderInvokeSession` and the pure failure
  readers (`classifyDeliveryFailure`, `errorFromFunctionError`,
  `parseFunctionError`, `describeFailure`) moved out of the invoke caller too,
  the first to `invoke/LambderLambdaEvent.js` beside the event it becomes a
  cookie on, the rest to `invoke/LambderInvokeOutcome.js` beside the reasons
  they describe. Entry names are unchanged throughout; a deep import of any
  of these names must now name the declaring module.
- **`acceptsEncoding`, `LambderHeaderTarget` and the `LambderPublicFilesHandler`
  class are no longer exported from the root entry.** The first is an
  `Accept-Encoding` parser used once inside `finalizeResponse` (an adapter
  that compresses reaches for `resolveCompressionOption` and `compressText`);
  the second is the structural parameter type of `LambderAnswerHeaders.applyTo`,
  which a caller passing a `LambderResponse` never names; the third is reached
  through `servePublicFiles()`, the way its `LambderIndexHtmlHandler` sibling
  always was (`LambderPublicFilesOptions` is still exported).

### Security

- **An `ip`-keyed rate limit runs before the session is read.** A request
  carrying bogus session cookies reached the session store first, which scans a
  partition and reads up to four candidates, and was answered `sessionExpired`
  without the limiter ever running: ten requests against a `perMin: 1` policy
  cost forty store reads and zero 429s. Policies whose key is known from the
  request alone are checked first; `per: "session"` and custom key handlers
  stay after the read, since they may need the session. The replay lookup is
  behind the same gate, so a retry does count against an `ip` budget: those
  limits bound store traffic, not handler runs.
- **`ctx.ip` is the address the gateway observed unless the app names a header
  it trusts**, through the new `trustedClientIpHeaders` option. It used to read
  `cf-connecting-ip`, then the leftmost entry of `x-forwarded-for`, then the
  gateway, whether or not anything in front of the app wrote either; API
  Gateway appends to `x-forwarded-for` rather than replacing it, so the
  leftmost entry is the client's own claim. Every `per: "ip"` rate limit was
  therefore keyed on a value the caller chose, which is not a limit. An app
  behind Cloudflare or a rewriting proxy should set
  `trustedClientIpHeaders: ["cf-connecting-ip"]`. This one also appears under
  Breaking, because it changes the key of every existing `per: "ip"` limit on
  upgrade and nothing in an app's code has to change for it to happen. An
  invoke is not exempt: the `x-lambder-invoke` marker is a signal for guards
  and hooks and authorizes nothing, and a genuine invoke carries the caller's
  address in `requestContext.http.sourceIp`, which is where `ctx.ip` reads it
  from anyway.
- **`ctx.ip` carries one spelling per address.** A forwarding proxy may write
  the RFC 7239 bracket-and-port form (`[2001:db8::1]:443`) or a plain
  `host:port`, and IPv6 has several textual forms for one address. Each
  variant reaching a rate-limit key untouched was its own counter, which is a
  limit that does not limit, so the port and brackets are stripped, the result
  is lowercased, and anything longer than the longest valid address is
  truncated rather than trusted as a key.
- **The session scan asks about identity alone, and the CSRF pairing once
  afterwards, which is what makes a planted cookie reachable.** Asking "how
  many sessions is this browser holding" and "does the posted CSRF token
  match" as one question always answered "one": a sibling subdomain plants its
  own CSRF cookie beside the session it planted, only one CSRF token is ever
  posted, and no two sessions share a `csrfTokenHash`, so exactly one candidate
  survived the pairing and the ambiguity was invisible on every API call. The
  scan now runs on identity alone and the pairing is asked once, afterwards, of
  the single session the cookies resolved to.
- **A planted CSRF cookie no longer produces a logout loop that cannot heal.**
  The CSRF cookie name is counted in the same pass as the session cookie. The
  browser client reads its token with `Cookies.get`, which returns the first
  copy in `document.cookie`, and a browser orders a longer `Path` first, so a
  sibling host that plants one CSRF cookie at a parent domain decided which
  token every call posted: the session cookie resolved, the pairing failed, the
  answer was a plain `sessionExpired` that emits no `Set-Cookie`, and the
  planted copy survived the logout and the next sign-in. When the session
  cookie names a live session and the posted token pairs with nothing, more
  than one CSRF cookie under the name, or a posted token matching none of them,
  now takes the ambiguity refusal and clears every scope this host can write. A
  planted cookie beside the real one while the posted token DOES pair still
  resolves: the client picked the real token, so the other copy is inert.
- **More session cookies than the reader will weigh is a refusal, not a trim.**
  The first few used to be read and the rest dropped unread, so anyone able to
  plant cookies at a parent domain could push the visitor's own copy out of the
  read with four of their own at a longer `Path`: nothing validated, no
  eviction was emitted, and the logout never healed. Over the cap the request
  is refused and every scope cleared, without reading the store at all.
- **An oversized planted session cookie no longer turns a live session into a
  500.** Each candidate is checked against the minted token format (two hex
  halves joined by a colon, neither over 1024 characters) before
  any store read, so a malformed candidate is "no session" rather than a read
  error. A cookie may carry 4000 characters and DynamoDB refuses a partition
  key over 2048, so the unchecked candidate reached the store as a key it
  cannot take and the victim's own live session answered 500 on every request.
- **A candidate session is not renewed until it is known to be the caller's.**
  The read and the structural checks are `lookupSession`, the `dataRefresh`
  callback and the sliding-expiration write are `renewSession`, and the
  controller's scan uses the first. Weighing several cookies used to slide the
  expiry of every one of them and run the app's `dataRefresh` for each, so a
  planted cookie was kept alive indefinitely by the victim's own traffic.
- **Two session cookies that both validate are refused, not resolved, and
  every scope this host can write is cleared.** One live session under a name
  is ordinary; two are not, since any sibling subdomain can plant a cookie at
  a parent domain that arrives beside the real one, with its own CSRF cookie
  so the pairing check does not catch it. Picking one signed the visitor into
  whichever arrived first. Clearing only the configured scope would have been
  worse than picking: a deletion matches only a cookie carrying the same
  Domain, so it would evict the visitor's own copy and leave the planted one
  as the sole survivor. The refusal clears the host-only scope, the configured
  one, and every parent domain of the request host.
- **A session cookie no longer keeps its creation expiry while the record
  slides.** When a sliding write moves the expiry, the response re-issues both
  cookies at the new `Expires`, so a continuously active visitor is no longer
  signed out at `createdAt + ttl`, the one deadline sliding expiration exists
  to push back. The CSRF cookie is re-issued only with a value known to pair
  with the session.
- **A record a store hands back under keys other than the ones it was asked
  for is no session.** `lookupSession` compares the record's two hashes against
  the query in constant time, which costs no hashing and is what a store that
  keys loosely runs into instead of handing back somebody else's session.
- **A `__Host-` or `__Secure-` session cookie name is checked against its own
  preconditions at creation.** A browser silently discards a `__Host-` cookie
  that carries a `Domain`, is not at `Path=/`, or is not `Secure`, and a
  `__Secure-` cookie that is not `Secure`, which would look like an app with no
  sessions at all, so the combination throws instead. The check is
  `assertSessionCookiePrefixes` in the session layer, which is where the cookie
  names live, rather than in the API pipeline. The prefix is the structural
  answer to a sibling subdomain planting a session cookie; see docs/sessions.md.
- **Non-cryptographic session crypto cannot sit in front of a persistent
  store.** `LambderPlainSessionCrypto` neither hashes nor draws random bytes,
  so over a store that outlives the process every record would be a usable
  credential and the `sessionSalt` would be readable out of the partition key.
  The manager now refuses the pair outright.
- **A cookie named for an `Object.prototype` member no longer answers 500 on
  every request.** The request's cookie map was a plain object, so a cookie
  named `__proto__`, `constructor` or `toString` resolved to the prototype and
  the push that followed threw before any handler ran; a sibling subdomain
  could plant such a cookie at a parent domain for good, since nothing on the
  500 path clears cookies. Every adapter now builds the map through one
  `cookieValuesByName` on a prototype-free object, and such a name reads as a
  cookie like any other.
- **A guard's input is read as data.** `guardInputs` is client-supplied and was
  read with a plain property access, so a guard named for something
  `Object.prototype` carries (`toString`, `constructor`) received the
  inherited function instead of the absent value the client did not send, and
  a check for "no token" never fired. Guard and rate-limit policy names are
  looked up in Maps for the same reason.
- **`guardInputs` must be an object, not an array.** An array is an object and
  answers for its own properties, so a guard named `length` received a number
  where the client had sent it nothing: the same reading the
  `Object.prototype` fix above is about, one shape over.
- **A guard cannot deny by returning a response**, at build time through the
  builder and at runtime through the engine. The returned value used to become
  `ctx.guardData[name]` and the call carried on. A guard that answers on one
  branch is rejected like one that always answers: the check used to distribute
  over the return union, so `LambderResponse | undefined`, which is the
  ordinary spelling of "return a response to deny", picked the harmless branch
  and passed the builder.
- **A guard built for one adapter no longer compiles into the other's guards
  map.** `LambderApiGuard` types its handler's context, the server's map is
  pinned to the render contexts and the mock's to the mock call contexts. A
  server guard in a mock map read `ctx.ip` as undefined and then authorized or
  refused everything.
- **A validation refusal's body is bounded by bytes, not by issue count.** A
  public API validates before any guard, so an unauthenticated caller chose the
  size of this body: one `unrecognized_keys` issue carries every key the client
  posted and zod's own `message` carries the tree a second time, so a
  `strictObject` answered a 1MB request with 4MB, and past `maxResponseBytes`
  the 422 became a 500. The serialized issue list is capped at about 32KB,
  oversized values inside one issue are shortened, `issueCount` says the answer
  was trimmed, and the generated summary always replaces zod's message.
- **A public API's idempotency scope can carry who the caller is**, through
  the new `callerIdentity` on the idempotency option. A public API's scope was
  the posted key alone, which makes the key a bearer token for its own stored
  answer: the replay is served before guards run, so an API whose
  authorization IS a guard handed its response to anyone presenting a known
  key, with the guard never consulted. `callerIdentity` runs before guards and
  sees only what the request carries, and is the app's to write because the
  credential to read is the app's to know: a single-use guard input such as a
  captcha would give the legitimate retry a different scope and defeat the
  replay it needs.
- **The idempotency scope escapes its fields.** It joined API name and key
  with a pipe and escaped neither, where the rate limiter escaped both;
  `shared/LambderKeyFields.ts` now holds the one implementation both use.
- **A rate-limit tracker key escapes the field separator**, so two callers
  whose keys differ only around a pipe cannot land on one counter.
- **An over-long idempotency scope key is refused with a clear error** rather
  than reaching DynamoDB as a `ValidationException`, which an engine set to
  fail open swallowed into no idempotency at all. `LambderDdbIdempotencyStore.begin()`
  and every other method throws when the scope key plus its prefix would exceed
  DynamoDB's 2048-byte partition key limit, and the message carries byte
  counts, never the key.
- **The in-memory idempotency store no longer drops a pending claim to make
  room.** At its ceiling the old eviction took whatever expired soonest, and a
  claim's minutes always lost to a settled record's day, so two concurrent
  retries could both be granted the scope and both execute. Claims are now held
  back from eviction, settled records are spent instead, and a store with
  nothing but live claims reports the duplicate as pending rather than running
  it.
- **A failing rate limiter or idempotency store is logged.** Both engines
  default to failing open, which is right and was indistinguishable from
  working: the failure class includes a missing table and a missing IAM action,
  so an app could run unmetered, or execute every retry twice, with nothing in
  its logs. The log names the policy and its windows, or the API, and never the
  tracker or scope key, which carry the caller's identity.
- **`serveIndexHtml`'s `redirectTrailingSlash` can no longer be talked into an
  off-origin `Location`.** A leading run of slashes and backslashes collapses
  to one slash, and a target that would still be protocol-relative falls
  through to the route fallback, so `GET //evil.example/` no longer answers
  `301 Location: //evil.example`.
- **A 304 carries the call's headers**: `Set-Cookie`, anything written with
  `res.setHeader`, and the CORS headers, dropping only the three that describe
  a body. A cacheable GET that also slides a session cookie keeps refreshing it
  on revalidation, and a cross-origin revalidation is readable again.
- **The cookie-jar transport over fetch sends the jar's cookies as a `Cookie`
  header**, so a session carried by a jar actually reaches the server outside a
  browser. It used to collect every `Set-Cookie` and send none of them back,
  leaving every session call answering `sessionExpired`.
- **`LambderCookieJar.cookiePairs()` returns RFC 6265 send order**, longest
  `Path` first and then oldest first, so a server reading the first of a
  repeated cookie name gets what a browser would have sent.
- **`LambderCookieJar`'s matching rules are tough-cookie's**, which is the
  reference RFC 6265 implementation and carries the public suffix list. The
  jar keeps its own shape (Set-Cookie header lists in, `name=value` pairs out,
  a target given as a host and path rather than a URL, since a transport that
  never speaks HTTP has no URL to give) and hands the rules to the library:
  domain and path matching, default-path, Max-Age against Expires, Secure,
  HttpOnly, and the `__Host-`/`__Secure-` prefixes. Three behaviours changed
  with it: `Domain=co.uk` and every other multi-label public suffix is now
  refused, which is the whole reason to carry the list and cannot be done by
  counting labels; a `Domain` on an IP-literal host is refused outright rather
  than kept host-only, and the same cookie without a `Domain` still works; and
  `Domain=localhost` is accepted, because localhost is a special-use name
  rather than a registry suffix and a local development setup runs on it.
  `tough-cookie` is a dependency rather than a peer: its only dependency is
  `tldts`, it imports no Node built-in, and a bundle that never imports the
  jar never pulls it in.
- **`LambderCookieJar` refuses a `Domain` it cannot verify.** It kept whatever
  a `Set-Cookie` claimed, so a jar talking to more than one host would accept
  `Domain=example.com` from a sibling and send it to every host under the
  parent, and `Domain=com` to every `.com` host. The sending host must now be
  the domain or under it, and a one-label domain is refused outright. A jar
  with no host refuses every `Domain` cookie rather than trusting it; give it
  one with `new LambderCookieJar({ host })` where that matters.
- **A request header named `__proto__` reads as a header.** The lowercased
  header map was a plain object, so the name reached Object.prototype's
  setter and vanished, and `ctx.header("__proto__")` answered the prototype
  itself rather than `undefined`. The map is prototype-free, like the cookie
  map beside it.
- **The MSW adapter reads the document's cookies pair by pair**, so a name
  the page holds at two scopes keeps both values and the session controller
  can weigh them under MSW the way it does on the server; a whole-header
  parse kept only the first.

- **The file reader's path rule refuses every way out of a source's root,
  not just `..`.** It used to strip exactly ONE leading slash, so a request
  for `//x` reached a source as `/x` and `///attacker.example/evil.html` as
  `//attacker.example/evil.html`. `LambderHttpFileSource` resolves what it is
  given as a URL reference against `baseUrl`, so the first form left the
  configured folder and the second was protocol-relative and named a host of
  the caller's choosing: one unauthenticated GET fetched an attacker-named
  origin with the app's configured `headers` (an Authorization token for a
  private origin, say), then served the attacker's `text/html` body from the
  app's own domain, under the app's cookies, and cached it. The rule now
  strips every leading slash and refuses an empty result, a trailing slash,
  and any segment that is empty, `.`, `..`, or contains a backslash, and
  `LambderHttpFileSource` re-checks the URL it built: anything whose `href`
  does not start with the base reads as null. The local source has always had
  the equivalent belt against its root; the remote one was the only layer
  trusting the reader's contract rather than re-checking it.
- **A surplus key inside `cors` or `compression` is a compile error.**
  `create()` is generic over `const TOptions`, which switches excess-property
  checking off for the whole literal, so `cors: { credentials: true, origns:
  [...] }` compiled, left the config with no allowlist at all, and
  `applyCorsHeaders` read that as `"*"`, which with credentials on echoes
  whatever Origin asked: an app that wrote an allowlist ran with none and
  nothing said so. Both options join `session`, `session.cookie`,
  `idempotency`, `rateLimits`, its `policies`, `guards` and the object form of
  `files` under the nested surplus-key rule.
- **A rate-limit tracker key is bounded before any limiter sees it.** The
  variable half of the key (a custom key handler's return, a `per: "session"`
  session key) is replaced by its own SHA-256 past 1024 UTF-8 bytes, as
  `custom:h:<hex>` or `session:h:<hex>`, with the api and policy names still
  readable around it. A store refuses a key it cannot take by throwing, and a
  throw from a limiter is exactly what `rateLimits.failOpen` swallows, so a
  custom key derived from a payload field (the documented shape, an email
  address) that a caller posts 3,000 characters long used to fail every
  window of every policy the same way and let the request through unmetered,
  with the limit silently off. Folding keeps distinct callers on distinct
  counters and leaves a key that fits untouched. `LambderDdbRateLimiter`
  refuses, on its own, a partition key DynamoDB will not take, before it
  counts anything, with the byte count and never the key, the check its
  idempotency sibling already made and both now share; a key that reaches
  that refusal came from a direct caller.
- **`idempotency.callerIdentity` can no longer be written against a session
  that is never there.** It is consulted only on public APIs, and a public
  call reads no session, so `ctx.session` was `null` on every call: the
  documented spelling `(ctx) => ctx.session?.data?.userId ?? null` compiled,
  ran, returned null every time, and left every public replay key a bearer
  token for its own stored answer, which is the hole `callerIdentity` exists
  to close. Its context parameter is now `Omit<LambderApiCallContext,
  "session">` on the server and the mock alike, so the mistake is a compile
  error, and the option's documentation names what the request actually
  carries: `guardInputs`, `payload`, `headers` and `ip`.
- **A synthesized invoke event owns its forwarded address and its invoke
  markers.** `synthesizeLambdaHttpEvent` no longer writes `x-forwarded-for`
  at all (the address the call asserts travels in
  `requestContext.http.sourceIp`, which is what `resolveClientIp` reads), and
  it deletes any caller-supplied `x-forwarded-for`, `x-lambder-invoke` and
  `x-lambder-invoked-by` before writing the ones it owns. A gateway lambda
  that forwards an incoming browser request's headers into a call's
  `headers`, an ordinary pattern, used to hand a callee configured with
  `trustedClientIpHeaders: ["x-forwarded-for"]` an end-user-chosen `ctx.ip`:
  a `per: "ip"` rate limit could then be evaded per request, and any guard or
  audit row keyed on `ctx.ip` recorded a fiction. The same ownership rule
  stops a browser-shaped in-process event from claiming to be an invoke.
- **`LambderCaller.createIdempotencyKey()` has no guessable path left.** The
  `Math.random` fallback is gone: it is `crypto.randomUUID`, then
  `crypto.getRandomValues`, and a runtime with neither throws, saying why.
  The key scopes the replay record for a logged-out client, so a guessable
  one hands that client's stored response to whoever guesses it, and
  `getRandomValues` is not secure-context gated, so the branch was only
  reachable on a runtime with no `crypto` at all.
- **A stored idempotency body's declared length is bounded.** `bodyBytes` is
  the budget the restore decompresses under, so a record claiming petabytes
  let a few hundred kilobytes of Brotli expand until the function died.
  Anything past 32MB is a record this store did not write and is refused, the
  way the cache already bounds a manifest against `maxValueBytes`.

### Added

- **The API core** (`src/api/`): `LambderApiRequest`, `LambderApiAnswer`,
  `LambderApiEnvelope` (the one place the envelope is written and every
  refusal rendered), `LambderApiValidationRefusal`, `LambderApiCallContext`,
  `LambderApiDefinition` and `LambderApiPipeline`, the pipeline both the
  Lambda server and the mock runtime run. `Lambder.ts` is now an adapter over
  it. `pipeline.prepare()` is the protocol's pre-pass (the version gate and
  the compressed-payload restore) as one named step, so the server can run it
  before its hooks and route matching without the order living in two places.
  See docs/api-core.md.
- **The root entry exports the core's building blocks by name**, so an app can
  write its own adapter over the pipeline instead of reaching into `dist/`:
  the envelope functions (`buildApiEnvelope`, `envelopeAnswer`,
  `refusalAnswer`, `validationAnswer`, `apiNotFoundAnswer`,
  `sessionExpiredAnswer`, `versionExpiredAnswer`, `invalidPayloadAnswer`,
  `crashAnswer`), `readApiEnvelope` and `restoreCompressedPayload`,
  `createApiCallContext`, the answer-header helpers (`LambderAnswerHeaders`,
  `getAnswerHeader`, `setAnswerHeader`, `addAnswerHeader`, `toHttpAnswer`),
  and `LambderApiPipeline` with its option, request, answer and result types.
  They are part of the public surface and bound by semver like every other
  export of an entry point.
- **`pipeline.run(request, ctx, definition, exec, trace?)` writes into a trace
  the adapter owns**, so a handler that throws still leaves `guardsRun` and
  `replayed` behind for the adapter's catch.
- **`LambderAppRefusalMessage`**, the refusal message type an app's own options
  take, exported from the root and the client entry.
- **Store interfaces and memory stores**: `LambderRateLimiter`,
  `LambderIdempotencyStore` and `LambderSessionStore`, with
  `LambderMemoryRateLimiter`, `LambderMemoryIdempotencyStore` and
  `LambderMemorySessionStore`. The whole policy and session layer is testable
  in-process with no AWS SDK; the session tests moved off the SDK mock. All
  three sit on `LambderExpiringMap`, which expires an entry on read and on an
  amortized sweep and holds a ceiling so a key space that never repeats cannot
  grow the process without bound.
- **`maxEntries` on all three memory stores**, `LambderMemorySessionStore`,
  `LambderMemoryIdempotencyStore` and `LambderMemoryRateLimiter`, so the ceiling is
  reachable from the deployment instead of being the map's hardcoded default.
  Reaching it evicts the entry that expires soonest, which for a session is a
  logout for whoever held it, and each store's docs say what it costs.
- **`now` on `LambderDdbIdempotencyStore` and `LambderDdbRateLimiter`**, the
  injectable clock the memory stores already had, so the conformance suite
  drives both implementations through one clock.
- **`LambderExpiringMap.set(key, value, expiresAt, { evictable })` and the
  exported `LambderExpiringMapFullError`**: an entry can be kept out of the
  ceiling eviction, and a write that cannot be made room for is refused rather
  than paid for by somebody else's entry.
- **Isomorphic sessions**: `LambderSessionManager` and
  `LambderSessionController` work on the call context, hash through
  `LambderSessionCrypto` (WebCrypto by default, `LambderPlainSessionCrypto`
  where a runtime has none and the store dies with the process), and run in a
  browser. The controller gained `issueSession()`, `createSession` handing the
  raw tokens back, and `reissueSession()`, the same for `regenerateSession`: a
  client that holds its CSRF token rather than reading `document.cookie` (a
  native app, an invoke caller) needs the new one after a rotation.
- **`LambderSessionNotFoundError` and `LambderSessionAmbiguousError`**, the two
  "no session" exits of a session read. `fetchSessionIfExists()` answers null
  for these and for nothing else, so a `TypeError` from a custom store or a bug
  in the session layer is a crash rather than a silent logout: the old
  catch-all turned any defect into `sessionExpired`, which makes the client
  clear its cookies.
- **Transports**: `LambderApiTransport` as the browser caller's `transport`
  option and `setTransport()`; `lambderFetchTransport` (the default),
  `lambderHandlerTransport` (a real Lambder handler in-process through a
  browser-shaped event), `lambderCookieJarTransport` and `LambderCookieJar`
  (a browser's cookie storage for transports that have no browser), and
  `LambderTransportFailure` with `isLambderTransportFailure`, so a transport
  says why it could not deliver instead of leaving the caller to assume the
  network. The caller reads the site host from `globalThis.location` and runs
  in Node.
- **`LambderCaller` takes a `logListHandler`**, the browser twin of
  `LambderInvokeCaller`'s `onLogList`, overridable per call; the default still
  prints each entry with `console.log`.
- **Every `LambderInvokeOutcome`, success or failure, carries `cookies`**, the
  answer's `Set-Cookie` values, so a session the callee rotated or cleared is
  visible to the caller carrying it.
- **`DEFAULT_SESSION_TOKEN_COOKIE_KEY` and `DEFAULT_SESSION_CSRF_COOKIE_KEY`
  are exported from `lambder/client` as well**, from their one definition in
  `shared/LambderSessionCookieNames.ts`, so a browser reading a cookie name
  names the same constant the server writes.
- **The contract carries `mode`, `rateLimit` and `idempotency`** beside
  `guards`, and `lambder/client` exports helpers that read a contract type:
  `LambderContractMode`, `LambderContractKeysWithMode`,
  `LambderContractGuardNames`, `LambderContractGuardInput` and the rest.
- **`lambder/mock` and `LambderMockApp`**: `initLambderMock<Contract,
  SessionData>()`, name-first entry builders (`publicApi`, `sessionApi`,
  `notMocked`), `apiSlice` and an exhaustive `register` checked by the
  compiler for completeness, strays, modes, guards and overlap,
  `registerPartial` and restorable `override`s, mock guards through the same
  engine, sessions carried by cookie jars, failure injection, latency,
  `reset`, a keyed subscription and a call log, `lambderMockConsoleLogger`,
  `lambderMockMswHandler` (one MSW handler over the runtime, with
  `onUnmocked: "passthrough"` for a partially mocked app) and
  `lambderMockInvokeTransport` (the mock as a callee of
  `LambderInvokeCaller`). A mock entry may carry its own `input` schema, so
  the 422 path can be exercised in development; it is deliberately the mock's
  own, because the contract is a type and the server's schemas do not exist on
  that side. The mock context carries an `envelope` handle for the `message` a
  server handler would pass to `res.api`, and `revealHandlerErrors` (default
  true) answers a thrown handler with the message it threw. See docs/mock.md.
- **`mockApp.restNotMocked(reason)`**: one entry, passed to the same
  `register()` call as the slices, standing for every endpoint they leave out.
  `register()` stays exhaustive by construction and strays and duplicates in
  the slices are refused exactly as before, so a contract the mocks only partly
  cover can be adopted in one line: a call to an endpoint nothing registered
  answers the `lambder/not-mocked` refusal carrying the reason rather than
  `apiNotFound`, and is logged with the outcome `notMocked`. Its one limit is
  the session read, which it cannot run: the answer is processed as a public
  endpoint, because the mode of a name nothing registered is not knowable at
  runtime, so a signed-out call to an unmocked session endpoint says "not
  mocked" where the server says `sessionExpired`. Declare such an endpoint with
  `sessionNotMocked` and leave the rest to the rest entry. It is the
  alternative to the MSW adapter's `onUnmocked: "passthrough"`, and wins over
  it: every name has an entry, so nothing is passed to the network.
- **`cookieHost` on the mock app**: one host for every cookie the runtime
  holds, defaulting to the page's own host. `signIn` plants cookies there and
  the transport's jar sends them there.
- **`lambder/mock` exports `LambderMockOverride`,
  `LambderMockIdempotencyOptions`, `LambderMockInvokeEvent`,
  `LambderMockInvokeResult`, `LambderCreatedSession` and
  `LambderSessionManager`**, all of them return or option types the entry
  already handed out.
- **`requireSessionApiGuards` and `requirePublicApiGuards` keep their
  compile-time half when the options are spread from a separately typed object
  or built in a helper**, instead of silently reading as off.
- **The import-graph gate covers `lambder/mock` as well as `lambder/client`**:
  the mock entry may reach only the API core, the session layer, `shared/` and
  the memory stores, and neither entry may reach `aws-lambda` or the AWS SDK,
  at value or type level.
- `LAMBDER_REFUSAL_CODES.notMocked`, and `rateLimitRefusal()` for the 429 the
  engine and the mock's failure injection both throw.
- `lambder.getResponseBuilder(ctx?)` is documented as what it returns, a
  `LambderResponseBuilder` with no `res.die.*`.
- **Test suites that pin what nothing else did**: an adapter conformance suite
  drives one declaration through the server and the mock and asserts identical
  answers across the protocol matrix; a conformance suite per store interface
  (tests/store-conformance) drives every implementation of all three through
  one set of rules, every rate-limit window included; the wire format and the
  session hash construction are frozen as fixtures (tests/wire-format), which
  nothing else protected, since every other test computes its expectations
  with the code it is testing; and tests/package-exports imports through the
  real `exports` map, which nothing did.
- **The handler and hook types are exported from the root entry under
  descriptive names**: `LambderRoutePath`, `LambderRouteHandler`,
  `LambderSessionRouteHandler`, `LambderActionHandler`, `LambderActionFilter`,
  `LambderHookEvent`, `LambderCreatedHook`, `LambderBeforeRenderHook`,
  `LambderAfterRenderHook`, `LambderFallbackHook`, `LambderGlobalErrorHandler`,
  `LambderFallbackHandler` and `LambderInputValidationHandler`. They appeared
  in the public method signatures as unexported locals (`ActionFunction`,
  `Path`, `HookBeforeRenderFunction`), so a hook written outside its
  registration call had no type to be declared with.
- **The root entry exports, by name, the building blocks an adapter or a
  test reaches for**: `answerFromResponse` and `responseFromAnswer` (a
  `LambderResponse` to and from the core's answer), `API_ANSWER_CONTENT_TYPE`,
  `DEFAULT_RATE_LIMIT_REFUSAL`, `buildTransportEnvelope`,
  `synthesizeLambdaHttpEvent`, `decodeLambdaHttpResult`, `localLambdaContext`,
  `parseSetCookie`, `isWebCryptoAvailable`, `isLambderApiValidationRefusal` and
  the `LambderWebCrypto` class beside `LambderPlainSessionCrypto`.
- **`create()` checks the object form of `files` for surplus keys**
  (`{ source, memoryCach: false }` is an error at the key), and the mock's
  `create()` checks each guard in its `guards` map the same way, so
  `sesion: true` on an inline mock guard no longer registers a public guard in
  silence.

- **`servePublicFiles` takes the same `methods` option as `serveIndexHtml`,
  default `["GET", "HEAD"]`.** A write method against an asset path used to be
  served the file and never reached `setRouteFallbackHandler`. Both slots and
  a route matcher's `method` share one rule, which also folds `HEAD` into
  `GET` unless the list names `HEAD` itself, so narrowing a slot to `["GET"]`
  no longer 404s every `HEAD`.
- **`LambderDdbCache` takes a `now`**, the clock entries are expired against,
  like the rate limiter and the idempotency store, so the four DynamoDB stores
  say the same thing about their clock.
- **`LambderLogListHandler`**, the `logListHandler` option's type, is exported
  from the root and the client entry beside `LambderCallOptions` and
  `LambderCallerOptions`, the way its invoke twin `LambderInvokeLogListHandler`
  already was.
- **`rateLimits.failOpen` on `mock.create`**, the server's own option: a
  limiter of the app's own that throws refuses the call instead of letting it
  through. The idempotency option already carried its twin.
- **`LambderMockMswTarget.cookieHost`**, which the MSW adapter scopes its jar
  by, the way it already read `defaultClientIp` from the app.
- **`package.json` exports `./package.json`.** With an exports map and no such
  entry, `require.resolve("lambder/package.json")` and
  `import pkg from "lambder/package.json"` were blocked, which some build
  tooling and version probes do.

### Changed

- **The directory graph is a DAG, type edges included.** Directories are
  layers and imports only ever point down: `shared/` at the bottom, then
  `stores/`, `session/`, `api/`, `client/`, then the three adapters `core/`,
  `mock/` and `invoke/`, then the entries. A type-only import obeys the same
  rule as a value import. The rule is written down in `docs/api-core.md`,
  and `tests/package-exports.test.ts` enforces the
  direction over the whole tree, one allow list per directory (`invoke/` may
  name a `core/` type; `mock/` may import only the memory stores). The module
  graph has zero cycles at value level and zero with type-only edges counted.
- **The session layer no longer names an API type.**
  `LambderSessionController` reads exactly two fields of a call, so it is
  typed over `LambderSessionCallSurface<SessionData>` (`{ session,
  responseHeaders }`), declared in its own module, instead of importing
  `LambderApiCallContext` from `api/`. The pipeline and both adapters keep
  passing their full context; `session/` depends on nothing above `shared/`.
- **The pipeline's `guards` option pins the session context too.**
  `LambderApiPipelineOptions.guards` binds a guard's session context to the
  pipeline's own context with the session narrowed to a record, which is what
  both shipped adapters declare, so the last `any` in the guard binding is
  gone and a third adapter gets the binding this release advertises.
- **`LambderApiPipeline.policies` is private**, and the mock's `pipeline`
  field is too; the mock's phantom `P` type parameter is off `LambderMockApp`
  (it stays on `create`, where it infers the policy names). Nothing read any
  of them.
- **The minted-token format check moved into `LambderSessionManager`**
  (`isMintedSessionToken`, exported, with the 1024-character ceiling beside
  it). The manager mints and splits `sessionKeyHash:secret`, so the question
  "is this string that format" belongs beside the format rather than in the
  cookie reader; the controller imports it and still asks it of every
  candidate cookie before any store read.
- **SHA-256 over text exists once**, in `shared/LambderTextDigest.ts`
  (`sha256HexOf`, `resolveWebCrypto`, `bytesToHexString`): `LambderWebCrypto`
  hashes through it and the rate-limit engine folds long keys with it. The
  session layer keeps its own unavailability message, the one that names
  `LambderPlainSessionCrypto` as the way out.
- **The request envelope is built from one field set.** `buildEnvelopeFields`
  in `shared/LambderApiTransport.ts` states the fields a call sends and in
  what order; `buildTransportEnvelope` hands it the payload as a value, and
  the invoke caller's `buildEnvelopeJson` splices its already-serialized
  payload onto the end of it. The two used to list the fields separately, so
  a new envelope field could be added to one sender and missed by the other
  with nothing on the wire to catch it. Likewise the per-call compression
  threshold is decided once, by `resolveRequestCompressionMinBytes` beside
  the two compressors, where both callers had written out the same override
  rule.
- **`lambderHandlerTransport` takes a `LambderHandler`** rather than a
  hand-written signature, and every in-process caller defaults its client
  address to the shared `LOOPBACK_CLIENT_IP`; the mock normalizes the address
  once, in `requestFromTransport`, so a `per: "ip"` limit keys one address as
  one counter whichever of its three paths a call arrived on.
- **One base64 spelling.** `core/LambderResponse.ts` and
  `invoke/LambderLambdaEvent.ts` encode through `bytesToBase64` rather than
  their own `Buffer.toString("base64")`.
- **The mock's option types live in `src/mock/LambderMockCreateOptions.ts`**
  (`LambderMockAppOptions`, `LambderMockSessionsOptions`,
  `LambderMockIdempotencyOptions`, `LambderMockTransport`,
  `LambderMockTransportOptions` and the guards option shapes), beside the
  rules that decide which keys `create()` accepts, the way
  `core/LambderCreateOptions.ts` holds the server's. No name changed, and
  `lambder/mock` exports them from the same entry as before.
- **Twenty-seven declarations lost an `export` keyword they had no importer
  for**, so they no longer land in `dist/*.d.ts` as public noise (among them
  the guard-check helper types in `api/LambderApiGuards.ts`, the option-shape
  helpers in `core/LambderCreateOptions.ts`, the abort types in
  `shared/LambderCallAbort.ts`, the SDK loader types in
  `stores/LambderDdbSdk.ts`, `escapeKeyField`, `compressPayloadWith`,
  `normalizeHeaders` and `isCompressibleContentType`). `LambderCookieJar`
  carries a class doc comment, so `dist/shared/LambderCookieJar.d.ts` has
  one.
- **Dead code and dead defaults are gone.** `LambderCaller`'s constructor no
  longer applies `apiPath ?? "/api"` or `isCorsEnabled = false` to options
  its own type requires; the unreachable `try/catch` around request body
  decoding in `createContext` is gone (`base64ToText` cannot throw, so it
  caught nothing reachable and would have hidden a real failure); the
  private `getRequestHeader` in `core/LambderResponse.ts` is gone with the
  `finalizeResponse` signature change; `LambderInvokeCaller.fail()` is
  `failureOutcome()`, `deliver()` is `deliverEvent()`, and
  `LambderCookieJar.matching()` is `matchingCookies()`, all private.
- **`@types/cookie` and `@types/path-to-regexp` are gone from the dev
  dependencies** (both packages ship their own declarations) and `msw` joined
  them, so the MSW adapter's types are compiled against the real package.
- **The gates grew.** `tests/package-exports.test.ts` reads Node's own
  `builtinModules` instead of a five-name list, derives the `browser` field
  from the import graph (every built-in a bundler would be asked to resolve
  must be mapped, and a mapping with nothing behind it fails too),
  classifies type-only imports per specifier and runs the external-dependency
  rules over type edges as well, gates the client entry by the same allow
  list shape as the mock entry (so "reaches neither `core/` nor `session/`"
  is pinned in both halves), enforces the layering direction over the whole
  tree, and checks `docs/exports.md` against the three entries in both
  directions. The store-conformance suite has a `LambderDdbIdempotencyStore`
  row at `minBytes: 0` and the in-memory DynamoDB double evaluates a
  condition against a missing or unreadable attribute as false, the way
  DynamoDB does, rather than as zero. The adapter-conformance suite gained an
  entry `input` schema's 422, `ctx.envelope.message` and `ctx.logList`, a
  handler-written response header, a non-string `idempotencyKey`, a
  `per: "session"` limit and `callerIdentity` scoping. The crypto seam and
  `LambderBase64`'s no-Buffer branch have tests of their own, the MSW type
  test compiles the documented wiring against the real `msw`, and the three
  wall-clock assertions in the suite are fake timers or ordering
  assertions.

### Fixed

- **Headers survive a crash with no global error handler, which is the default
  configuration.** A global error handler is not the default, so the plainest
  app of all, one whose handler throws, wrote its session record and sent the
  browser nothing: signed in on the server, signed out in the browser, and a
  cross-origin caller could not read the error either, because the CORS headers
  went with them. The last-resort answer now carries the call's headers and its
  CORS headers. It is still emitted without finalizing, because finalization
  may be what failed; applying headers is plain object work and none of the
  compression, base64 or size handling that finalization does. The mock runtime
  had the same hole from the other side and applies the call's headers on every
  exit.
- **Headers written during a call are no longer lost when an afterRender hook
  answers with a different response**, nor when the global error handler
  answers a crash. They belong to the call, not to the response that first
  carried them, which is how routes always treated them. A login API plus a
  response-rewrapping hook wrote its session record and sent the browser no
  cookie, with no error anywhere; a call that set a cookie and then threw lost
  the cookie and every CORS header with it, so a cross-origin caller could not
  even read the error.
- **An `afterRender` hook can override or delete a header the handler wrote.**
  The call's headers are applied before the hooks run, and only what the hooks
  themselves wrote is applied afterwards; a hook that answers with a different
  response still ships the whole set.
- **A `created` hook that fails no longer answers every later invocation on
  that warm container with the first failure.** The cached initialization is
  forgotten on rejection and the next invocation runs the hooks again.
- **A thrown value that cannot be turned into a string no longer escapes.**
  `String(err)` was the first statement of the outermost catch, so an object
  with a null prototype, a Proxy, or a throwing `toString` made the catch
  itself throw: the error handler never ran, no envelope was produced, and the
  invocation rejected with a 502 carrying nothing a client could parse.
- **A registration that throws no longer consumes the API name**, so a caller
  that catches the error and retries sees the problem it is fixing rather than
  a duplicate-name error. A session API whose registration is refused is the
  same case and no longer burns its name either.
- **The "you forgot `guards`" error names what is wanted** instead of reading
  `guards: never`, and creation and registration errors from the server adapter
  all carry the `Lambder: ` prefix.
- **Each policy subsystem reports its own absence.** An API declaring `guards`
  on an instance with no guards map was told that none of rate limits, guards
  or idempotency was configured, which reads as a question about all three; a
  second `guards` map at creation is now refused rather than merged, the way
  the other two engines already refused one.
- **Annotating a policies map compiles.** `LambderRateLimitPer<Ctx>` and
  `Record<string, LambderApiRateLimitPolicyConfig<Ctx>>` were a hard TS7006 on
  `ctx`, because a union with a function member in each arm defeats contextual
  typing, so a policies map could not be declared apart from the `create()`
  call at all.
- **The exported pipeline binds `rateLimits` to its own context type**, so a
  third adapter built over the documented core gets the binding this release
  fixes for the two shipped ones.
- **`answerUnknownApi` carries the call's headers** and holds no version gate:
  both adapters run `prepare()` before a name is resolved, so a stale client
  has already been answered by then.
- **The 422 carries the call's `logList`,** as every other answer does, and the
  server no longer carries its own copy of "no handler, standard 422":
  `inputValidationRefusal` answers `null` and the pipeline renders the standard
  body.
- **The mock runs the protocol's pre-pass before it resolves the name**, which
  is where the server runs it. An unknown name reached the notFound refusal
  without the version gate or the payload restore, so a stale client or a
  malformed compressed payload was answered differently by the two adapters:
  the server said 400, the mock said 200 with an `api-not-found` refusal. The
  request event was emitted before the restore too, so a dev panel watching
  calls in flight showed no payload for exactly the compressed calls someone
  opens a panel for.
- **A guard is recorded before its own input schema runs.** A guard that
  refuses by rejecting its `apiInput`/`guardInput` slice answers 422, and the
  trace ended on the name of the guard *before* it, which is the one
  misreading a trace cannot recover from.
- **The guards that ran are reported, the refusing one last.** A guard is
  recorded before it runs, so the trace ends on the name that said no and the
  guards after it never appear. Both idempotency replay paths are called
  replays. All of it used to be assembled from side channels that a refusal
  discarded, and the mock's call log said "no guards ran" for exactly the
  calls someone was debugging. The mock's log reports them on a call that
  crashed too, because the pipeline's trace is handed in and survives the
  throw.
- **`ctx.guardData` has no prototype.** Guard names are the app's to choose,
  and a check-only guard named `toString` read back as the inherited function.
- **An `errorMessage`, `message` or `crash` an app set to an empty value now
  reaches the caller.** The envelope tested truthiness, so `errorMessage: ""`
  shipped as no `errorMessage` at all and the caller's handler never ran.
- **A refusal's header replaces the envelope's own under any casing**, rather
  than shipping a second `Content-Type` beside it.
- **The idempotency engine hands the store a copy of the answer.** The pipeline
  applies the call's own headers into the answer after the record is stored, so
  a store that kept the object it was given (the shipped ones copy; a custom
  one is under no compiler's supervision) had this call's `Set-Cookie` in the
  record and replayed it to everyone.
- **`callerIdentity` runs once per call** rather than once at the replay lookup
  and again at the claim. It is app code that may verify a token or read a
  store.
- **A pending idempotency claim's lifetime is configurable**, through
  `defaultPendingTtlSeconds` and a per-API `pendingTtlSeconds`. It was a fixed
  five minutes while a Lambda may run fifteen, so a claim could expire while
  its own handler was still working and hand the next retry a free scope,
  which runs the operation a second time. The default is unchanged at 300.
- **The two idempotency stores agree about an owner settling after its claim
  expired.** `LambderMemoryIdempotencyStore` dropped the expired entry on read and
  reported "lost"; `LambderDdbIdempotencyStore` checked only the owner token and,
  because TTL deletion is lazy, usually still had the item and reported
  "stored", so the answer depended on whether AWS had swept yet. Both report
  "lost", and tests/store-conformance pins it.
- **`LambderDdbIdempotencyStore` reads stored items as a typed record with its
  load-bearing fields checked.** An unreadable status code replays as 200
  instead of NaN, headers that are not a multi-value map are dropped instead of
  reaching the response builder, a stored `__proto__` header cannot touch the
  object being built, and an unreadable expiry counts as expired instead of
  immortal.
- **`LambderDdbIdempotencyStore.complete()` takes the same record type as the memory
  store**, and `LambderMemoryIdempotencyStore.recordOf()` hands back a copy.
  `LambderIdempotencyStore` documents the copy-on-write rule the pipeline
  depends on, and the conformance suite asserts it: the suite's ten early
  returns are gone, which used to let every rule about a granted claim pass on
  a store that granted none.
- **A cookie written before the handler no longer disables idempotency.** The
  engine refuses to store an answer carrying a `Set-Cookie`, and a stale
  session cookie evicted during the session read was being charged to the
  handler's answer, so an idempotent operation silently re-executed on every
  retry. The rule now weighs what the handler itself wrote.
- **A store failure while recording an answer no longer turns a completed
  operation into a 500.** Settling happens after the handler has run, so
  failing closed there could not prevent anything: it answered 500 and
  released the claim, so the retry found no record and executed the operation
  a second time, which is precisely what idempotency exists to prevent.
  `failOpen` governs the decision before execution, where refusing still means
  refusing to act. A cleanup failure no longer masks the handler's own error
  either.
- **`idempotency: false` no longer requires a configured store.** An explicit
  opt-out asks for nothing and needs nothing behind it.
- **The idempotency budget applies on the uncompressed path too.** With
  compression off an oversized body reached DynamoDB and came back as a
  ValidationException, which is not a conditional-check failure, so it escaped
  as a store error instead of "too-large".
- **The bounded memory map evicts what expires soonest, not what was written
  earliest.** Insertion order retired exactly the entries with the most life
  left in them, which are the long-window rate-limit counters and the day-long
  idempotency records, so a flood of short-lived keys could reset a monthly cap
  or drop somebody else's pending claim. A flood now evicts mostly itself.
- **A write at the in-memory ceiling no longer costs a full sweep plus a full
  scan.** Eviction takes a batch of one percent of the ceiling and the sweep
  stays amortized, where the full sweep used to run from inside the eviction
  and double the cost of every write once the map sat at its ceiling: measured
  at 100,000 entries, 0.56 ms per write became 0.007 ms.
- **The in-memory rate limiter joins its counter fields through the escaping
  join**, so no two tracker keys can land on one counter.
- **A session record whose data will not decode reads as no session again**,
  which is what `docs/sessions.md` and the store's own docstring always said.
  Moving the Brotli decode inside `LambderDdbSessionStore.get` put it inside
  the manager's read-failure guard, so it surfaced as a 500 instead. The two
  have to stay apart: a read failure is transient infrastructure and signing
  somebody out over a DynamoDB blip is the worse answer, while a record that
  will not decode will not decode on the next request either, so a 500 there
  leaves a session the visitor can neither use nor clear until the TTL
  retires it.
- **A failed sliding-expiration or `dataRefresh` write is logged with its
  reason** instead of being swallowed, so a store that fails every renewal is
  visible as something other than users being signed out early. The log carries
  neither the record nor the tokens.
- **The "several cookies arrived, reading each" warning is emitted after the
  cap check**, where reading actually happens: over the cap nothing is read at
  all.
- **`LambderDdbSessionStore.fromItem` validates the fields a session record is
  made of before casting**, so an item written by hand, by an older schema, or
  by another app sharing the table reads as no session instead of reaching the
  constant-time comparisons as a non-string.
- **`LambderMemorySessionStore` joins its key through the shared
  `joinKeyFields` escaping and copies records through JSON** the way DynamoDB
  serializes them, so an `undefined` field drops and a cyclic value throws on
  both stores rather than only on the real one.
- **`crypto.timingSafeEqual` is used again where the runtime has it**, with the
  constant-time loop as the fallback for browsers.
- **The DynamoDB stores no longer keep private copies of the shared
  vocabulary**, the three with a store interface declare it, and all four share one
  `ready()` implementation (which is what let their region handling drift
  apart) and load the SDK through one document-client loader in
  `stores/LambderDdbSdk.ts`, so a supplied document client no longer pulls in
  `@aws-sdk/client-dynamodb` and a conditional-check failure is recognised
  through one predicate. The idempotency store loads `crypto` through the same
  optional seam as everything else instead of importing it statically.
- **An API handler's binary body is compressed.** A `Buffer` reached
  finalization as the base64 the core carries it in, which is never
  compressed, so a large `res.file()` from an API shipped a third more bytes
  and could cross the Lambda response cap.
- **Compressed payloads restore in a bundled browser build.** `fs`, `path`,
  `zlib` and `crypto` are mapped to `false` for the browser, and bundlers
  honour that with a stub module rather than a failed import, so the absence
  was read as presence and the first real call into it threw. Each module is
  now asked for a function it would really export.
- **The package declares `sideEffects: false`**, so a bundler may drop what a
  consumer never imports. `lambder/client` re-exports `LambderCookieJar` as a
  value, and neither `tough-cookie` nor `tldts` declares the field, so the
  public suffix list rode along into every page that imported the client
  entry: measured at 371,677 bytes against 27,125 for the same program once
  the field is set. The jar stays on the browser entry, because a caller
  running under Node genuinely needs it; what matters is that nothing else
  reaches tough-cookie, which `tests/package-exports` now pins.
- **A synthesized invoke event's own headers cannot be displaced by the
  caller's.** `headers` was spread last, so a per-call entry overwrote the
  forwarded address and could erase or downgrade the invoke markers.
  Forwarding an incoming request's headers into `options.headers` is an
  ordinary gateway-lambda pattern, which made this reachable from outside.
- **`LambderInvokeCaller` no longer believes an answer that arrived after its
  own timeout**: a 20ms `timeoutMs` against a 300ms callee now reports
  `timeout` rather than `ok: true`, through `localTransport`, the mock invoke
  transport and any custom transport. `LambderInvokeCaller.localTransport`
  honours the signal by ending the wait, the way `lambderHandlerTransport`
  does.
- **Both callers refuse a call whose signal had already aborted** before
  handing it to the transport, so an abandoned call never reaches the callee.
- **`LambderCaller` detaches its abort listener when a call settles**, instead
  of leaving one per call on a shared external signal.
- **`LambderCaller.api()` returns `undefined` on failure, not `null`**; the
  docs and the docstring said different things and both now match the code.
- **`lambderFetchTransport` explains a relative apiPath outside a browser**,
  which fetch reports as a URL parse error and the caller used to pass on as
  `network`.
- **`Content-Encoding: identity` is accepted on an invoke answer.** It is a
  legal value meaning no encoding, and a hook or a proxy may set it; it was
  read as unsupported and turned the whole invoke into a protocol failure.
- **A `LambdaClient` passed as `client` keeps whatever `maxAttempts` it was
  built with**, which the option docstring and the docs now say: `clientConfig`,
  and the one-attempt default, apply only to a client the caller creates.
- **`clientIp` on an invoke is documented as what it is**, the event's
  `requestContext.http.sourceIp`; no IP header is trusted at either end.
- **The documented MSW wiring compiles against msw 2 again.** The adapter's
  resolver type matches msw's own, and the handler it returns keeps the
  module's handler type, so `setupWorker(handler)` takes it. The declaration is
  pinned against a replica of msw's signature rather than against itself.
- **The MSW adapter reads calls from the app's `defaultClientIp`** instead of a
  hardcoded `127.0.0.1`, and the mock's invoke transport reads the caller's
  address from the synthesized event's `sourceIp`, as the server's
  `createContext` does and through the same `normalizeClientIp`; it used to
  prefer `x-forwarded-for`, the trust this release removed from the server, and
  did not normalize the value. One client is one address under both adapters,
  so a per-IP rate limit counts it once.
- **The mock no longer signs a browser out on any host but plain `localhost`.**
  `signIn` planted cookies at `localhost` while the transport's jar scoped them
  by the caller's site host, so every session call on a dev host such as
  `shop.localhost:5173` answered sessionExpired with a full jar.
- **`sessionNotMocked` runs the same registration checks the other builders
  run**, so a session endpoint on a mock without the `sessions` option fails
  where it is written instead of answering 500 at the first call with a message
  naming the server's option.
- **A mock entry's `input` schema is pinned to the contract in both
  directions.** The schema is the mock's own, because the contract is a type
  and the server's schemas do not exist on that side, but what it parses to is
  the server's. A bare `z.ZodType` let a restated shape drift from the endpoint
  it stands for, and the mock then answered 422 to every payload the server
  accepts, which is the exact failure the schema exists to reproduce; a schema
  stricter than the endpoint (an extra required field, a literal) is refused
  for the same reason.
- **A mock registration that throws no longer consumes the names of the
  slices before it.** Slices were added one entry at a time, so a later slice
  failing a check left the earlier ones registered, and a caller that caught
  the error, fixed its slices and called again hit a duplicate-name error from
  its own first attempt instead of the problem it had fixed. Slices are staged
  and committed together now. (The server side of this was already fixed; the
  mock had the same shape.)
- **The mock's record of a call is built in one place**, the call recorder, so
  its event and its log row cannot say different things about the same call,
  and the browser-cookie mirror lives in its own collaborator.
- **`lambder/mock`'s type graph no longer reaches `aws-lambda` or
  `@aws-sdk/client-lambda`**: the mock's invoke transport declares the event
  and result shapes it uses. The entry reaches no `core/` module at all.
- **`examples/mock-app-example.ts` compiles under the repository's own
  typecheck**, with no `@ts-nocheck` over it.
- **`LambderHttpStatusCode` moved to `shared/LambderHttpStatus.ts`** (same name from
  the root entry, which now reads it from the module that declares it). It is
  HTTP vocabulary with no relationship to the server's response class, and
  importing it from `core/` was the one edge that pointed the wrong way: it
  pulled `core/LambderResponse.ts`, and with it `aws-lambda`, into the type
  graph of `lambder/client`, so a browser-only consumer needed
  `@types/aws-lambda` resolvable to typecheck a status union. `lambder/client`
  now reaches neither `core/` nor `session/`, which `tests/package-exports`
  pins.
- **`LambderResponse`'s three header methods are the API core's header
  helpers** rather than a second copy of them, and the cookie serializer lives
  in `shared/LambderCookie.ts`, which was the one runtime edge from the
  isomorphic layers into `core/`. Root-entry names are unchanged.
- **The response brand the guards engine tests for is one constant** in
  `shared/LambderResponseBrand.ts`, imported by `LambderResponse` and by the
  engine, where the engine used to retype the symbol's name by hand: a rename
  of the symbol would have reopened the guard fail-open with every test green.
- **Copies that had already drifted are one implementation each**: base64
  encoding and decoding in `shared/LambderBase64.ts`, the default session
  cookie names in `shared/LambderSessionCookieNames.ts` (one definition where
  there were four), the positive- and non-negative-integer option checks in
  `shared/LambderOptionChecks.ts`, coercing a thrown value to an `Error` in
  `shared/LambderCrashDetail.ts` (a caller failure no longer reports the
  literal message `"Error: "`), and the abort wiring both callers share.
- **`maxRequestPayloadBytes` is validated once**, by the pipeline that owns it,
  rather than by an identical check in the server adapter as well.
- **The contract's `mode` vocabulary has one declaration.** It was written out
  twice as a type and three more times as inline literals.
- **Docstrings attach to their declarations again** on `LambderApiPipeline`,
  `LambderApiGuard`, `LambderGuardOf` and the idempotency engine, and `src/api/`
  no longer imports from `core/` at all: `lambderGuard` and
  `lambderRateLimitKey` are built in `core/LambderPolicyBuilders.ts` from the
  generic builders, the answer-header accumulator is `shared/LambderAnswerHeaders.ts`,
  and `LambderApiCallTrace` sits beside the call context in
  `api/LambderApiCallContext.ts`, which dissolves every module cycle inside
  `src/api/`. Root-entry names are unchanged.
- **`Lambder.ts` is shorter and sectioned**, with the API pipeline moved out
  on top of that: the option and handler types and the option
  validation live in `core/LambderCreateOptions.ts`, the index-HTML layer in
  `core/LambderIndexHtml.ts`, and the class reads as construction,
  registration, accessors, the request path and the API path.
- **`LambderExpiringMap` never answers a write it did not keep.** At a ceiling
  made entirely of protected entries, an evictable write used to evict itself
  and return normally with nothing stored; the write is now refused with
  `LambderExpiringMapFullError`, and the entry just written is never its own
  victim. An expired entry is reclaimed before any live one is evicted,
  protected or not, in the same walk the batch already makes.

- **`maxResponseBytes` counts bytes.** It compared `String.length` against
  the ceiling, which is UTF-16 code units, so an uncompressed non-ASCII body
  passed a guard it was up to three times over and Lambda then refused the
  invocation with an opaque payload-size error and no envelope, which is the
  outcome the option exists to replace. A base64 body keeps `.length` (it is
  ASCII); everything else is measured with `Buffer.byteLength(body, "utf8")`,
  and the error message reports bytes.
- **`beforeRender` hooks run for `servePublicFiles` and `serveIndexHtml`
  answers.** The loop sat after route matching, so every static asset and
  every app-shell page skipped the one hook that can inspect a request,
  replace its context or answer in its place: a `Content-Security-Policy` set
  in a hook reached the API answers and not the HTML it was written for, and
  a maintenance-mode or blocklist hook served the whole frontend anyway. The
  loop is one method now, run for a matched route (after `ctx.pathParams` is
  populated, as before) and at the top of the unmatched path, before the
  `fallback` hooks, which are still typed `void` and still cannot answer.
- **CORS is applied once to a preflight.** The 204 was given the preflight
  headers where it was built and the ordinary ones again at the end of
  `render()`, so an allowlisted app answered every preflight with
  `Vary: Origin, Origin` and an `Access-Control-Expose-Headers` that means
  nothing before a request.
- **A v1 event's cookies are read from `multiValueHeaders` when it carries
  them.** API Gateway REST APIs keep only the LAST value of a repeated header
  in `headers`, and HTTP/2 lets a client split its cookies across several
  `Cookie` headers, so a copy could be dropped before the session scan that
  weighs every copy of a name. v2 events already delivered them all.
- **`<!--if:name-->` looks up its own properties only.** It read `data[name]`
  straight, so `<!--if:toString-->` was unconditionally true on every render;
  it uses the same own-property check the slot lookup uses.
- **The host-only eviction no longer deletes a live cookie on its own.** When
  a request carries several session cookies and a `cookie.domain` is
  configured, the response evicts the host-only twin. Which copy is stale is
  an assumption (the request carries no scope), and for an app that
  configured a domain after running host-only it is the wrong one: the
  visitor's live cookie IS the host-only copy, and any sibling host can make
  the twin arrive by planting a well-formed dead cookie at the parent domain.
  The eviction now always ships with the resolved session re-issued at the
  configured scope in the same response, so the visitor stays signed in, and
  a domain migration converges on the first request instead of waiting for a
  sliding write.
- **A refusal an app spells out as the empty string is read as a refusal.**
  The envelope writer keeps `errorMessage: ""` on purpose; `resolveApiOutcome`
  tested truthiness, so the refusal arrived and was dropped and the call
  resolved `ok: true` with a null payload, on both callers, with
  `errorMessageHandler` never running. Both halves now test presence, the
  browser caller's `message` check included.
- **The `logList` of a failed answer reaches its handler.**
  `resolveApiOutcome` carries `logList` on every arm it can: the envelope's on
  a success or an envelope refusal, the parsed 500 body's on a server failure,
  and the validation body's on a 422, which the server writes there as it
  does onto a success. Each caller surfaces it once, immediately after
  reading the answer and before any failure branch. The browser caller
  surfaced logs only after its early returns for `server` and `validation`,
  so a 500 whose global error handler attached `crash` and `logList`, the
  answer whose log trail is worth the most, was the one answer whose logs
  were never printed; the invoke caller read them off the envelope only, and
  dropped a 422's.
- **A per-call header cannot displace the ones `lambderFetchTransport`
  owns.** The caller's `headers` go on first and `Content-Type` and the jar's
  `Cookie` after them, matching the synthesized event's rule. A Node script
  or test that added one `Cookie` header of its own used to replace the whole
  Cookie header a `LambderCookieJar` had just built, losing the session and
  getting `sessionExpired` with nothing in the failure pointing at the cause.
- **`lambderCookieJarTransport` scopes the jar by where the call actually
  goes.** The host is `apiPath`'s own host, then the `host` option, then the
  caller's `siteHost`. An `apiPath` that names a host is a fact about this
  request; the option is the fallback for a relative path. The old order let
  a transport configured with `{ jar, host: "app.example.com" }` and an
  absolute cross-origin `apiPath` send app.example.com's session to another
  host.
- **`LambderInvokeCaller.request()` refuses an oversized event like an API
  call does.** The `LAMBDER_INVOKE_MAX_EVENT_BYTES` guard moved into the
  delivery path both methods share, so a large `body` comes back as
  `payloadTooLarge` with the byte count instead of the SDK's
  `RequestEntityTooLargeException` classified as `protocol`.
- **A throttled DynamoDB `Query` no longer deletes a healthy cache entry.**
  `LambderDdbCache.get` treated anything thrown while reading an entry's
  chunks as corruption: one throttle, a partition split or a socket timeout
  dropped the manifest, orphaned its chunks until their TTL, and sent every
  later reader to the origin, which is the load the cache exists to absorb.
  Only a failure the read can prove (chunks that do not match the manifest, a
  checksum that does not hold, a restore the compression codec will not vouch
  for) drops the entry now; anything else propagates, the way a failed
  manifest read always has, and `getOrSet`'s fail-open handles it as the
  infrastructure failure it is.
- **`LambderDdbIdempotencyStore` never compresses an empty body.** Under
  `compression: { minBytes: 0 }`, the documented "compress everything"
  setting the cache and the session store both ship, a 204 or an empty 200
  was stored as compressed bytes declaring a length of zero, which the codec
  refuses on the way back: `peek` and `begin` both threw for the record's
  whole TTL, the engine failed open on each, and every retry executed the
  operation again. An empty body takes the plain path and replays as the
  empty body it was.
- **`begin()` no longer replays a record whose expiry cannot be read, and a
  record with no expiry no longer deadlocks its scope.** DynamoDB evaluates a
  comparison against an attribute it cannot read as false, so a claim
  condition that only asked `expiresAt <= :now` refused such an item for
  ever: a settled one replayed its stored answer with no expiry test of its
  own (where `peek` called the same item expired), and a pending one answered
  409 for ever with no TTL able to retire it. The condition takes an absent
  expiry as free, and `begin` runs the expiry test `peek` runs before handing
  an answer back.
- **`signIn()` works behind the MSW adapter**, the documented browser path.
  Two causes, both fixed: the adapter scoped its cookie jar by the request
  URL's host rather than by the app's `cookieHost`, so an app whose cookie
  host is not the page's held the session at a host it never sent it to; and
  `signIn` was the one cookie writer that skipped the runtime's
  `document.cookie` mirror, so the page had no readable CSRF cookie, the
  browser caller posted an empty token, and every session endpoint answered
  `sessionExpired`. `signOut` is symmetric: it clears the jar's cookies and
  the mirrored ones the way `reset()` does.
- **The mock's four session members name the mock's own option.** `signIn`,
  `signOut`, `expireSessionData` and the `sessionManager` getter threw the
  pipeline's "Configure the session option at creation", which names the
  server's `session`; the mock's is `sessions`.
- **The mock picks the plain crypto stand-in from the store's own
  `isMemoryOnly`**, not from whether the runtime created the store. An app
  passing its own `LambderMemorySessionStore` on a plain-http page got
  `LambderWebCrypto` and threw on its first session call where the default
  path degrades.
- **The MSW adapter builds its header map through `lowercaseHeaderNames`**,
  like every other adapter: a request header named `__proto__` was dropped
  there and landed as an own key on the server, and `headers["toString"]`
  handed a guard an inherited function.

### Documentation

- **The documented starting point turns `requireSessionApiGuards` and
  `requirePublicApiGuards` on.** Both still default to off in the framework,
  and that is deliberate: a named no-op guard satisfies either flag, so the
  default buys a written declaration rather than any authorization, and
  demanding one before a new app's first endpoint compiles is a cost with no
  security behind it. An app is where the declaration pays, though, because
  "which of these endpoints are open, and why?" stops being answerable by
  reading them somewhere past the first handful. So `docs/getting-started.md`
  and `examples/secure-session-example.ts` now declare the two no-op guards
  (`sessionOnly`, and `open` carrying its reason as a parameter) and turn both
  flags on, with the reason each public endpoint is open written at its
  registration. An app that copies either one starts out declaring who may
  call what, and drops both lines if it would rather not.
- **`docs/sessions.md` no longer calls the one planted-cookie case that IS a
  takeover harmless.** A visitor with no session who receives a planted
  session cookie and its matching CSRF cookie is signed into the planting
  account until they sign in themselves: the scan finds one live candidate,
  the posted token is the planted one because there is no other for the
  client to read, the pairing succeeds, and the visitor's own traffic renews
  the session and re-issues it at the app's scope. The server cannot tell it
  apart from a real session. `__Host-` is the defence, not a nicety, and it is
  now in the option table, in the page's first example, in
  `docs/configuration.md`'s cookie rows and in
  `examples/secure-session-example.ts`. The page also states what
  `cookie.domain` costs (the cookie is SENT to every current and future host
  under the domain), that the everywhere-clear reaches no cookie planted at a
  longer `Path` (that variant is refused but not healed), that session APIs
  require the posted CSRF token while session routes do not (a route that
  mutates state checks the token itself, and `sameSite: "None"` leaves such a
  route with nothing), that `isSessionTokenValid` exists for an app verifying
  a token itself, and the `sessionSalt` caveat (the record stores
  `sessionKey` in plaintext beside its own hash, so a dumped table is a
  known-plaintext pair for the salt).
- **`examples/secure-session-example.ts` and
  `examples/zod-chained-api-example.ts` build their instance with
  `initLambder().create({...})`** and chain `addApi` onto it, rather than the
  `new Lambder({...})` form the docs tell readers not to use, and the session
  example no longer teaches a password-change sequence that signs the user
  out (`endSessionAll()` deletes every record under the subject, a
  replacement created before it included). The rendered form posts to a
  session route that validates the CSRF token it rendered.
- **`docs/templating.md` and the engine's docstring state the slot-default
  rule correctly.** Only `undefined`, or a key the data object does not carry,
  keeps a slot's default content; `null`, `false` and `""` are values and
  render the slot empty. Write `value ?? undefined` for the other intent.
- **`docs/responses.md` describes `crash` honestly.** The framework never sets
  it and never withholds it: it reaches whoever the handler that set it
  answered, so a browser that asked receives the stack trace whether or not
  anything on the page displays it. `LambderCaller` not surfacing the field is
  a display choice in one client, not a gate, and `x-lambder-invoke`
  authorizes nothing. The honest gate for an invoke-only function is that it
  has no HTTP trigger and is reachable only through IAM, which is what
  `docs/invoke.md`'s `invokeOnly` example now shows instead of the header
  check. The page also lists `res.versionExpired()`.
- **`docs/api-policies.md`** documents `per: "ip"` policies as a phase of
  their own (checked before the session read, so list order governs which
  counter is charged only among policies of one phase), the custom-key bound,
  and what `callerIdentity` actually sees; `docs/apis.md` shows the same
  request flow (the version gate and the payload restore lead both lists).
- **`docs/invoke.md`** says per-call `headers` are the caller's own assertion
  and names the three headers the event owns, tells the same narrowing story
  `docs/client.md` tells, says `message` is surfaced by the browser caller
  only, points at `LambderCaller.createIdempotencyKey()` for a key, says a
  session rotation arrives on `outcome.cookies` with no `LambderInvokeSession`
  rebuilt, and names `nodejs20.x` as the first runtime that ships the AWS SDK.
- **`docs/client.md`** shows how to narrow `LambderAppRefusalMessage | string`
  (every migrating `errorMessageHandler` hits it), states that an answer's
  `logList` reaches the handler whatever the outcome, matches the jar's new
  precedence, and drops an unverifiable bundle-size figure.
- **`docs/mock.md`** no longer contradicts itself about the entry forms,
  documents `restore()` in place of `using`, `rateLimits.failOpen`, the MSW
  jar's `cookieHost` scoping, the plain-crypto rule, `requestFromTransport`
  and `signOut`'s options, and says under "What the mock cannot do" that
  response finalization is the server's alone.
- **`docs/ddb-cache.md`** documents `maxValueBytes`, `chunkBytes`, `client`
  and `now`, the per-call `ttlSeconds`, `leaseSeconds` and `waitForFillMs`,
  and that a value updated from another container is served stale here until
  its own copy expires; `docs/ddb-rate-limiter.md` states the per-request
  cost of a multi-window policy and the two key bounds;
  `docs/ddb-idempotency.md` says an empty body is never compressed and a
  stored `bodyBytes` past 32MB is refused; `docs/frontend-hosting.md` states
  the path rule a source can rely on.
- **`README.md`** no longer calls `zod` an optional peer (it is a required
  peer; the AWS SDK clients and `msw` are the optional ones), and it and
  `docs/getting-started.md` say Node 20 rather than `nodejs18.x`; the
  getting-started tutorial uses `z.email()` rather than the deprecated
  `z.string().email()`. `docs/api-core.md` writes down the layering rule and
  the naming vocabulary, and `CONTRIBUTING.md` is gone: the contribution notes
  it held are a short section of `README.md` now.

## [6.0.2] - 2026-09-13

No source changes: TypeScript 6, ESLint and the tsconfigs moved forward, and
the tests were adjusted to the stricter checking that came with them.

## [6.0.1] - 2026-09-13

A major because this one does break: five exports were renamed with no alias
kept, and one overload stops compiling code that used to. The migration is
mechanical and the compiler finds every site.

- `restoreBoundedText(bytes, declaredBytes, encoding)` is now
  `restoreText(bytes, encoding, { declaredBytes })`, beside `restoreBytes`
  with the same signature for bytes that are not text.
- `COMPRESSED_PAYLOAD_FIELD` is `COMPRESSED_PAYLOAD_GZ_FIELD`,
  `LambderCompressedPayload` is `LambderCompressedGzipPayload`, and
  `compressPayloadJson` / `decompressPayloadJson` are `compressPayloadGzip` /
  `decompressPayloadGzip`. Each has a new Brotli sibling.
- `DEFAULT_MAX_REQUEST_PAYLOAD_BYTES` is `DEFAULT_MAX_RESTORED_PAYLOAD_BYTES`,
  the same 20,000,000.
- `res.api(null)` no longer compiles on an API whose output schema does not
  allow null. Answer the declared output, or pass the reason beside the null
  (`res.api(null, { errorMessage })`). A handler that returned a bare null on
  a non-nullable output was the bug this catches.

The wire format is unchanged in both directions, so a deployed callee and an
older client still understand each other.

### Added

- **`LambderInvokeCaller`**, a server-side caller that invokes a Lambder app
  running in another Lambda function directly, with no API Gateway in between.
  It synthesizes the payload-format-2.0 event the gateway would have delivered,
  invokes the function with `RequestResponse`, and reads the response object
  Lambder returns, so the callee is an unmodified Lambder app and everything it
  offers over HTTP applies unchanged: zod validation, the inferred contract
  (imported type-only, so `api("sendEmail", payload)` is typed end to end),
  refusals, guards and guard inputs, rate limits, idempotency keys, sessions
  carried on a user's behalf, `logList`, and compression both ways. `api()`
  throws a `LambderInvokeError` on any failure (a failed dependency is a failed
  request) while `apiOutcome()` resolves to a discriminated outcome; `request()`
  reaches any route of the callee; `onFailure` is awaited for every failed call,
  whichever method the site used, so failures are reported in one place.
  `LambderInvokeCaller.localTransport(handler)` runs a callee's real handler
  in-process for tests and `createEvent` builds the event a call would send, for
  boot checks. The callee tells an invoke from a browser by the
  `x-lambder-invoke` marker header, which is for guards and hooks and never an
  authorization: the `lambda:InvokeFunction` grant is that. A hook that throws
  (`onFailure`, `onLogList`) is logged and ignored, so `apiOutcome()` keeps its
  promise never to throw, and the event is serialized exactly once per call
  (the transport receives that JSON as `eventJson`). Documented in
  [docs/invoke.md](./docs/invoke.md), with `LambderInvokeError`,
  `isLambderInvokeError`, the outcome, failure and handler types, the
  transport and event types, and the protocol constants exported from
  `lambder`. Nothing a call is built from may escape as a throw either: a
  guardInputs provider that rejects, or a payload holding a cycle or a BigInt,
  fails as an `unknown` outcome through `onFailure` like any other failure,
  so `apiOutcome()` keeps its promise never to throw and `api()` always
  throws a `LambderInvokeError`. An external `AbortSignal` a call is given is
  detached from when the call ends, so a signal shared across calls does not
  accumulate one listener per call.
- **A `crash` field on the API envelope**, with `describeCrash(err, ctx)` to
  build it and `errorFromCrashDetail(crash)` to rebuild an Error from it. A
  global error handler answering a caller it trusts can now hand back the whole
  failure (name, message, stack, cause chain, the request id and function it
  happened in) instead of hand-rolling a serialization, and the invoke caller
  chains it as the `cause` of the error it throws, so an error reporter that
  walks causes stores the callee's stack without being taught anything.
  `LambderCaller` ignores the field, so a callee that also faces browsers is
  unaffected. Both helpers are dependency-free and exported from `lambder` and
  `lambder/client`.
- **`payloadBr`**, a Brotli request payload beside the browser's gzip
  `payloadGz`. The server accepts either (never both) under the same declared
  byte length, bound and exact-length verification, so a Node caller compresses
  with the better algorithm while browsers keep sending what they can produce.
  `compressPayloadBrotli` builds the pair under the same threshold and
  only-when-smaller rules as `compressPayloadGzip`.
- **`@aws-sdk/client-lambda` as an optional peer dependency**, imported on the
  first invoke the way the S3 client is imported on the first read. The Lambda
  Node runtimes provide it, so a deployed function installs nothing new.

### Changed

- **A null API answer needs a reason.** `res.api` (and `res.apiBinary`,
  `res.die.api`) is overloaded: the declared output, or `null` beside a
  config (a refusal flag, an `errorMessage`, a `message`). A bare
  `res.api(null)` compiles only when the output schema allows null, so a
  success payload is always the declared output and `LambderInvokeCaller.api()`
  promises exactly that type instead of `TOutput | null`. Untyped resolvers
  (routes, hooks, `getResponseBuilder`) accept anything as before; a handler
  that answered a bare null on a non-nullable output is the one thing that
  stops compiling, and it was the bug this catches. `LambderApiAnswer` is the
  exported signature.
- **The DynamoDB SDK is loaded on first use.** `LambderSessionManager`,
  `LambderDdbCache`, `LambderDdbRateLimiter` and `LambderDdbIdempotency` used to
  import `@aws-sdk/client-dynamodb` (and the session manager
  `@aws-sdk/lib-dynamodb`) at module level, so importing `lambder` loaded both
  packages and a bundled app referenced them whether or not it kept sessions
  or used a store. They now import types only and take the classes from one
  loader (`src/stores/LambderDdbSdk.ts`) the first time a table is touched,
  the way `LambderS3FileSource` and `LambderInvokeCaller` load theirs. An app
  without them installed still imports and constructs everything; only the
  first table access fails, with the install hint naming the store. The
  `client` option of the stores is honoured as before.
- **`restoreBytes(bytes, encoding, bound)` and `restoreText(...)` replace
  `restoreBoundedText`**, with no alias kept: one restore that takes either
  `{ declaredBytes }` (the bytes' original length, bounding and verifying the
  result, what records at rest and request payloads use) or `{ maxBytes }` (a
  ceiling alone, for bytes whose sender recorded no length, what a compressed
  HTTP answer read by the invoke caller uses). A nonsense ceiling throws a
  plain Error, since that is the caller's configuration, not a restore
  failure. `restoreBytes` hands back the buffer and `restoreText` is that plus
  the UTF-8 decode, because the one restore without a declared length is also
  the one whose bytes may not be text: a route may answer a compressed wasm
  module or an image it forced compression on, and decoding those as UTF-8
  would replace every byte that is not a valid sequence and hand back a body
  that is silently not what was sent.
- **`DEFAULT_MAX_RESTORED_PAYLOAD_BYTES` replaces `DEFAULT_MAX_REQUEST_PAYLOAD_BYTES`**:
  the same 20,000,000, which now also defaults the invoke caller's
  `maxResponsePayloadBytes`, so the name says what it bounds (any restored
  payload) rather than one direction.
- **The `zodError` of a validation outcome is typed as `LambderValidationError`**
  (`{ name, message, issues }`), the shape that actually crosses the wire,
  instead of `z.ZodError`, which advertised methods a caller could not call.
  `LambderCaller`'s `apiInputValidationErrorHandler` receives the same type.
  Exported from `lambder` and `lambder/client`.
- **The envelope to outcome mapping moved out of `LambderCaller`** into
  `src/shared/LambderApiOutcome.ts`, and the contract-driven call option types
  (`LambderCallOptionsArg`, the guard-input types) into
  `src/shared/LambderCallOptions.ts`. Both callers now read one implementation,
  so which status is a crash, in what order the envelope flags are honoured and
  what an API demands of its caller cannot drift between them. No behavior
  change for `LambderCaller` except one: a 5xx answer now keeps the parsed
  envelope on the outcome's `response` when the server sent one, where it
  previously kept `errorMessage` alone and dropped the rest, which is what makes
  `crash` and `logList` readable on exactly the answers that carry them.

- **Renamed the gzip request-compression names to match their new Brotli
  siblings**, with no aliases kept: `COMPRESSED_PAYLOAD_FIELD` is now
  `COMPRESSED_PAYLOAD_GZ_FIELD` (beside `COMPRESSED_PAYLOAD_BR_FIELD`),
  `LambderCompressedPayload` is `LambderCompressedGzipPayload` (beside
  `LambderCompressedBrotliPayload`), and `compressPayloadJson` and
  `decompressPayloadJson` are `compressPayloadGzip` and
  `decompressPayloadGzip` (beside `compressPayloadBrotli`). The wire field
  itself (`payloadGz`) is unchanged.

### Fixed

- The 422 validation body carries the zod issues again. zod 4 keeps
  `ZodError.issues` as a non-enumerable property, so serializing the error
  as-is left the issues only inside its message string, and a client's
  `apiInputValidationErrorHandler` received a `ZodError` with nothing to
  branch on. The refusal now spells the body out as `{ name, message, issues }`.

## [5.1.3] - 2026-09-12

### Changed

- Bumped the `zod` dependency and peer range from `^4.1.12` to `^4.6.2`, matching
  the version already resolved everywhere else in a typical install.
- Replaced the deprecated `z.ZodTypeAny` with `z.ZodType` across `Lambder.ts`,
  `LambderApiGuards.ts` and `LambderApiRateLimits.ts`. Purely a type-level
  change; runtime behavior is unchanged.

## [5.1.1] - 2026-09-11

### Added

- **`LambderHttpFileSource`**, a file source that reads over HTTP(S) from any
  origin serving files by path: a CDN, a public bucket's own domain (a
  Cloudflare R2 custom domain, an S3 website endpoint) or another server.
  `files: new LambderHttpFileSource({ baseUrl: "https://assets.example.com/v42/" })`
  serves public files, index.html and templates from there through the same
  reader, memory cache and template cache as every other source. It reads with
  the runtime's `fetch`, so it needs no SDK and, for a public origin, no
  credentials, and its reads come out of the origin's edge cache rather than
  the bucket. A 404 or 410 reads as null and the request falls through; any
  other failed status, a network error or a timeout (`timeoutMs`, default 10
  seconds) is an error. Path segments are percent-encoded, so a relative path
  names the same object it would as an S3 key, and `headers` go with every
  read for an origin that wants an Authorization header or a known
  User-Agent.

## [5.0.0] - 2026-09-10

The v4 line is closed and its accumulated surface is released as v5. **There
are no breaking API changes**: code written against 4.9.1 compiles and runs
unchanged. The major marks the documentation and packaging milestone rather
than a migration.

### Added

- **A documentation set**, replacing the single 78KB readme. Eighteen guides
  under [docs/](./docs/README.md), organized by task: getting started,
  configuration, routing and actions, APIs and refusals, responses, sessions,
  API policies, the frontend client, frontend hosting, templating,
  translations, testing, the four DynamoDB tables, the three standalone
  stores, and a full exports reference. The readme is now an overview that
  links into them.
- **This changelog.** Release notes used to accumulate as "New in 4.x" blocks
  at the top of the readme; they now live here, back to 3.0.0, with the 3.4
  through 3.8 entries reconstructed from the source history rather than left
  as a pointer at the git log.
- **`docs/exports.md`**, a reference for all 154 exported names across the
  three entry points, grouped by purpose. Every export is now documented.
- **Guides for `LambderDdbRateLimiter` and `LambderDdbIdempotency`**, which
  shipped as standalone modules but had no documentation of their own.
- **`CONTRIBUTING.md`**: setup, the test and lint commands, the conventions a
  change is expected to follow, and the source layout.
- **Package metadata**: `description`, `author`, `keywords`, `homepage`,
  `bugs` and `engines` were empty or absent, so the npm page showed nothing
  about the package.

### Changed

- **Standard file names**: `Readme.md` is `README.md` and `License.md` is
  `LICENSE`; the `docs/` pages moved from `SCREAMING_SNAKE.md` to kebab-case.
- **The quick start was rewritten.** It had gone stale at v2.0: it taught
  `new Lambder({...})` instead of `initLambder().create({...})` and imported
  `LambderCaller` from `lambder` rather than `lambder/client`.
- **`eslint` runs again.** The config extended `standard-with-typescript`,
  which was never installed, so `npm run lint` failed to start. It now uses
  the `@typescript-eslint` packages the repo already carries, with the
  generics-heavy rules (`no-explicit-any`, `{}` as a generic default, unused
  handler arguments) relaxed deliberately and the rest of
  `eslint:recommended` on. The tree lints clean.

### Fixed

- `res.file` was documented as taking a `fallback` option, which 4.5.1
  removed.
- A handful of dead imports in the test suite, and three type-level
  assertions that now carry the codebase's `_` prefix for declarations that
  exist to be typechecked rather than used.

## [4.9.1] - 2026-09-10

### Added

- **Mandatory authorization on public APIs.** `requirePublicApiGuards: true` at
  creation makes `guards` a required field of every `addApi`, the same way
  `requireSessionApiGuards` does for session APIs, at the type level and at
  registration. Public APIs are open by default and that stays the default;
  what turning it on buys is that a public endpoint's openness becomes a
  written decision rather than an omission. The ones anybody may call declare a
  named no-op guard carrying the reason
  (`guards: { open: "Static strings already in the bundle." }`), the ones that
  authorize their caller some other way (a signature, a device secret, a
  one-shot token) name where that happens, and one grep over the guard names
  then lists every public door and why it is open. The two flags are
  independent, so an app can require either or both.

### Fixed

- **An empty `guards` option is refused.** `guards: {}` and `guards: []` were
  inhabited by the option type and passed the `require*ApiGuards` field check
  while normalizing to zero entries, so a declaration that authorized nothing
  satisfied a requirement that exists to make authorization explicit. Both are
  now compile errors (every form of the option is non-empty by construction)
  and a registration error for a plain-JS caller, whichever flag is on or off.
  Requiring the chosen key also rejects `guards: { theGuard: undefined }`,
  which an optional property accepted and which reached the guard's handler
  with an undefined param.

## [4.8.1] - 2026-09-08

### Added

- **Grouped cache keys.** `LambderDdbCache` keys may be a `{ pk, sk }` pair
  instead of a string, which stores related entries in one partition:
  `{ pk: "store:nyc-01", sk: "1700:1800" }` keeps every cached window of one
  store together. `deletePartition(pk)` then drops the whole group without
  knowing which sort keys exist, and `listSortKeys(pk, { prefix, limit })`
  reads back what is currently cached under it. The group invalidation a cache
  of derived, per-entity values needs, in place of remembering every key ever
  written or waiting out the TTL. Reads stay one request, and the memory layer,
  single-flight and fill lease stay per entry. Only the `pk` part is hashed, so
  the sort key is queryable; a caller's `#` is escaped rather than refused
  (`~` to `~0`, `#` to `~1`). Plain string keys keep their exact item layout,
  so a live table needs no migration and both forms can share a partition.
- **`guards` on the API contract.** Each contract entry now carries the `guards`
  option exactly as declared (`ApiContractType["getUser"]["guards"]` is the
  literal `{ readonly orgPermission: "USERS.MANAGE" }`), so a client-side map
  of what an API needs can be pinned to the server's own declaration with
  `satisfies` instead of a test that reads the server source.

## [4.7.3] - 2026-09-08

### Fixed

- `use()` listed one generic short of the class's parameter list, so the
  missing one fell back to its default and an instance carrying a non-default
  value became unassignable to its own plugins (`requireSessionApiGuards` did
  exactly that in 4.7.1).

## [4.7.1] - 2026-09-08

### Added

- **Compressed request payloads.** `requestCompression` on `LambderCaller`
  gzips the payload of any call whose JSON reaches a threshold (`true` is
  `{ minBytes: 4096 }`), sending it as `payloadGz` beside its byte length
  instead of `payload` whenever that is actually smaller; the server restores
  it before rate-limit key slices, guards and input validation, so no call
  site, handler or schema changes. Chiefly a way to fit a large payload under
  Lambda's ~6MB invoke cap, which applies to the compressed bytes. The envelope
  stays `application/json` with its routing fields in plain text, so gateways,
  CDNs and mocks are unaffected. `maxRequestPayloadBytes` (default 20MB) bounds
  what a body may expand to.
- **Mandatory authorization on session APIs.** `requireSessionApiGuards: true`
  at creation makes `guards` a required field of every `addSessionApi`, at the
  type level (a missing declaration is a compile error at the registration
  site) and at registration (a plain-JS caller throws). An API the session
  alone authorizes declares a named no-op session guard, so every opt-out is
  explicit and one grep lists them all. The class of defect this closes is
  "the guard existed and the endpoint did not use it", which review discipline
  does not catch as a surface grows.
- **Brotli responses.** Response compression now negotiates `br` before `gzip`,
  smaller at comparable speed (15-25% on markup and prose, substantially more
  on the repetitive record lists API responses tend to be), which is bandwidth
  saved and headroom gained against the ~6MB response cap.
  `compression: { encodings: ["gzip"] }` opts out, `quality` (default 5) tunes
  it.

### Changed

- **One compression codec.** `shared/LambderCompressionCodec.ts` is now the only
  place Lambder compresses or decompresses bytes. Its
  `restoreBoundedText(bytes, declaredBytes, encoding)` carries the guarantee
  every compressed value in Lambder depends on, at rest and on the wire: the
  declared UTF-8 byte length bounds the decompression AND must match the result
  exactly, so a truncated, tampered or endlessly-expanding input fails instead
  of decoding to something merely plausible. Compression is split across three
  modules by what each one needs: the codec (zlib), the option and its resolver
  (pure, so the browser entry can resolve the caller's option), and the request
  payload format (the browser's `CompressionStream`).
- **One compression option, now everywhere.** The HTTP response option and the
  new request option resolve through the same `resolveCompressionOption` the
  DynamoDB stores and sessions use, and every site's option is the one generic
  `LambderCompressionOption<Settings>`. Same vocabulary at every site (`true`
  for that site's defaults, `false` for off, an object to override, `minBytes`
  as the threshold, `quality` as the Brotli quality, `encodings` as the
  negotiation order), same `Settings | null` resolved shape, and the same
  startup validation: `compression: { quality: 99 }` or `{ encodings: [] }` on
  a response is now a construction error instead of being silently ignored, and
  a field set to `undefined` keeps its default.

### Removed

- `stores/LambderDdbCompression.ts`, retired into the modules above.

## [4.6.2] - 2026-09-07

### Changed

- **`zod` and the AWS SDK clients are optional peer dependencies** rather than
  dependencies, so installing lambder never drags them into a tree that has no
  use for them: a frontend importing only `lambder/client` skips the ~21MB SDK
  entirely, and a Lambda deployment package does not ship a second copy of what
  the runtime already provides. Install whatever the code you actually import
  needs; see the peer dependency table in the README.

## [4.6.1] - 2026-09-07

### Added

- **Cookies as a first-class concern.** `res.setCookie(name, value, options)`
  and `res.clearCookie(name, options)` serialize Set-Cookie headers through the
  `cookie` package (defaults Path=/, SameSite=Lax, Secure; a function-form
  `domain` resolves against the request hostname, the same option the session
  takes), replacing hand-built header strings; `serializeCookie` and
  `serializeClearCookie` are exported for code holding a response.
  `ctx.cookieList` keeps every value a cookie name arrived with beside the
  first-wins `ctx.cookie`.

### Fixed

- **Session cookie scope changes heal.** A cookie's identity is
  (name, domain, path), so changing the session's `cookie.domain` or `path` on
  a live deployment leaves the old copy in every browser beside the new one,
  and a whole-header parse silently picks whichever the browser lists first.
  The controller now tries every copy of the session cookie (record and CSRF
  pairing checked per copy), logs the ambiguity, and evicts the stale host-only
  twin from the response, so a migrated browser recovers on its first request
  instead of answering `sessionExpired` until the old cookie expires.

## [4.5.1] - 2026-09-07

### Added

- **`files` at creation.** One `LambderFileSource` configured once:
  `files: new LambderLocalFileSource({ root: path.resolve("./public") })` for
  the folder bundled with the deployment, `new LambderS3FileSource({...})` for
  S3 or R2, or your own `{ read(relativePath) }`. The instance owns one reader
  over it (`lambder.files`): path rule, in-memory file cache and
  compiled-template cache in one place, shared by `servePublicFiles`,
  `serveIndexHtml`, `res.file` and `res.templateFile`, so a build hosted from a
  bucket serves its index.html and templates from the bucket too, cached the
  same way as its assets. The cache is tuned or disabled beside the source,
  `files: { source, memoryCache }`.

### Removed

- `publicPath` at creation and `servePublicFiles({ source })`, both replaced by
  `files`; `memoryCache` leaves `servePublicFiles` for the same reason.
- `res.file`'s SPA-era `fallback` option, which the fallback chain replaced.

## [4.4.1] - 2026-09-07

### Added

- **`guardInputsProvider`** on `LambderCaller`: supply guardInput-mode guard
  values for every call from one place (the organization the UI is on, a device
  token) instead of at each call site; per-call `guardInputs` merge on top.
  Name the covered guards in the caller's second type parameter,
  `new LambderCaller<Contract, "orgPermission">({ guardInputsProvider, ... })`:
  calls to APIs whose guardInput guards are all covered no longer require the
  options argument, uncovered ones (a Turnstile token) still do, and naming
  guards makes the provider itself mandatory.
- **Public file sources.** `servePublicFiles({ source })` serves from any
  `LambderPublicFileSource`: `LambderLocalFileSource` (a folder; the default),
  `LambderS3FileSource` (S3, or Cloudflare R2 and other S3-compatible stores
  via `clientConfig.endpoint`; `@aws-sdk/client-s3` is an optional peer
  dependency loaded on first read), or your own `{ read(relativePath) }`. The
  handler's traversal check, memory cache, mime fallback from the extension,
  Cache-Control, ETag and compression apply to every source. The `cacheControl`
  callback receives the relative file path.
- **`expireSessionDataAllByKey(sessionKey)`** on the session manager and
  controller: marks the data of every session of a subject stale, so each
  renews via `dataRefresh` on its next read. The way to apply a role or
  permission change to a user immediately, without logging them out
  (`deleteSessionAllByKey`) and without waiting for the data TTL.

## [4.3.2] - 2026-09-07

### Changed

- **One compression option everywhere.** `LambderDdbCache`,
  `LambderDdbIdempotency` and sessions take the same `compression` option
  (`true` for that store's defaults, `false` for off, `{ minBytes, quality }`
  to override), resolved by one shared function, and each store records a
  value's encoding so the option can be switched on or off on a live table.
  Defaults keep the previous behavior: the cache compresses everything, the
  idempotency store from 1KB. HTTP `compression` accepts `true` as
  `{ minBytes: 860 }`.

### Removed

- `compressionQuality` on the cache and idempotency store, replaced by
  `compression: { quality }`.

## [4.3.1] - 2026-09-07

### Added

- **Compressed sessions.** `session.data` is stored Brotli-compressed by
  default, as `dataBr` + `dataBytes` on the record, the same scheme
  `LambderDdbCache` and `LambderDdbIdempotency` use (one shared
  implementation). A session that caches roles, permissions or product lists
  shrinks 2-3x and stays within one DynamoDB read unit for longer.
  `session.compression` is `true` by default (the same as `{ minBytes: 0 }`:
  every record compressed); `false` turns it off and `{ minBytes }` compresses
  only from that JSON size. Records written under either setting read back, so
  it can be switched on or off on a live table.

## [4.2.3] - 2026-09-06

### Added

- **One refusal shape, with codes.** `LambderRefusalMessage` gained an optional
  machine-readable `code` (`refuse(content, { code })`), so clients branch and
  translate on an identifier instead of string-matching prose. Every refusal
  the framework itself authors (rate limit 429, idempotency 409 and 400,
  unknown API) is a `LambderRefusalMessage` stamped with a
  `LAMBDER_REFUSAL_CODES` constant under the reserved `lambder/` prefix; a
  rate-limit policy's own `errorMessage` (typed as a refusal message) inherits
  `lambder/rate-limited` unless it sets a code.

## [4.2.1] - 2026-09-06

### Added

- **Rate-limit budgets.** A policy's `budget` is `"perApi"` (default: each
  referencing API gets its own counter, so the numbers are a per-API ceiling
  and three APIs on a 60/min policy allow one IP 180/min in total) or
  `"perPolicy"` (one counter shared by every API referencing the policy). The
  policy is the group, and two separate shared budgets are two policies.
- **Per-API tuning.** The `rateLimit` option gained a map form like guards,
  `rateLimit: { lookupPerIp: { perMin: 20 } }`, which merges window overrides
  over a perApi policy's own (a tighter burst keeps the policy's daily cap).
  Overriding the windows of a perPolicy policy is a startup error;
  `errorMessage` is overridable on either.
- **Retry-After.** A 429 carries the exceeded window's reset as a `Retry-After`
  header (CORS exposes it by default via the new `exposeHeaders` option),
  `LambderCaller` failure outcomes surface it as `retryAfterSeconds`,
  `LambderDdbRateLimiter.isRateLimited()` answers
  `false | { window, limit, resetAt }`, and `LambderApiError` and `refuse()`
  accept `headers`.

### Changed

- **One validation path.** Preflight slices (guard `apiInput` and `guardInput`,
  rate-limit `apiInput` keys) answer through
  `setApiInputValidationErrorHandler` exactly like the API's own schema.

## [4.1.1] - 2026-09-06

### Changed

- **Configuration at creation.** `initLambder<SessionData>().create({...})`
  takes the WHOLE configuration (serving options, session, cors, rate limits,
  guards, idempotency) in one declaration, so nothing can be half-configured or
  wired in the wrong order, and api modules annotate with `typeof lambderApp`
  derived from the real instance.

### Removed

- The enable/define chain methods `enableApiRateLimits`,
  `enableApiIdempotency` and `defineApiGuards`, in favor of the `rateLimits`,
  `idempotency` and `guards` options of `create()`.

## [4.0.1] - 2026-09-06

### Added

- **Declarative auth as guards.** Guards take per-API params
  (`guards: { orgPermission: "SOME.PERMISSION" }`), can require a session
  (`session: true`, compile-checked), and RETURN typed values that land on the
  handler's `ctx.guardData[name]`. Together with the apiInput/guardInput input
  modes, permission checks and device auth become registration-time
  declarations instead of per-handler boilerplate.
- **Three package entry points.** `lambder` (server), `lambder/client`
  (browser-safe by construction: no AWS SDK, no Node built-ins),
  `lambder/testing` (`LambderMSW`); sources organized into core, policies,
  session, stores, client and shared.
- **`LambderCaller.createIdempotencyKeyScope()`** for one self-rotating key per
  logical operation.

### Changed

- **Hardened policy layer.** Rate-limit policies can share one counter across
  APIs (now `budget: "perPolicy"`); idempotency replays answer before rate
  limits, survive client IP changes (key-scoped for public APIs, 16-char
  minimum keys), store full response headers, refuse to store Set-Cookie
  responses, and Brotli-compress stored bodies of 1KB+ so the ~350KB replay
  budget applies to compressed bytes.
- **Secrets hashed at rest.** Session records store only sha256 hashes of the
  bearer secrets, so a session-table read yields no usable cookies;
  `LambderSessionReadError` keeps a DynamoDB blip from reading as a logout.
- Fail-open rate limiting logs its passes.
- `LambderDdbIdempotency.complete()` answers `"stored" | "too-large" | "lost"`.
- Idempotency keys must be 16-200 characters.

### Removed

- `LambderCaller.apiRaw()`; use `apiOutcome()`, whose failure outcomes carry
  the envelope on `response`.
- The `multiValueHeaders` alias on `res.raw()`; use `headers`.

### Breaking

Upgrading from 3.x:

- Configuration moved entirely to creation, removing `enableCors`,
  `enableDdbSession`, `setSessionCookieKey`, `enableApiRateLimits`,
  `enableApiIdempotency` and `defineApiGuards` in favor of the `cors`,
  `session`, `rateLimits`, `guards` and `idempotency` options of
  `initLambder().create({...})`. (The chain methods were removed in 4.1.1.)
- Session records are reshaped (hashes at rest); live sessions invalidate once
  on upgrade and clients just re-login.
- The manager-level `createSession` and `regenerateSession` return
  `LambderCreatedSession` (`{ session, sessionToken, csrfToken }`); the
  controller API is unchanged.
- `LambderMSW` moved from the root entry to `lambder/testing`.
- `LambderCaller.apiRaw()`, the `multiValueHeaders` alias, and the old
  idempotency `complete()` return shape are gone (see Removed and Changed).

## [3.8.1] - 2026-09-06

### Added

- Guards and custom rate-limit keys gained two typed input modes: **apiInput**
  (checks a slice of the API's own payload, declarable only where the schema
  carries those fields) and **guardInput** (a separate client-sent
  `guardInputs` channel the contract makes mandatory at the call site).

## [3.7.1] - 2026-09-06

### Added

- Guards and custom rate-limit keys became payload-sliced
  (`{ input, handler }`): the slice is validated before the handler runs, typed
  in the handler, and force-merged into the contract input.

## [3.6.1] - 2026-09-06

### Added

- **`refuse()`** and the standard `LambderRefusalMessage` shape: a one-liner
  callable from anywhere in an API call's stack, with never-return narrowing,
  over `LambderApiError`.

## [3.5.2] - 2026-09-06

### Added

- **Typed API refusals** with `LambderApiError`, so a refusal never pollutes
  crash logging and clients get a parseable response.
- **Caller outcomes and timeouts**: `apiOutcome()` resolves to a discriminated
  union instead of collapsing every failure to `null`, and `timeoutMs` aborts a
  call in the constructor or per call.
- **Declarative per-API policies**: rate limits, guards and idempotency,
  including `LambderDdbIdempotency`.

## [3.4.2] - 2026-09-06

### Added

- **`dataRefresh`** on the session: session data derived from external state
  (roles, permissions, feature flags) gets a shelf life, renewed in place on
  the same record past its `ttlSeconds` by an app callback, so changes reach
  every live session without a mass invalidation. Returning `null` ends the
  session; a thrown error surfaces as `LambderSessionDataRefreshError` and
  leaves the session untouched.

## [3.3.3] - 2026-08-26

### Added

- **`LambderDdbRateLimiter`**, a standalone DynamoDB fixed-window rate limiter.

## [3.3.1] - 2026-08-26

### Added

- Session cookie `Domain` may be resolved per request host, for one deployment
  serving several apex domains.

## [3.3.0] - 2026-08-16

### Changed

- **`serveIndexHtml` stopped guessing whether a path is a file.**
  `servePublicFiles` has already served every real file by then, so anything
  reaching this slot is an app route, dotted ones included. `skipFilePaths: true`
  opts back into 404ing paths whose last segment contains a dot.

## [3.2.6] - 2026-08-03

### Fixed

- Payload v2: the named stage prefix is stripped from `rawPath`, for parity
  with the v1 path.

## [3.2.5] - 2026-08-03

### Fixed

- Payload v2 hardening: format-aware error-path responses.

## [3.2.1] - 2026-08-03

### Added

- **`createLambderI18n`**: typed translations with enforced and optional
  languages, component-level extension, runtime dictionaries, and automatic
  language detection. Isomorphic and dependency-free.

## [3.1.0] - 2026-08-02

### Added

- **`LambderDdbCache`**, a standalone Brotli-compressed DynamoDB cache with an
  in-memory LRU layer, single-flight deduplication and a fill lease.

## [3.0.0] - 2026-08-02

### Added

- Public file serving with `servePublicFiles()` and `serveIndexHtml()`.
- Unified `addAction()` for non-HTTP triggers (EventBridge, SQS, custom
  events), dispatched by the same handler.
- Automatic gzip and ETag on the response pipeline.
- Thrown responses with a real `die`.
- The comment-based `LambderTemplatingEngine` and type-safe `html`/`xml`
  tagged templates.
- API Gateway HTTP API (payload v2) and Lambda Function URL support, detected
  per event.
- Typed AWS contracts and session hardening.

## Earlier versions

2.x and earlier are documented in the git history.

