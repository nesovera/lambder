# Secrets and retries

Four small things an app otherwise writes for itself, each of them once per
kind of token, secret or retry loop it has: a signed token that is its own
record, the digest a stored secret rests as, the life of a secret handed out
once and taken back once, and a wait that grows after each failure. The
signed claims, the digest helpers and the timer run wherever WebCrypto and
`setTimeout` do (a Lambda, a browser, an edge Worker) and come from both
`lambder` and `lambder/client`; the one-shot secrets live with the stores on
the root entry.

## Signed claims

Much of what a server hands out to be presented later needs no row in a
database: the link in an email that names one recipient of one document, the
token a paired device shows on every call, the grant a checkout page comes
back with, the ticket a realtime edge verifies before it opens a socket. Each
is a few claims the server wants back unchanged, and a signature is what makes
"unchanged" true. Nothing is stored, so nothing is worth stealing, and the
same token can be written into a reminder days later without having kept
anything.

`LambderSignedClaims` is one kind of such token. An app declares one instance
per kind, with the secret, a version that tells this kind from every other,
and the zod schema of its claims:

```typescript
import { LambderSignedClaims } from "lambder";
import { z } from "zod";

const DeviceTokenClaimsSchema = z.object({
    deviceId: z.uuid(),
    storeId: z.uuid(),
    /** Expiry, epoch seconds. */
    exp: z.number().int().positive(),
});

export const deviceTokens = new LambderSignedClaims({
    secret: DEVICE_TOKEN_SECRET,          // the server's; never in a browser
    version: "d1",
    schema: DeviceTokenClaimsSchema,
});

// Minting, after the device proved itself:
const token = await deviceTokens.sign({ deviceId, storeId, exp: Math.floor(Date.now() / 1000) + 8 * 3600 });

// On every call the device makes:
const claims = await deviceTokens.verify(token);
if(!claims) refuse("Sign in again.", { notAuthorized: true });
```

The token is `<version>.<claims>.<mac>`: the version as given, the claims as
the JSON of what the schema accepted in base64url, and an HMAC-SHA256 over
the first two under the secret, in base64url. The schema runs on the way out,
so a token never carries a shape the app did not declare, and on the way back,
so what `verify` answers is typed as the schema's output.

`verify` answers `null` for every failure alike: a signature under another
secret, another version, malformed text, claims the schema refuses, an expiry
in the past. A caller cannot tell them apart, and so cannot tell a client
apart either; every reason is a rejected token.

One claim has a meaning to the class: `exp`, an expiry in epoch seconds, the
unit sessions, DynamoDB's TTL and JWTs use. A schema that declares it gets it
judged on every verify, against the clock the instance was built with (`now`,
for tests) or the moment a call names (`verify(token, { now })`, in epoch
milliseconds). A schema without `exp` declares a token that does not expire on
its own, which is the right shape where the thing the token names decides what
it may still do: a signer's link stays valid while the request is open, an
unsubscribe link works for as long as the message sits in a mailbox.

The secret is the server's. It is right to import the class in an edge
runtime or a shared backend package that verifies tokens, which is why it is
on `lambder/client`; a page holds no secret to verify with and never needs it.

## Stored secrets

Some secrets have to be stored, because the server has to recognize them
later by value: the secret a paired device keeps, the code emailed to an
address, a pairing code typed into a screen. Two helpers hold the two rules
every such column follows.

`keyedDigest(secret, value)` is how the secret rests: HMAC-SHA256 under the
app's secret, as 43 characters of base64url. Keyed rather than a plain hash,
so a copied table alone cannot be attacked offline, and deterministic, so a
lookup is one indexed read. Compare a stored digest with the digest of a
candidate through `constantTimeEquals`, whose duration says nothing about
where the two differ. A signature needs neither: WebCrypto verifies it, in
constant time, itself.

`randomSecret(bytes = 32)` mints the secret in the first place, from the
runtime's cryptographic random source, as base64url. Synchronous, since
`getRandomValues` is.

```typescript
const deviceSecret = randomSecret();                              // handed to the device, once
await db.insert({ deviceId, secretDigest: await keyedDigest(DEVICE_SECRET_KEY, deviceSecret) });

// Later, when the device presents it:
const row = await db.findDevice(deviceId);
if(!row || !constantTimeEquals(row.secretDigest, await keyedDigest(DEVICE_SECRET_KEY, presented))) refuse("Unknown device.");
```

## One-shot secrets

Some secrets are handed out once and given back once: the code emailed to an
address, the link in an activation mail, the code texted to a signer before a
document opens, the code an administrator reads out to pair a device. Every
one of them has the same life: minted, sent, stored as a digest, tried
against, spent. An app that writes that life once per kind of secret writes
the races too, and gets them right one at a time: the try counted after the
compare, which five guesses sent together all pass; the cooldown two taps both
clear; the redemption two requests both win.

`LambderOneShotSecrets` holds the life once, over a store that settles the
races. An app declares its kinds and names, per secret, the scope it proves:

```typescript
import { LambderDdbOneShotSecretStore, LambderOneShotSecrets } from "lambder";

export const secrets = new LambderOneShotSecrets({
    store: new LambderDdbOneShotSecretStore({ tableName: "app-policies" }),
    secret: ONE_SHOT_SECRET,                 // keys every digest at rest
    kinds: {
        emailCode: { shape: "code", length: 6, ttlSeconds: 10 * 60, maxAttempts: 5 },
        pairingCode: { shape: "token", alphabet: "ABCDEFGHJKMNPQRSTVWXYZ23456789", length: 8, ttlSeconds: 2 * 3600 },
        activationLink: { shape: "token", ttlSeconds: 48 * 3600 },
    },
});

// Sending a code: the plaintext exists outside the caller's hands exactly here.
const issued = await secrets.issue("emailCode", `register:${email}`, { cooldownSeconds: 30, meta: { identity } });
if(!issued.issued) refuse(`A code was just sent. Try again in ${issued.retryAt - nowSeconds} seconds.`);
await sendEmail(email, issued.plaintext);

// Redeeming it:
const redeemed = await secrets.redeem("emailCode", `register:${email}`, typed);
switch(redeemed.state){
    case "accepted": return redeemed.meta.identity;
    case "wrong": refuse(`Not the code we sent. ${redeemed.attemptsLeft} tries left.`);
    case "expired": refuse("That code has expired. Ask for a new one.");
    case "exhausted": refuse("Too many wrong codes. Ask for a new one.");
    case "none": refuse("Ask for a code first.");
}
```

Two shapes, because they are looked up differently. A **code** is short and
guessable, so it is bound to a scope the app names (an address for a purpose,
a recipient, a device), redeemed with that scope, and defended by a ceiling
on tries: `maxAttempts` wrong tries are refused as `wrong`, and the try after
them as `exhausted`, right or wrong. Its `alphabet` is the app's (the ten
digits by default), drawn from without bias. A **token** carries its own
identity, is redeemed by value through `redeemToken`, and has no ceiling:
random bytes (32 of base64url unless `bytes` says otherwise), long enough that
guessing is not a thing; or, for a code somebody types without knowing what it
is for (a pairing code, in the example above), characters of an `alphabet`,
which is guessable and which the app then holds off another way, such as a
rate limit per address.

The store holds digests only: HMAC-SHA256 under the app's `secret` with the
kind and, for a code, the scope folded in, so the same code issued to two
scopes never collides and a code cannot be replayed against another kind or
scope. A token's digest carries no scope, since a token is found by its value
alone, so two scopes can draw the same one (a short pairing code with many
out at once). The store claims a token's digest in the write that issues it,
refusing it while another scope's record holds it, and the class draws
again, up to five times before it throws: two holders never redeem each
other's. One record is live per scope: issuing retires whatever the scope
held, in the same write. `meta` is what the app wants back at redemption, as small
strings; a record is never a place to keep data.

Every race is settled in the store's contract, once, and
`lambderOneShotSecretStoreConformance` (from `lambder/testing`) holds every
implementation to it, the DynamoDB one and the memory one alike:

- `issue` writes the new record and retires the old in one act, and a
  cooldown (`cooldownSeconds`) is a condition on that write, so of two callers
  asking at once exactly one is answered with a secret and the other with the
  second it may ask again. For a token the same act claims the digest, so of
  two scopes racing for one exactly one is issued.
- A try is counted in the same write that reads the digest, before the
  compare, so tries sent together are all counted.
- A redemption is a conditional consume of the record it read, so of two
  redemptions of one secret exactly one is `accepted`; the other is `none`.

`retire(scope)` ends whatever the scope holds: after the thing it proved is
settled another way (a password set, an address changed), or when what was
sent never arrived, so the next ask does not have to wait out a cooldown for
a text that never came.

`LambderDdbOneShotSecretStore` keeps its items under `OTS#` in the same table
as the rate limiter and the idempotency store (see [DynamoDB
tables](./dynamodb-tables.md)): a code as its scope's record, one conditional
write per issue, and a token as its scope's record and the digest pointing at
it, both written in one transaction, so an issue never leaves a record its
value cannot find. `LambderMemoryOneShotSecretStore` is the same rules in a
map, for tests and development. An app whose secrets already live
in rows of its own implements `LambderOneShotSecretStore` over them: six
methods (`issue`, `findByScope`, `findByDigest`, `attempt`, `consume`,
`retire`), each a conditional write or a read, and runs the same suite over
its store to prove each holds (see [A store of your
own](./testing.md#a-store-of-your-own)). The class tells the store each
secret's shape at issue: a code is only ever found through its scope and
tried against it, and a token only ever found by its digest, so a store that
holds only tokens is never asked to `attempt` and may keep no count of
tries, and one that holds only codes need not find anything by digest.

## Retrying with a backoff

Most things that retry also wait for other reasons (a refresh cadence, a
pause before recreating something), and those waits must never stack with a
retry. `LambderBackoffTimer` holds exactly one wait of either kind: `retry`
and `wait` climb the ladder, `after` waits a fixed time without climbing it,
and scheduling any of them replaces whatever was waiting. A caller says what
to run and when it worked, and never keeps a handle and a counter of its own.

```typescript
import { LambderBackoffTimer } from "lambder/client";

const reconnect = new LambderBackoffTimer({ baseMs: 1_000, maxMs: 60_000 });

socket.onclose = () => reconnect.retry(open);      // waits longer after each failure
socket.onopen = () => reconnect.reset();           // the next failure waits the shortest time again
page.onhide = () => reconnect.cancel();            // drops the pending wait, keeps the count
```

The ladder: a retry waits the base plus a share of a ceiling that grows by
`factor` with every failed attempt, the whole never past `maxMs`. With full
jitter (the default) the share is random, so anything many clients fail at together (a
deploy dropping every socket, a power cut bringing every screen in a building
up at once) is retried across the whole window instead of in step, which is
what keeps the herd off the server; even the first wait falls between the
base and twice it. `jitter: "none"` waits the whole ceiling, a predictable
ladder for a caller that is alone: twice the base, then climbing to `maxMs`.

| Option | Default | Description |
| --- | --- | --- |
| `baseMs` | `1000` | The shortest retry wait; the first after a reset falls between it and twice it |
| `maxMs` | `60000`, or `baseMs` when that is longer | The longest any retry wait is; at least `baseMs` |
| `factor` | `2` | How much the ceiling grows with each failed attempt |
| `jitter` | `"full"` | `"full"`: the base plus a random share of the ceiling. `"none"`: the base plus the whole ceiling |

`wait(signal?)` is `retry` for code that awaits rather than calls back: it
resolves after the next rung, rejects at once with the signal's reason when
`signal` aborts, and rejects with an `Error` when `cancel()` or a later wait
drops it before it ran, so an `await` on it always settles. `pending` is true
while a wait of any kind is scheduled and false again by the time it runs, so
what it runs may schedule the next one.

```typescript
const storageBackoff = new LambderBackoffTimer({ baseMs: 1_000, maxMs: 15_000 });
for(let attempt = 1; ; attempt += 1){
    if(await tryStorage()) break;
    if(attempt === 4) throw new Error("storage stayed unreachable");
    await storageBackoff.wait(signal);   // throws the abort reason if the caller gives up meanwhile
}
```

That loop is what `LambderUploadRunner` runs between tries at storage; its
`storageRetry` option's `baseDelayMs` and `maxDelayMs` are the timer's
`baseMs` and `maxMs`.
