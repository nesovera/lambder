# Sessions

Sessions are configured once at creation over a store of your choosing. They
are required for `addSessionApi` and `addSessionRoute`, and give `ctx.session`
its type.

```typescript
import { initLambder, LambderDdbSessionStore } from "lambder";

const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    session: {
        store: new LambderDdbSessionStore({ tableName: "website-session", region: "us-east-1" }),
        sessionSalt: process.env.SESSION_SALT!,
        enableSlidingExpiration: true,   // extend the session on each access
        // Cookie names default to LMDRSESSIONTKID / LMDRSESSIONCSTK. The
        // __Host- prefix is what stops any other host writing them.
        tokenCookieKey: "__Host-LMDRSESSIONTKID",
        csrfCookieKey: "__Host-LMDRSESSIONCSTK",
    },
});
```

| Option | Default | Description |
| --- | --- | --- |
| `store` | required | Where sessions rest: `LambderDdbSessionStore`, `LambderMemorySessionStore`, or your own `LambderSessionStore` |
| `sessionSalt` | required | Salts the sessionKey hash that partitions the store. Treat as a secret |
| `enableSlidingExpiration` | `true` | Extend the session on each access |
| `slidingWriteIntervalSeconds` | `max(60, 5% of TTL)` | Minimum gap between sliding writes |
| `cookie` | none | Cookie scope: `domain`, `path`, `sameSite`, `secure` (below) |
| `tokenCookieKey`, `csrfCookieKey` | `LMDRSESSIONTKID`, `LMDRSESSIONCSTK` | Cookie names. Prefix both with `__Host-` unless you need cross-subdomain sessions: it is the only thing that stops a sibling host planting a session cookie, and it is one line ([below](#more-than-one-session-cookie-on-one-request)) |
| `dataRefresh` | none | Opt-in freshness for `session.data` (below) |
| `crypto` | WebCrypto | Hashing and randomness for the tokens; `LambderPlainSessionCrypto` where a runtime has no `crypto.subtle` and the store holds nothing worth hashing |

## Stores

The session model (token format, hashing, expiry, sliding writes,
`dataRefresh`, regeneration) lives in `LambderSessionManager`; a store owns
nothing but five operations keyed by two hashes, plus one declaration about
itself, so the same model runs on
Lambda over DynamoDB, in a test over a `Map`, and in a browser under the
[mock runtime](./mock.md).

```typescript
interface LambderSessionStore<SessionData = unknown> {
    /** Whether records die with the process. Gates non-cryptographic hashing. */
    readonly isMemoryOnly: boolean;

    get(sessionKeyHash, secretHash): Promise<LambderSessionRecord<SessionData> | null>;
    put(record: LambderSessionRecord<SessionData>): Promise<void>;
    delete(sessionKeyHash, secretHash): Promise<void>;
    listSecretHashes(sessionKeyHash): Promise<string[]>;
    markDataExpired(sessionKeyHash, secretHash, at): Promise<void>;
}
```

The interface and both shipped stores are generic over the session data, so
`LambderMemorySessionStore<SessionData>` (or your own store) types the records
the manager reads rather than laundering them through `any`. The `session`
option itself stays typed over `any` on purpose: the session data type is the
app's declaration through `initLambder<SessionData>()`, and naming it on the
store would make the app infer its session type from its table instead.

`isMemoryOnly` is how the manager refuses a dangerous pairing it could not
otherwise see: `LambderPlainSessionCrypto` neither hashes nor draws random
bytes, so in front of a store that outlives the process every record would be
a usable credential and the `sessionSalt` would be readable straight out of
the partition key. Creating that pair throws.

`get` must be strongly consistent. A logout deletes the record, and a read
served from a stale replica would hand the session back.

A store MAY hand back a record that is past its `expiresAt`. A DynamoDB TTL
deletes within days rather than at the second, and a store over a plain table
sweeps nothing at all, so expiry is the manager's to enforce and it does, on
every read. A store that drops expired records itself is doing housekeeping,
not policy.

### More than one session cookie on one request

A browser can send several cookies under one name, at different scopes, and
the order says nothing about which is current. That is ordinary during a
`domain` or `path` migration: one copy is live and the rest are stale, so the
live one wins and the stale host-only twin is evicted.

**Reading a candidate costs nothing it does not have to.** Every value under
the session cookie name is first checked against the shape a minted token has:
two hex halves (either case) joined by a colon, neither longer than 1024
characters. A minted token is 64 and 64, so the ceiling leaves a custom
`LambderSessionCrypto`, or `LambderPlainSessionCrypto` over a long session
key, room to mint longer halves while keeping any candidate well under
DynamoDB's 2048-byte key limit. Without that check a planted
4000-character cookie reached the store as a key it cannot take, the read
threw, and the visitor's own live session answered 500 on every request rather
than signing them in. A candidate that fails the check is no session, decided
before anything is read. More candidates than the reader will weigh (four) is
refused outright, without a single read.

Two copies that BOTH validate is not ordinary. Any sibling subdomain can write
a cookie at a parent domain, and it arrives beside the real one with its own
CSRF cookie, so the pairing check does not catch it. There is no way to tell
which copy the visitor meant, so neither is used: the call reports no session,
the reason is logged, and the cookies are cleared at every scope this host can
write, which is the host-only scope, the configured one, and every parent
domain of the request host. Clearing only the configured scope would be worse
than picking one, because a deletion matches only a cookie carrying the same
`Domain`: it would evict the visitor's own copy and leave the planted one as
the sole survivor.

The visitor signs in again.

**The CSRF cookie is plantable the same way, and it is counted too.** The
browser client reads its CSRF token with `Cookies.get`, which returns the FIRST
copy in `document.cookie`, and a browser orders a longer `Path` first. So a
sibling host that plants one CSRF cookie at a parent domain with a deeper path
decides which token every call posts, while the session cookie still resolves:
the pairing then fails on every request, for ever. The ordinary "no session"
answer does not heal that, because it emits no `Set-Cookie` at all and the
client can only clear the scopes it knows.

So when the session cookie resolves to a live session and the posted CSRF token
does not pair with it, the CSRF cookies that arrived decide the answer:

- More than one under the name, or a posted token matching none of them: the
  same refusal, with the same everywhere-clear.
- Exactly one, and it is the token that was posted: an ordinary "no session".
  Nothing here says another host is writing cookies, and the visitor's own
  client can clear a stale cookie at its own scope.
- None at all: an ordinary "no session". That is the invoke caller's shape,
  which carries the CSRF value in the envelope and sends no cookie for it.

A planted CSRF cookie beside the real one while the posted token DOES pair is
resolved, not refused. The client picked the real token, so the planted copy
sorts after it and is inert, and refusing on the count alone would sign out a
visitor whose state works.

**What that refusal heals, and what it does not.** The everywhere-clear heals
the copy planted at `Path=/` under a domain this host can name, on the first
refused request. It does NOT heal the variant this count exists for, a cookie
planted at a longer path, because that is how the planting host makes its copy
sort first and no deletion the app can emit reaches it (`Path`, below). The
refusal still keeps the wrong session from being used, but the pairing goes on
failing until the visitor clears that cookie in their own browser.

**The visitor with no session is the case none of this can help with, and it
is the worst one.** Everything above defends a visitor who already has a
session. Consider the visitor who has none. A sibling host plants its OWN live
session cookie together with its matching CSRF cookie at a parent domain. The
scan finds exactly one live candidate, so nothing is ambiguous and nothing is
refused; the client reads the planted CSRF cookie because there is no other one
to read, so the token it posts is the one that pairs; and the visitor is now
signed in to the planting account, and stays there until they sign in
themselves. That is session fixation, and what it costs is the visitor's own
work: whatever they write, upload, or pay for lands in an account the attacker
reads at leisure.

**The server cannot detect it.** A planted session that resolves looks exactly
like the visitor's own, because it IS a real session of this app; nothing in
the request says which host wrote the cookie. Worse, the visitor's traffic
keeps it alive: the session is renewed on every request, and the sliding
re-issue writes the planted token back at the app's own scope with a fresh
`Expires`, so the fixation outlives the attacker's own cookie and survives the
visitor clearing the parent-domain copy.

Nothing above reaches this. The count, the refusal and the everywhere-clear are
cleanup for a visitor who already has a session, while this is the case where a
planted cookie is USED, so `__Host-` is not a nicety on this page: a cookie no
other host can write is the only thing that rules it out.

**One scope the clearing cannot reach is `Path`.** A deletion matches only a
cookie carrying the same `Path`, and the session controller knows the request's
host but not its path, so a copy planted at a deeper path (`Path=/api`, say) is
sent on every call and matched by no deletion the app can emit. Clearing every
`Domain` handles the case that actually occurs, since a sibling subdomain
writes at a parent domain rather than at a path, but it is not the whole space.

So to rule the situation out entirely rather than clean up after it, name the
cookies with the `__Host-` prefix through `session.tokenCookieKey` and
`session.csrfCookieKey`, and leave `session.cookie.domain` unset. A browser
refuses a `__Host-` cookie that carries a `Domain`, and requires `Path=/`, so
no other host can write one and there is no deeper path for one to hide at.
That is what makes the prefix the complete answer where the clearing is a
mitigation. The defaults it needs are already the defaults (`Secure` on, `Path`
at `/`), so the prefix is the whole change. What it costs is cross-subdomain
sessions, and [Cookie scope](#cookie-scope) is what that option really buys and
really costs.

```typescript
session: {
    store, sessionSalt,
    tokenCookieKey: "__Host-LMDRSESSIONTKID",
    csrfCookieKey: "__Host-LMDRSESSIONCSTK",
}
```

Both prefixes are checked at creation, because both fail silently in the
browser: a `__Host-` name beside a `domain`, a `path` other than `/`, or
`secure: false`, and a `__Secure-` name beside `secure: false`, are refused
with the reason rather than left to a browser that discards the cookie and an
app that looks like it has no sessions.

### `LambderDdbSessionStore`

```typescript
new LambderDdbSessionStore({
    tableName: "website-session",
    region: "us-east-1",             // optional: the SDK's default chain otherwise
    partitionKey: "pk", sortKey: "sk",   // the table's key attribute names (defaults)
    compression: true,               // Brotli-compress session.data at rest (default)
    client,                          // optional: a ready DynamoDBDocumentClient
});
```

The table shape, TTL setting and IAM policy are in
[DynamoDB tables](./dynamodb-tables.md). The SDK is loaded on the first table
access, so an app that keeps no sessions never loads it.

`session.data` is stored Brotli-compressed by default: the item carries the
data's JSON as Brotli bytes in `dataBr` beside its byte length in `dataBytes`,
in place of a plain `data` attribute. It is the scheme `LambderDdbCache` and
`LambderDdbIdempotencyStore` already use, from the one shared codec that also
restores compressed request payloads, and the byte length both bounds the
decompression and verifies it, so a truncated record fails to decode rather
than decoding to something else. Session data that caches roles, permissions
or product lists typically shrinks 2-3x, which keeps a growing session within
one DynamoDB read unit and one write unit for longer.

`compression: true` (the default) compresses every record, the same as
`{ minBytes: 0 }`; `{ minBytes: 1024 }` compresses only records whose JSON is
1KB or more; `false` stores data as a plain attribute; `quality` (Brotli
0-11, default 5) is also accepted. Reads accept both item shapes, so the
setting can be switched on or off on a live table: items written under the
other setting keep reading, and each is rewritten in the current shape on its
next write. A compressed item that fails to decode is treated like any
malformed record: no session.

### `LambderMemorySessionStore`

A `Map`, for tests and for the mock runtime. Records are copied on the way in
and out through JSON, the way a real store serializes them, so an `undefined`
field drops and a cyclic value throws here exactly as it does on the way into
DynamoDB. `list()`, `size` and `reset()` are there for assertions and for
rewinding. `lambderTestApp` puts one under an app's built instance, and signs
visitors in without a login endpoint; see [Testing](./testing.md).

```typescript
new LambderMemorySessionStore({
    maxEntries: 100_000,   // live sessions held before the soonest to expire is evicted
    now: () => Date.now(), // injectable clock, so a test can move past an expiry
});
```

`maxEntries` is what makes "in memory" a bounded claim rather than a slower
leak, and it is worth saying what reaching it costs: **an eviction is a
logout**. The session that expires soonest goes first, and whoever held it is
signed out with no warning and no way to tell that from any other expiry. The
default ceiling is high enough that no ordinary single-process run reaches it;
lower it only where the process must stay bounded and the logouts are
acceptable, which in practice means tests and the mock runtime rather than a
long-lived server holding real sessions.

## Session controller

Everything a request does to its session goes through
`lambder.getSessionController(ctx)`:

| Method | Description |
| --- | --- |
| `createSession(sessionKey, data?, ttlInSeconds?)` | Start a new session, persist it, and write its cookies |
| `issueSession(sessionKey, data?, ttlInSeconds?)` | The same, handing back the raw tokens beside the session (tests, the mock runtime) |
| `fetchSession()` | Fetch and validate the existing session (throws if not found) |
| `fetchSessionIfExists()` | The session, or null |
| `updateSessionData(newData)` | Write new session data |
| `refreshSessionData()` | Run the `dataRefresh` callback now, regardless of TTL |
| `endSession()` | End this session and delete it |
| `endSessionAll()` | End every session for this sessionKey (all devices), this request's own included: to leave the caller signed in, create the replacement after it rather than before |
| `deleteSessionAllByKey(sessionKey)` | Delete every session of any sessionKey ("log user X out everywhere") |
| `expireSessionDataAllByKey(sessionKey)` | Mark the data of every session of a sessionKey stale, so each renews via `dataRefresh` on its next read (no logout) |
| `regenerateSession()` | Regenerate the token (use after a password change) |
| `reissueSession()` | The same, handing back the raw tokens, for a client that holds its CSRF token rather than reading `document.cookie` |

```typescript
lambder.addApi("login", { input: LoginSchema, output: z.object({ ok: z.boolean() }) }, async (ctx, res) => {
    const user = await authenticate(ctx.apiPayload);
    if (!user) refuse("Wrong email or password.");

    await lambder.getSessionController(ctx).createSession(user.id, { userId: user.id });
    return res.api({ ok: true });
});
```

**Session APIs require the posted CSRF token; session routes do not.** The
controller is handed the token an API call posted, and `csrfToken: null` for
anything that is not an API call, and with null it skips the pairing entirely:
an `addSessionRoute` handler runs on the session cookie alone. That is fine for
a route that renders. A route that CHANGES state has to check the token itself,
against the record rather than against the cookie beside it:

```typescript
lambder.addSessionRoute("/settings/display-name", async (ctx, res) => {
    const posted = typeof ctx.post.csrf === "string" ? ctx.post.csrf : null;
    if (!await lambder.getSessionManager().isSessionCsrfTokenValid(ctx.session, posted)) {
        return res.status(403, "This form is stale. Reload the page and try again.");
    }
    ...
});
```

The default `SameSite=Lax` is the only other thing standing in front of such a
route, so `sameSite: "None"` leaves it with nothing.
`examples/secure-session-example.ts` renders the form and makes this check.

`isSessionTokenValid(session, sessionToken)` sits beside it on
`getSessionManager()` for the other half: an app that holds a session token
itself and wants to verify it outside the request path the controller covers.

## Cookie scope

`session.cookie` sets the scope of the two session cookies:
`{ domain: ".example.com" }` shares a login across subdomains, and `domain` may
be a `(hostname) => string | undefined` function when one deployment serves
several apex domains (return undefined for a host-only cookie); `path`,
`sameSite` (default `Lax`) and `secure` (default true) complete it.
`LambderCaller` takes the same `sessionCookieDomain` so it can clear the CSRF
cookie where the server set it.

`domain` is a larger decision than "shares a login across subdomains" makes it
sound. A cookie carrying a `Domain` is SENT to every host under that domain, so
every current and future subdomain receives the session cookie of every visitor
who reaches it, and holds a working session token for them. `HttpOnly` does not
change that: it stops a page's script from reading the cookie, not a host from
receiving it in the request headers its own page triggers. That is strictly
more than the planting the section above is about, where a sibling host can
only write. So set `domain` only for a domain whose every subdomain is under
your control, including the ones that do not exist yet and any a wildcard
record or a third-party CNAME may hand out. It is the reason `__Host-`, which a
browser accepts only without a `Domain`, is the recommended default.

### Changing the scope on a live deployment

Changing `domain` or `path` is a migration, because a browser identifies a
cookie by (name, domain, path): the old copy stays beside the new one, both
arrive on every request, and the browser's order says nothing about which is
current.

The controller handles the overlap, and the order it works in is the security
property. It scans first: every well-formed copy of the session cookie is
looked up, on identity alone, with no CSRF pairing. Then it pairs, once,
against whichever single session the cookies resolved to.

Folding the pairing into the scan would answer a different question and always
answer it "one". A sibling subdomain plants its own CSRF cookie beside the
session it planted, only one CSRF token is ever posted, and no two sessions
share a `csrfTokenHash`, so exactly one candidate would survive the pairing and
the ambiguity the scan exists to catch would be invisible on every call.

So: one live copy and some stale ones is the ordinary migration, and the live
one wins, with the ambiguity logged and the stale host-only twin evicted from
the response when a domain is configured. Two live copies are refused (above).
The reverse move, from a domain cookie back to host-only, cannot be evicted
(this host cannot name the parent domain), so that copy is tolerated on every
request until its own expiry. Renaming the cookies (`tokenCookieKey`,
`csrfCookieKey`) alongside the scope change avoids the overlap entirely.

Nothing is renewed until the winner is known. The read is two halves,
`lookupSession` (the record and the structural checks) and `renewSession` (the
`dataRefresh` callback and the sliding write), and only the first runs per
candidate: sliding the expiry of a cookie a sibling host planted, or running
the app's `dataRefresh` for it, would keep it alive on the victim's traffic.

## How the secrets are stored

The session cookie is `sessionKeyHash:secret`, where
`sessionKeyHash = sha256(sessionKey + sessionSalt)` and `secret` is 256 random
bits.

At rest the record stores only HASHES of the bearer secrets: its `secretHash`
is `sha256(secret)` (so the lookup itself proves possession of the raw secret)
and the CSRF token is stored as `csrfTokenHash`. The raw values exist only in
the client's cookies and, transiently, on the `LambderCreatedSession` result
the manager returns at creation. A read of the session store (backup leak,
over-broad IAM, insider) therefore yields no usable cookies.

Hashing and randomness go through `LambderSessionCrypto`: WebCrypto by
default (`crypto.subtle` on Node 20+, every browser on a secure context, and
edge runtimes), which is what lets the same manager run outside Node.

Fast sha256 is the correct construction here rather than a password KDF: the
secrets are 256-bit random, so there is nothing to brute-force, while
`sessionSalt` peppers the identity-to-partition-key mapping so partition keys
and cookie prefixes cannot be derived from (or linked to) known user ids.

What the salt does not do is survive a dump of the table. The record stores
`sessionKey` in plaintext beside its own hash, so anyone holding items holds a
known-plaintext pair for `sha256(sessionKey + sessionSalt)` and can go at the
salt directly; only the salt's own entropy is in the way, which is why it has
to be a long random string rather than a memorable one. What the salt buys is
unlinkability against someone who sees KEYS without items: a key-only index, a
log or a metric carrying partition keys, a query that projects no attributes.

## Keeping session data fresh

Session data often caches values derived from external state: roles,
permissions, feature flags. Opt in to `dataRefresh` to give that data a shelf
life. Every session read checks it, and once `ttlSeconds` have passed your
`refresh` callback rebuilds the data, which is persisted onto the same session
record: same tokens, same cookies, the session itself untouched. Changes to the
source of truth then reach every live session within `ttlSeconds`, with no mass
session invalidation.

```typescript
const lambder = initLambder<SessionData>().create({
    session: {
        store: new LambderDdbSessionStore({ tableName: "website-session", region: "us-east-1" }),
        sessionSalt: process.env.SESSION_SALT!,
        dataRefresh: {
            ttlSeconds: 600,   // data is renewed at most every 10 minutes
            refresh: async (session) => {
                const user = await loadUser(session.data.userId);
                if (!user || user.disabled) return null;   // null ends the session
                return buildSessionData(user);
            },
        },
    },
});
```

Semantics:

- The callback must be a pure derivation of external state: concurrent reads
  may run it in parallel, last write wins.
- Returning `null` deletes the session; the request is answered as
  session-expired.
- Thrown errors fail the request as a `LambderSessionDataRefreshError` and
  leave the session untouched (they are never mistaken for a logout). Catch
  inside and return `session.data` to explicitly serve stale instead.
- Similarly, a store failure while READING a session fails the request as a
  `LambderSessionReadError` instead of reading as "no session": answering
  session-expired there would make `LambderCaller` clear the client's cookies,
  turning an infra blip into a forced logout.
- The renewal write and the sliding-expiration write share a single store
  write when both are due.
- Records created before `dataRefresh` was enabled renew on their first read.
- `updateSessionData()` marks data fresh (it was just written deliberately);
  `regenerateSession()` carries the old freshness stamp over.
- `expireSessionDataAllByKey(sessionKey)` stamps every session of a subject
  stale at once: call it after changing that subject's roles or permissions,
  and the change applies on their next request instead of within `ttlSeconds`,
  with no logout. It updates only `dataExpiresAt`, conditionally on the record
  still existing, so it neither resurrects a deleted session nor clobbers a
  concurrent write.

## Sliding expiration

`enableSlidingExpiration: true` extends the session on each access.
`slidingWriteIntervalSeconds` sets the minimum gap between those writes,
defaulting to `max(60, 5% of TTL)`, so a busy session does not write on every
request.

When a sliding write actually moves the expiry, the response re-issues both
session cookies at the new `Expires`. Without that the record slid and the
browser did not, so it dropped the cookies at creation plus TTL and a visitor
who never stopped using the app was signed out anyway, on the one deadline
sliding expiration exists to push back. The re-issue is throttled by the same
interval as the write, so an active session refreshes its cookies at most that
often rather than on every request.

The CSRF cookie is re-issued with the raw value the request itself carried: the
posted token on an API call, which has just been paired with this session, or
the single arriving CSRF cookie on a route, and only once that cookie is known
to pair. Where neither is available the session cookie slides alone, because
writing a CSRF cookie whose value does not pair would break the session it is
refreshing.

## Session-expired responses

- **API calls** answer the protocol's `{ sessionExpired: true }` envelope,
  which `LambderCaller` routes to `sessionExpiredHandler` and uses to clear the
  client's cookies.
- **Routes** answer `setSessionExpiredRouteHandler`'s response, or a plain 401
  when none is set.

## Errors

| Error | Meaning |
| --- | --- |
| `LambderSessionNotFoundError` | No session for this request: the cookies named none, or the one they named did not pair with the posted CSRF token. `fetchSessionIfExists()` answers null for it |
| `LambderSessionAmbiguousError` | The request's session cookies cannot be resolved to one session. `fetchSessionIfExists()` answers null for it, and the response carries the clearing cookies |
| `LambderSessionDataRefreshError` | The `dataRefresh` callback threw. The session is untouched |
| `LambderSessionReadError` | Reading the session record failed at the store level. Deliberately not reported as "no session" |

`fetchSessionIfExists()` swallows the first two and nothing else. Anything else
a read throws, a `TypeError` from a custom store or a bug in this layer, is a
crash: answering session-expired for a defect would make `LambderCaller` clear
the client's cookies, so the defect would present as the user being signed out
and the log would say nothing happened.
