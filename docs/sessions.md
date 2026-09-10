# Sessions

DynamoDB-backed sessions, configured once at creation. They are required for
`addSessionApi` and `addSessionRoute`, and give `ctx.session` its type.

```typescript
const lambder = initLambder<SessionData>().create({
    apiPath: "/api",
    session: {
        tableName: "website-session",
        tableRegion: "us-east-1",
        sessionSalt: process.env.SESSION_SALT!,
        enableSlidingExpiration: true,   // extend the session on each access
        compression: true,               // Brotli-compress session.data at rest (default)
        // Cookie names default to LMDRSESSIONTKID / LMDRSESSIONCSTK
        tokenCookieKey: "MY_SESSION_TOKEN",
        csrfCookieKey: "MY_CSRF_TOKEN",
    },
});
```

The table shape, TTL setting and IAM policy are in
[DynamoDB tables](./dynamodb-tables.md).

## Session controller

Everything a request does to its session goes through
`lambder.getSessionController(ctx)`:

| Method | Description |
| --- | --- |
| `createSession(sessionKey, data?, ttlInSeconds?)` | Start a new session and persist it |
| `fetchSession()` | Fetch and validate the existing session (throws if not found) |
| `fetchSessionIfExists()` | The session, or null |
| `updateSessionData(newData)` | Update session data in DynamoDB |
| `refreshSessionData()` | Run the `dataRefresh` callback now, regardless of TTL |
| `endSession()` | End this session and delete it |
| `endSessionAll()` | End every session for this sessionKey (all devices) |
| `deleteSessionAllByKey(sessionKey)` | Delete every session of any sessionKey ("log user X out everywhere") |
| `expireSessionDataAllByKey(sessionKey)` | Mark the data of every session of a sessionKey stale, so each renews via `dataRefresh` on its next read (no logout) |
| `regenerateSession()` | Regenerate the token (use after a password change) |

```typescript
lambder.addApi("login", { input: LoginSchema, output: z.object({ ok: z.boolean() }) }, async (ctx, res) => {
    const user = await authenticate(ctx.apiPayload);
    if (!user) refuse("Wrong email or password.");

    await lambder.getSessionController(ctx).createSession(user.id, { userId: user.id });
    return res.api({ ok: true });
});
```

## Cookie scope

`session.cookie` sets the scope of the two session cookies:
`{ domain: ".example.com" }` shares a login across subdomains, and `domain` may
be a `(hostname) => string | undefined` function when one deployment serves
several apex domains (return undefined for a host-only cookie); `path`,
`sameSite` (default `Lax`) and `secure` (default true) complete it.
`LambderCaller` takes the same `sessionCookieDomain` so it can clear the CSRF
cookie where the server set it.

### Changing the scope on a live deployment

Changing `domain` or `path` is a migration, because a browser identifies a
cookie by (name, domain, path): the old copy stays beside the new one, both
arrive on every request, and the browser's order says nothing about which is
current.

The controller handles the overlap. When the session cookie name arrives more
than once it tries every copy (record lookup and CSRF pairing per copy), takes
the live one, logs the ambiguity, and evicts the stale host-only twin from the
response when a domain is configured. The reverse move, from a domain cookie
back to host-only, cannot be evicted (this host cannot name the parent domain),
so that copy is tolerated on every request until its own expiry. Renaming the
cookies (`tokenCookieKey`, `csrfCookieKey`) alongside the scope change avoids
the overlap entirely.

## How the secrets are stored

The session cookie is `pkHash:secret`, where
`pkHash = sha256(sessionKey + sessionSalt)` and `secret` is 256 random bits.

At rest the record stores only HASHES of the bearer secrets: the range key is
`sha256(secret)` (so the lookup itself proves possession of the raw secret) and
the CSRF token is stored as `csrfTokenHash`. The raw values exist only in the
client's cookies and, transiently, on the `LambderCreatedSession` result the
manager returns at creation. A read of the session table (backup leak,
over-broad IAM, insider) therefore yields no usable cookies.

Fast sha256 is the correct construction here rather than a password KDF: the
secrets are 256-bit random, so there is nothing to brute-force, while
`sessionSalt` peppers the identity-to-partition-key mapping so partition keys
and cookie prefixes cannot be derived from (or linked to) known user ids.

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
        tableName: "website-session",
        tableRegion: "us-east-1",
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
- Similarly, a DynamoDB failure while READING a session fails the request as a
  `LambderSessionReadError` instead of reading as "no session": answering
  session-expired there would make `LambderCaller` clear the client's cookies,
  turning an infra blip into a forced logout.
- The renewal write and the sliding-expiration write share a single DynamoDB
  put when both are due.
- Records created before `dataRefresh` was enabled renew on their first read.
- `updateSessionData()` marks data fresh (it was just written deliberately);
  `regenerateSession()` carries the old freshness stamp over.
- `expireSessionDataAllByKey(sessionKey)` stamps every session of a subject
  stale at once: call it after changing that subject's roles or permissions,
  and the change applies on their next request instead of within `ttlSeconds`,
  with no logout. It updates only `dataExpiresAt`, conditionally on the record
  still existing, so it neither resurrects a deleted session nor clobbers a
  concurrent write.

## Session data at rest

`session.data` is stored Brotli-compressed by default: the record carries the
data's JSON as Brotli bytes in `dataBr` beside its byte length in `dataBytes`,
in place of a plain `data` attribute. It is the scheme `LambderDdbCache` and
`LambderDdbIdempotency` already use, from the one shared codec that also
restores compressed request payloads, and the byte length both bounds the
decompression and verifies it, so a truncated record fails to decode rather
than decoding to something else.

Session data that caches roles, permissions or product lists typically shrinks
2-3x, which keeps a growing session within one DynamoDB read unit (4KB for the
consistent reads sessions use) and one write unit (1KB) for longer.

```typescript
session: {
    // ...
    compression: true,   // default: every record compressed, the same as { minBytes: 0 }
    // compression: { minBytes: 1024 } compresses only records whose JSON is 1KB+
    // compression: false stores data as a plain attribute
}
```

`quality` (Brotli 0-11, default 5) is also accepted; the option
(`LambderCompressionOption`) is the same one `LambderDdbCache` and
`LambderDdbIdempotency` take. Reads accept both record shapes, so the setting
can be switched on or off on a live table: records written under the other
setting keep reading, and each is rewritten in the current shape on its next
write (a sliding-expiration or `dataRefresh` write included). A compressed
record that fails to decode is treated like any malformed record: no session.

## Sliding expiration

`enableSlidingExpiration: true` extends the session on each access.
`slidingWriteIntervalSeconds` sets the minimum gap between those writes,
defaulting to `max(60, 5% of TTL)`, so a busy session does not write on every
request.

## Session-expired responses

- **API calls** answer the protocol's `{ sessionExpired: true }` envelope,
  which `LambderCaller` routes to `sessionExpiredHandler` and uses to clear the
  client's cookies.
- **Routes** answer `setSessionExpiredRouteHandler`'s response, or a plain 401
  when none is set.

## Errors

| Error | Meaning |
| --- | --- |
| `LambderSessionDataRefreshError` | The `dataRefresh` callback threw. The session is untouched |
| `LambderSessionReadError` | Reading the session record failed at the DynamoDB level. Deliberately not reported as "no session" |
