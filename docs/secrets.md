# Secrets and retries

Small things an app otherwise writes for itself, each of them once per kind
of token, secret or retry loop it has: a signed token that is its own record,
the digest a stored secret rests as, the stored form of a password, the life
of a secret handed out once and taken back once, and a wait that grows after
each failure. The signed claims, the digest helpers and the timer run
wherever WebCrypto and `setTimeout` do (a Lambda, a browser, an edge Worker)
and come from both `lambder` and `lambder/client`; the password hasher, which
needs node's argon2, and the one-shot secrets live on the root entry.

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

`randomCode(alphabet, length)` mints one a person types or reads out instead:
`length` characters drawn uniformly from `alphabet`, from the same source. One
byte draws one character, and a byte at or above the largest multiple of the
alphabet's size is drawn again, because `byte % alphabet.length` alone draws
the alphabet's first characters more often than the rest. So the alphabet is
2 to 256 distinct characters (counted as code points, so one outside the
basic plane is one character), past which one byte cannot reach every
character, and `length` a positive integer; anything else throws.

```typescript
const pairingCode = randomCode("ABCDEFGHJKMNPQRSTVWXYZ23456789", 8);   // no 0/O or 1/I to misread
const emailCode = randomCode("0123456789", 6);
```

```typescript
const deviceSecret = randomSecret();                              // handed to the device, once
await db.insert({ deviceId, secretDigest: await keyedDigest(DEVICE_SECRET_KEY, deviceSecret) });

// Later, when the device presents it:
const row = await db.findDevice(deviceId);
if(!row || !constantTimeEquals(row.secretDigest, await keyedDigest(DEVICE_SECRET_KEY, presented))) refuse("Unknown device.");
```

## Passwords

`LambderPasswordHasher` stores a password as argon2id, through node's own
`crypto.argon2` (Node 24.7 and later), in the PHC string every argon2 library
reads and writes:

```text
$argon2id$v=19$m=65536,t=3,p=4$<salt>$<tag>
```

The string carries its own random salt and its cost (memory in KiB, passes,
lanes), so verifying needs nothing but the string and the attempt, and the
cost can be raised without invalidating a password stored before it.

```typescript
import { LambderPasswordHasher } from "lambder";

const passwords = new LambderPasswordHasher();                 // 64 MiB, 3 passes, 4 lanes

// Setting a password: store the string.
await db.updateCustomer(customerId, { passwordHash: await passwords.hash(newPassword) });

// Signing in. Verified whether or not the email names a customer, so an
// unknown email takes as long to refuse as a wrong password.
const customer = await db.findCustomerByEmail(email);
const matches = await passwords.verify(customer?.passwordHash, attempt);
if(!customer || !matches) refuse("Wrong email or password.");
if(passwords.needsRehash(customer.passwordHash)){
    await db.updateCustomer(customer.id, { passwordHash: await passwords.hash(attempt) });
}
```

- **`hash(password)`** writes argon2id under the instance's cost with a fresh
  16-byte salt and a 32-byte tag.
- **`verify(stored, password)`** reads the variant and cost from `stored`, so
  it verifies what other argon2 libraries wrote too: argon2id, argon2i or
  argon2d, with the parameters in any order. It answers false, never throws,
  for anything that is not an argon2 PHC string within the ceilings below:
  `null` for an account with no password, `undefined` for one that does not
  exist, a hash of another scheme, a corrupt value. For those it still
  computes one hash under the instance's cost, so how long a sign-in takes
  does not say whether the account exists or has a password. The comparison
  takes the same time wherever the tags differ.
- **`needsRehash(stored)`** is true when `stored` was written under another
  variant or cost than the instance writes. Ask it after a successful verify,
  while the plaintext is at hand: that is how a raised cost reaches the
  passwords stored before it.

The options are `memoryKib` (default 65536), `passes` (default 3) and
`parallelism` (default 4), each a positive integer, with at least 8 KiB per
lane; anything else throws at construction. A cost has ceilings, the same for
what an instance writes and what it verifies: at most 2 GiB of memory (RFC
9106's largest recommended setting), at most 4 GiB of memory over all passes
(libsodium's strongest preset, 1 GiB over 4), and at most 255 lanes. The cost
a verify runs under is read from the stored string, before anyone is signed
in, so a string naming hours of passes or more memory than the function has
(an imported hash, a corrupt row) would stall every sign-in on its account; a
string over the ceilings matches no password instead. A runtime without argon2 (Node
before 24.7) throws at construction too, rather than on the first sign-in,
where a hasher that cannot hash would read as a wrong password for every
account. Each hash holds `memoryKib` of memory while it runs, so a function
that verifies passwords needs that much headroom per concurrent sign-in.

A password is hashed as its UTF-8 bytes, as given. The same password typed on
two keyboards can arrive as two spellings of one character (`é` composed or
decomposed), so an app that wants them to match normalizes it, for example
with `password.normalize("NFC")`, before both `hash` and `verify`, the same
way every time. Which passwords are acceptable (length, breached lists) is the
app's rule, checked before `hash`.

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
digits by default), drawn from without bias by `randomCode` (above), and
held to its rules at construction. A **token** carries its own
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
tables](./ddb-tables.md)): a code as its scope's record, one conditional
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

`LambderBackoffTimer`, one pending wait at a time where each retry after a
failure waits longer than the one before it, is documented with the browser
client, where it is exported: see [Retrying with a
backoff](./client.md#retrying-with-a-backoff).
