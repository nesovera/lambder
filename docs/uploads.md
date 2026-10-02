# Direct uploads

A file that travels from the browser straight to object storage, never
through the app's function.

An API payload tops out near a few megabytes once a file is base64, and a
Lambda's request body at six, so anything larger (a scanned contract, a
signed PDF, a video) is sent by the browser to the bucket itself, with a
ticket the server signed beforehand. The ticket pins everything about the
upload: the key, the exact byte size, the content type and the SHA-256 of
the bytes, and storage enforces all of it, so the browser can only ever store
the one file it described.

The conversation is the same three steps whatever an app stores:

1. The browser describes the file (`LambderUploadFileFacts`: name, type, size,
   SHA-256) to the app's ticket endpoint, which signs a ticket for exactly
   that file (`LambderUploadTicket`) under a key the app chose.
2. The browser sends the file to storage with the ticket: a form post or a
   PUT, as the ticket says.
3. The browser asks the app's confirm endpoint to take it, and the server asks
   the bucket what arrived before its record counts as uploaded. The browser
   saying "done" proves nothing.

The server half is a `LambderUploadBucket`: `LambderS3UploadBucket` in
production, `LambderMemoryUploadBucket` in tests and the mock runtime. The
browser half is `LambderUploadRunner`.

## The rule

What one kind of upload accepts, declared once in code both sides import:

```typescript
import type { LambderUploadRule } from "lambder/client";

export const INVOICE_UPLOAD_RULE: LambderUploadRule = {
    maxBytes: 25 * 1024 * 1024,
    mimeTypes: ["application/pdf"],   // exact, no wildcards
};
```

The runner refuses a file the rule does not take before hashing it, and the
bucket refuses to sign a ticket for one, which is the check that counts.

## The server

```typescript
import { z } from "zod";
import { LambderS3UploadBucket, LambderUploadFileFactsSchema, LambderUploadTicketSchema, refuse } from "lambder";
import { defineApi, defineApiGroup } from "./app";

export const invoiceFiles = new LambderS3UploadBucket({ bucket: "shop-invoices", clientConfig: { region: "us-east-1" } });

// signedIn is the app's guard declared session: true, so both are session endpoints.
export const invoiceApis = defineApiGroup("invoices", {
    requestUpload: defineApi({
        input: z.object({ storeId: z.uuid(), fileFacts: LambderUploadFileFactsSchema }),
        output: z.object({ ticket: LambderUploadTicketSchema, invoiceId: z.uuid() }),
        guards: "signedIn",
    }, async ({ apiPayload }) => {
        const invoiceId = crypto.randomUUID();
        // The key is the app's, built from its own ids, never the browser's.
        const objectKey = `stores/${apiPayload.storeId}/invoices/${invoiceId}.pdf`;
        // Signed before the record is written: a file the rule refuses leaves nothing behind.
        const ticket = await invoiceFiles.issueUploadTicket({ objectKey, fileFacts: apiPayload.fileFacts, uploadRule: INVOICE_UPLOAD_RULE });
        await invoices.insert({ invoiceId, objectKey, ...apiPayload.fileFacts, uploadedAt: null });
        return { ticket, invoiceId };
    }),
    confirmUpload: defineApi({
        input: z.object({ invoiceId: z.uuid() }),
        output: z.object({ invoiceId: z.uuid(), fileName: z.string() }),
        guards: "signedIn",
    }, async ({ apiPayload }) => {
        const invoice = await invoices.find(apiPayload.invoiceId);
        if(!invoice) refuse("Invoice not found.");
        const verdict = await invoiceFiles.verifyUploadedObject({ objectKey: invoice.objectKey, fileFacts: invoice });
        if(!verdict.verified) refuse("The upload did not arrive. Please try again.");
        await invoices.markUploaded(invoice.invoiceId);
        return { invoiceId: invoice.invoiceId, fileName: invoice.fileName };
    }),
});
```

`LambderUploadFileFactsSchema` and `LambderUploadTicketSchema` are the zod
schemas of the two shapes that cross the app's own API; they come from the
root entry, which keeps zod out of `lambder/client` at runtime. The key is
always the app's: a bucket will not sign one holding `${filename}`, which S3
fills with the uploaded file's own name, since the ticket would then let the
browser choose where the file lands.
`issueUploadTicket` refuses a file the rule does not accept with a
`LambderApiRefusal` coded `lambder/upload-empty`,
`lambder/upload-type-rejected` or `lambder/upload-too-large`, which a client
branches and translates on like any refusal code.

`verifyUploadedObject` answers `{ verified: true }`, or
`{ verified: false, reason }` with `objectMissing` (nothing was posted) or
`factsMismatch` (something else sits under the key).

For the rest of an object's life the same bucket is the way in:

| Method | Does |
| --- | --- |
| `issueDownloadUrl({ objectKey, lifetimeSeconds?, contentDisposition? })` | A link the browser reads the object with (a preview, a download), shown in place or saved under a name |
| `readObject(objectKey)` | The bytes, for work the server does on the file; throws when the key holds nothing |
| `writeObject({ objectKey, body, mimeType, sha256Base64?, object? })` | Stores bytes the server made (a stamped copy), with the SHA-256 checked by storage on the way in; computed when not given |
| `copyObject({ fromObjectKey, toObjectKey })` | A second object with the same bytes, type, metadata and tags, made inside storage, for records that must each own their file |
| `deleteObject(objectKey)` | Removes it; a key that holds nothing is not an error |

### Lifetimes

| Signature | Bucket default | Per call |
| --- | --- | --- |
| A ticket | `ticketLifetimeSeconds`, ten minutes: enough for a large file on a slow phone | `issueUploadTicket({ lifetimeSeconds })` |
| A download link | `downloadLifetimeSeconds`, five minutes | `issueDownloadUrl({ lifetimeSeconds })` |

Both are seconds, above zero and at most seven days, the longest S3 honours a
signature; anything else throws where it is written. A signature also dies
with the credentials that made it: a Lambda's role credentials last hours, so
a ticket or link meant to live longer than that needs a bucket built on
long-lived keys (`client` or `clientConfig.credentials`).

### What an object carries

A ticket and `writeObject` take `object`, what storage keeps beside the bytes:

```typescript
await invoiceFiles.issueUploadTicket({
    objectKey, fileFacts, uploadRule: INVOICE_UPLOAD_RULE,
    lifetimeSeconds: 3600,
    object: {
        tags: { retention: "30d" },                    // a lifecycle rule deletes it after 30 days
        metadata: { storeId: apiPayload.storeId },     // x-amz-meta-storeid, back with every read
        cacheControl: "private, max-age=3600",
        contentDisposition: { disposition: "attachment", fileName: apiPayload.fileFacts.fileName },
    },
});
```

A ticket pins each of these in its signature, as it pins the key and the
checksum, so the browser sends them unchanged or not at all. Names and sizes
S3 would not keep (more than ten tags, a metadata name with a space, non-ASCII
metadata, more than 2 KB of it) throw where the app writes them.

**A time to live.** S3 has no expiry per object; a lifecycle rule on the
bucket deletes what matches it, by prefix or by tag, a day at a time. Tag an
object and give the bucket one rule per retention it uses:

```json
{ "Rules": [{ "ID": "retention-30d", "Status": "Enabled",
  "Filter": { "Tag": { "Key": "retention", "Value": "30d" } },
  "Expiration": { "Days": 30 } }] }
```

An object that must go at an exact moment, or when a record says so, is
deleted by the app (`deleteObject`) on its own schedule instead.

**How a browser presents it.** `contentDisposition` on the object is what
every read answers with, and `contentDisposition` on a download link overrides
it for that link: `{ disposition: "attachment", fileName }` saves the file
under its own name, `{ disposition: "inline" }` shows it in place. The name is
encoded for the header whatever it holds.

### S3

A ticket is an S3 presigned POST whose policy carries the key, the content
type, a `content-length-range` of exactly the size, and the SHA-256 checksum
fields, so S3 refuses any other file. That needs S3's POST policies with
checksum fields: S3 itself, or a store that implements them.

A store without POST policies, Cloudflare R2 among them, takes presigned PUTs
instead:

```typescript
export const publicFiles = new LambderS3UploadBucket({
    bucket: "public-files",
    clientConfig: { region: "auto", endpoint: "https://<account>.r2.cloudflarestorage.com", credentials },
    uploadMethod: "PUT",
});
```

A PUT ticket (`method: "PUT"`) is a URL whose signature covers the length,
the content type and the SHA-256 checksum as headers, and whatever the object
carries (`x-amz-meta-*`, `x-amz-tagging`, `cache-control`,
`content-disposition`) the same way, so the store refuses any other file just
as S3 refuses a post against its policy. The ticket hands the browser those
headers to send; the browser sets the length from the body itself. The bucket
checks, where it signs, that the URL is signed for exactly the headers the
ticket sends, and throws otherwise. `uploadMethod` has no way to be guessed:
an endpoint does not say whether the store behind it takes POST policies, so
a store that refuses them is named. The default is `"POST"`. Object tags need
a store that keeps them; R2 does not.

`LambderS3UploadBucket` needs `@aws-sdk/client-s3`,
`@aws-sdk/s3-presigned-post` and `@aws-sdk/s3-request-presigner`, optional
peer dependencies, each loaded the first time a call needs it. Signing a
ticket or a link reaches nothing; the other calls go to the bucket. The
function's role needs, on the bucket:

- `s3:PutObject`: the browser's post is authorized as the role that signed
  its ticket, and `writeObject` and `copyObject` write.
- `s3:GetObject`: download links, `readObject`, `copyObject`'s source, and
  the checksum `verifyUploadedObject` reads.
- `s3:ListBucket`: without it S3 answers a missing key with 403 rather than
  404, and `verifyUploadedObject` throws where it would answer
  `objectMissing`.
- `s3:DeleteObject`.
- With tags, `s3:PutObjectTagging` (a post or write that sets them) and
  `s3:GetObjectTagging` (`copyObject`, which copies them).
- With SSE-KMS, `kms:GenerateDataKey` for the writes and `kms:Decrypt` for the
  reads and the checksum.

The bucket also needs a CORS rule allowing `POST` from the app's origins (for
PUT tickets, `PUT` and the headers the tickets send: `content-type`,
`x-amz-checksum-sha256` and any object headers), and `GET` if the browser
fetches download links rather than navigating to them.

## The browser

```typescript
import { LambderUploadError, LambderUploadRunner } from "lambder/client";

const runner = new LambderUploadRunner({
    uploadRule: INVOICE_UPLOAD_RULE,
    requestTicket: (fileFacts, { signal }) => caller.invoices.requestUpload.outcome({ storeId, fileFacts }, { signal }),
    confirmUpload: ({ invoiceId }, { signal }) => caller.invoices.confirmUpload.outcome({ invoiceId }, { signal }),
});

try{
    const invoice = await runner.upload(file, { onProgress: showProgress, signal: controller.signal });
}catch(err){
    if(err instanceof LambderUploadError) showFailure(err.reason, err.callFailure?.refusal);
}
```

The two calls answer with the outcome a caller's `.outcome()` resolves to
(`LambderApiOutcome`), which is what lets the runner tell a call that got no
usable answer from one the endpoint refused. The ticket endpoint's output
carries `ticket` and whatever the confirm endpoint needs to find the upload
again (here `invoiceId`, the id of the record it made); the runner reads the
ticket and hands the whole output to `confirmUpload` unread, so its type is
the endpoint's own. Both calls get the upload's `signal` to pass on, so an
abort stops the app's request as well as the runner; a call that fails after
the abort is read as the abort. `upload()` answers the confirm endpoint's
receipt, or throws a `LambderUploadError` whose `reason` a screen words for
the person:

| Reason | What happened |
| --- | --- |
| `fileEmpty`, `fileTypeRejected`, `fileTooLarge` | The rule's verdict, before anything was sent |
| `fileUnreadable` | The browser could not read the file (moved, deleted, a cloud placeholder never downloaded) |
| `ticketRefused` | The ticket endpoint refused (a refusal, a rejected input, an expired session or any other answer that is not a 5xx), or `requestTicket` threw |
| `storageRejected` | Storage said no for a reason a retry cannot cure (or kept calling new tickets expired); the message carries its code |
| `networkFailed` | Storage, or the ticket or confirm call, could not be reached or kept stalling or failing, through every attempt |
| `confirmRefused` | The bytes are stored and the confirm endpoint refused them, or `confirmUpload` threw |
| `aborted` | `signal` was aborted |

When a ticket or confirm call is what ended the upload, the error carries its
failure outcome as `callFailure`, so a screen words a refusal by its code
(`callFailure.refusal.code`, `lambder/upload-too-large` from
`issueUploadTicket` among them) as it would on the call itself; its message
names the call's reason and what it said, and its `cause` is the call's
error when it had one. A function that throws instead of answering is the
app's own code failing, which no retry cures: it ends the upload as
`ticketRefused` or `confirmRefused` with what it threw as the `cause`.

Along the way the runner reports its phase (`hashing`, `requesting`,
`uploading` with the bytes sent, `confirming`). A dropped connection, a 5xx,
a refusal a retry can cure (S3's `RequestTimeout`, `SlowDown`) or a post that
moves nothing for a minute (`stallTimeoutMs`) is tried again after a random
wait whose ceiling grows with each attempt (a `LambderBackoffTimer`, see
[Retrying with a backoff](./client.md#retrying-with-a-backoff)), with the same
ticket, so a flaky connection does not leave the app a record per attempt.
The app's own calls are tried again the same way, on the same timer, when
they fail as `network`, `timeout` or `server`: the ticket call with the same
file facts, and the confirm call with the same ticket output, so a dropped
connection after the bytes are stored is confirmed on the next try rather
than ending the upload, and no second ticket leaves an orphan object behind.
A retried call may follow one that ran on the server and lost only its
answer, so both endpoints must be safe to run twice. The confirm above is:
it verifies the object and marks the same record again. A ticket endpoint
run twice leaves one unconfirmed record behind, as a person's own retry
would. A confirm with an effect of its own (a count, a message, a move to
another key) is declared idempotent on the server and called with one key
per upload, built from the ticket's output, so every retry carries it:

```typescript
confirmUpload: ({ invoiceId }, { signal }) =>
    caller.invoices.confirmUpload.outcome({ invoiceId }, { signal, idempotencyKey: `confirm-${invoiceId}` }),
```

A key made inside `confirmUpload` with `createIdempotencyKey()` would be a
new one on every retry, and protect nothing.
Each step (the ticket, storage, the confirm) gets every attempt: the timer is
reset when a step succeeds. `storageRetry` sets the attempts and the bounds
of the wait for all three, and a
`baseDelayMs` of 0, which would retry with no pause, is refused where the
runner is built. A caller's handlers hear each attempt of its call as they
hear any call, so a call site that words the upload's failure itself passes
its own quiet `errorHandler` in the call's options. A ticket storage calls expired, or
whose signing credentials it calls expired (S3's `ExpiredToken`), is replaced
with a new one at once, spending no attempt, up to twice. The runner
sends over XMLHttpRequest, the one way a browser reports how much of a body
has been sent; where only fetch exists it sends over fetch, without progress
or the stall watch. A POST ticket is sent as a form, its fields ahead of the
file; a PUT ticket as the file itself, with the ticket's headers.

The runner reads the whole file to hash it, since WebCrypto digests a buffer
rather than a stream, so a rule's `maxBytes` should stay within what a
browser holds in memory at once: hundreds of megabytes, not gigabytes.

`checkFile(file)` answers the rule's verdict without sending anything, for a
drop zone to ask on drop, `acceptedTypes` is the rule's types for a file
input's `accept`, and `discard(receipt)` calls the optional `discardUpload`
for an upload the person removed again.

## Tests and the mock runtime

`LambderMemoryUploadBucket` is the same bucket in memory. It checks a post
the way S3 checks a presigned POST (every field the ticket carries with its
value and no other, ahead of the file; a ticket it issued and not expired; a
body of exactly the size; bytes with that SHA-256) and refuses otherwise with
the status and XML error S3 answers with, so a runner, or any other client,
takes the same path against it as against S3. With `uploadMethod: "PUT"` it
signs PUT tickets and checks a PUT the way a store checks a presigned one:
every signed header with its value, no unsigned `x-amz-` header, the signed
length, a URL not expired, and the checksum against the bytes. Its tickets and
links point under `baseUrl`, a host of its own that cannot resolve unless
something answers for it, and `handleStorageRequest(request)` is what answers:
a fetch `Request` in, a `Response` out, or null for a request that is not the
bucket's. `listObjectKeys()`, `inspectObject(key)` (the object's facts, tags,
metadata and headers) and `reset()` are there for assertions and between
tests, and `now` moves its clock past an expiry without waiting.

In the mock runtime, `lambderMockUploadMswHandler` puts that behind MSW, and
the mock's handlers call the memory bucket as the server's call the real one:

```typescript
import * as msw from "msw";
import { setupWorker } from "msw/browser";
import { LambderMemoryUploadBucket, lambderMockMswHandler, lambderMockUploadMswHandler } from "lambder/mock";

const invoiceFiles = new LambderMemoryUploadBucket();

export const invoiceMocks = mockApp.apiSlice(
    mockApp.api("invoices.requestUpload", {
        guards: "signedIn",   // restated; the mock's signedIn needs a session, as the server's does
        handler: async ({ payload }) => {
            const invoiceId = crypto.randomUUID();
            const ticket = await invoiceFiles.issueUploadTicket({ objectKey: `mock/${invoiceId}.pdf`, fileFacts: payload.fileFacts, uploadRule: INVOICE_UPLOAD_RULE });
            return { ticket, invoiceId };
        },
    }),
    // ...confirmUpload verifies through invoiceFiles the same way
);

const worker = setupWorker(
    lambderMockMswHandler(mockApp, { msw, apiPath: "/api" }),
    lambderMockUploadMswHandler(invoiceFiles, { msw }),
);
```

In Node, `setupServer` from `msw/node` takes the same handler, and a test
that stubs `fetch` itself can hand requests to `handleStorageRequest`
directly.

## A bucket of your own

`LambderUploadBucket` is an interface, so other storage can stand behind the
same runner and endpoints. Its `issueUploadTicket` refuses a file the rule
does not take with the three `lambder/upload-*` codes: call
`refuseUnacceptedUpload(uploadRule, fileFacts)` before signing, as both of
Lambder's buckets do, and `checkUploadRule` for the verdict alone. What the
browser sends is up to the ticket: for `method: "POST"` the runner posts
`formFields` as form fields ahead of the file to `uploadUrl`, for
`method: "PUT"` it puts the file to `uploadUrl` with `headers`, and either
way it reads a refusal written as S3 writes one.
