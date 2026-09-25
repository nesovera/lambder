# Frontend hosting

Lambder has no SPA-specific machinery. Hosting a frontend build is a recipe
built from three generic primitives, on top of one configured file source.

1. **`servePublicFiles(options?)`** serves real files.
2. **`serveIndexHtml(handler?, options?)`** serves the app shell for whatever
   is left.
3. **`res.templateFile(path, data?, options?)`** renders an HTML file through
   the templating engine.

```typescript
// Zero-config single-tenant hosting:
lambder.servePublicFiles().serveIndexHtml();
```

## File sources

The `files` option at creation is a `LambderFileSource`, an object with one
method, `read(relativePath)`, returning `{ body, mimeType? }` or `null`.

The instance owns one reader over it, `lambder.files`, and `servePublicFiles`,
`serveIndexHtml`, `res.file` and `res.templateFile` all go through that reader,
which does everything else for every source: the path rule, an in-memory file
cache for warm invocations (default 32MB, 2MB per file), a short memory of
paths it had no file for (60 seconds by default), a compiled-template cache,
mime fallback from the extension with a UTF-8 charset on text types.
Cache-Control (immutable for content-hashed build output), ETag and
compression are applied by the serving slot and the response pipeline.

The memory cache takes `{ maxBytes, maxFileBytes, missTtlSeconds }` beside
the source: `files: { source, memoryCache: { missTtlSeconds: 10 } }`. A
remembered miss spares an SPA a source round trip (an S3 `GetObject`
answering NoSuchKey) on every page navigation before the shell is served; a
file uploaded under such a path is served once the miss runs out, and
`missTtlSeconds: 0` asks the source every time. `memoryCache: false` turns
both off.

The path rule is what a source is allowed to be asked for, and the reader
applies it before every read. A source receives a plain relative path: every
leading slash is stripped, and a path is refused outright (the request falls
through) when what is left is empty, ends in a slash, or has a segment that is
empty, `.`, `..`, or contains a backslash. That is the whole rule, so a source
implementing `read` never has to parse the request path itself. A source that
resolves the value against a base it must not leave should still check the
result, as the bundled ones do: `LambderLocalFileSource` re-checks that the
resolved file is under `root`, and `LambderHttpFileSource` that the resolved
URL is still under `baseUrl`.

```typescript
// A folder, typically the build output bundled with the deployment.
initLambder().create({ files: new LambderLocalFileSource({ root: path.resolve("./public") }) });

// S3. @aws-sdk/client-s3 is an optional peer dependency, loaded on first read.
initLambder().create({
    files: new LambderS3FileSource({ bucket: "myapp-web", prefix: "v42/", clientConfig: { region: "eu-central-1" } }),
});

// Cloudflare R2, or any S3-compatible store: point the client at its endpoint.
initLambder().create({
    files: new LambderS3FileSource({
        bucket: "myapp-web",
        clientConfig: { region: "auto", endpoint: "https://<account>.r2.cloudflarestorage.com", credentials: { accessKeyId, secretAccessKey } },
    }),
});

// Any origin serving files by path: a CDN, an R2 custom domain, a public bucket. Reads with fetch, no SDK.
initLambder().create({ files: new LambderHttpFileSource({ baseUrl: "https://assets.example.com/v42/" }) });

// Anything else: implement read().
initLambder().create({ files: { read: async (relativePath) => myStore.get(relativePath) } });

// The in-memory file cache, tuned or off, beside any source.
initLambder().create({ files: { source: new LambderS3FileSource({ bucket: "myapp-web" }), memoryCache: { maxBytes: 64_000_000, maxFileBytes: 4_000_000 } } });
initLambder().create({ files: { source: new LambderLocalFileSource({ root }), memoryCache: false } });
```

### S3 notes

The reader needs `s3:GetObject` on the prefix. A missing object reads as null
and the request falls through; any other failure propagates as an error. What
counts as missing is `notFoundErrorNames`, by default `NoSuchKey` and
`NotFound`, `AccessDenied`, and the refusals of a key S3 will not look up at
all (`KeyTooLongError` and `InvalidURI` from S3, `InvalidObjectName` from R2),
since the request path names the key and a visitor can make it as long or as
odd as they like.

`AccessDenied` is there because a reader without `s3:ListBucket` gets it for a
missing key: S3 will not say whether the key exists. Read as an error, every
SPA route would fail with a 500 before the shell was served. It is the same
default the HTTP source has for a 403. Grant the reader `s3:ListBucket` and S3
answers a missing key `NoSuchKey`; then a list without `AccessDenied`
(`notFoundErrorNames: ["NoSuchKey", "NotFound", "KeyTooLongError", "InvalidURI", "InvalidObjectName"]`)
makes a refused credential surface as the error it is.

| Option | Default | Description |
| --- | --- | --- |
| `bucket` | required | The bucket name |
| `prefix` | none | Literal key prefix the relative path is appended to, trailing slash included: `"web/v42/"` |
| `client` | none | A ready `S3Client`, e.g. one shared with the rest of the app |
| `clientConfig` | none | Otherwise the client is created from this on first read: `{ region }` for S3, `{ region: "auto", endpoint, credentials }` for R2 |
| `notFoundErrorNames` | the list above | The S3 error names that mean "no such file": read as null, and the request falls through |

The object's Content-Type is used unless it is a generic octet-stream, in
which case the extension decides.

Lambda's ~6MB response cap still applies to anything proxied this way: redirect
large downloads to the bucket or CDN URL instead of serving them.

### HTTP notes

`LambderHttpFileSource` requests `baseUrl` plus the relative path with the
runtime's `fetch`: no SDK, and no credentials for a public origin. When the
bucket is public and sits behind a CDN (an R2 custom domain, say), this is
usually the better fit than the S3 source: reads come out of the edge cache
instead of the bucket, and the Lambda holds no bucket keys. A version in the
base URL (`.../v42/`) suits it well, since files under one version never change
and the memory cache never has to drop them.

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | required | The folder URL relative paths resolve under. A missing trailing slash is added |
| `headers` | none | Sent with every read, e.g. an Authorization header for a private origin or a User-Agent a firewall allows |
| `timeoutMs` | `10000` | How long one read may take before it fails |
| `notFoundStatuses` | `[403, 404, 410]` | The statuses that mean "no such file": read as null, and the request falls through |

Each path segment is percent-encoded, so `a b.png` is requested as `a%20b.png`
and names the same object it would as an S3 key. A missing file reads as null
and the request falls through; any other failed status, a network error or a
timeout propagates as an error. A 403 counts as missing by default because a
private S3 bucket behind CloudFront (origin access control) answers a missing
key 403: its reader may not list the bucket, and S3 will not say whether the
key exists. Read as an error, every SPA route would fail with a 500 before
the shell was served. Grant the reader `s3:ListBucket` and S3 answers 404
instead; then `notFoundStatuses: [404, 410]` makes a 403 surface as the refused
credential it is. Redirects are followed. The response's
Content-Type is used unless it is a generic octet-stream, and the ~6MB response
cap applies here too.

## servePublicFiles

A terminal slot that serves real files from the `files` source. It runs only
when no route or API matched, so unlike a `"/(.*)"` catch-all route it can
never shadow routes registered after it. Gated by method (`GET`/`HEAD` by
default), mime-typed, memory-cached for warm invocations, immutable
Cache-Control for content-hashed build output, automatic ETag and
compression. The default immutable rule takes only what a bundler wrote:
everything under `_next/static/`, and under `assets/` or `static/` a name
ending in its hash (`assets/index-BHf9XZ2a.js`, `static/js/main.3f2a1b9c.js`).
A hand-named file (`og-image-1200x630.png`, `team-photo-2023.jpg`) keeps the
ordinary Cache-Control outside those folders, since a file marked immutable for
a year never reaches a browser that already holds the old copy. Inside
`assets/` or `static/`, a name whose last part could be a hash is taken for one
(`assets/og-image-1200x630.png`, `static/banner-2024Q1v2.png`): keep
hand-named files that get replaced elsewhere (`public/` or the site root), or
pass `immutablePattern` for another layout. An 8-character last part counts
as a hash only when it looks random: a capital, a lowercase letter and a
digit, or at least three capitals and a lowercase letter. So
`assets/Inter-SemiBold.woff2`, `assets/icon-Settings.svg` and
`assets/og-image-v2-final.png` keep the ordinary Cache-Control, and so does
about one Vite hash in twenty (no digit and fewer than three capitals), which
costs a revalidation, never a stale file. When the method is not configured
or the file does not exist, the request **falls through**.

A file answer that carries a cookie (a `beforeRender` hook that issues a
guest session, a session read that slides the cookies) goes out `private`,
without `immutable`: a shared cache would otherwise keep the asset with that
visitor's Set-Cookie and hand it to everyone. See
[The response pipeline](./responses.md#the-response-pipeline).

| Option | Default | Description |
| --- | --- | --- |
| `methods` | `["GET", "HEAD"]` | Methods that reach the slot, the same gate `serveIndexHtml` has. A write method against an asset path falls through to the route fallback instead |
| `path` | the file path | `(ctx, filePath) => string`: map the request to a file path (app-owned logic, per-tenant roots). `filePath` is the file `ctx.path` names, its kept `%25` read as `%`; a path with an encoded slash names no file and never reaches the mapper. Return null or undefined to skip |
| `cacheControl` | `"public, max-age=3600"` | A string, or `(ctx, relativePath) => string` |
| `immutablePattern` | bundler output rule | Relative paths matching this get `immutableCacheControl`. `false` disables it |
| `immutableCacheControl` | `"public, max-age=31536000, immutable"` | Applied to matching filenames |
| `compress` | `"auto"` | `true`, `false`, `"auto"`, or `(ctx) => boolean \| "auto"`, e.g. `(ctx) => /\.(css\|js\|svg)$/.test(ctx.path)` |

## serveIndexHtml

The next slot in the fallback chain, gated only by method (`GET`/`HEAD` by
default). It does **not** guess whether a path is a file: `servePublicFiles`
already served every real file, so anything reaching this slot is an app route,
including dotted ones like `/report/<jwt>`, `/map/41.0082,28.9784` or
`/whois/example.com`.

Gated-out requests fall through to `setRouteFallbackHandler`. Without a handler
it serves `index.html` from the files source via `res.templateFile` with
`no-cache`, so plain hosting is zero-config and templating is opt-in.

| Option | Default | Description |
| --- | --- | --- |
| `methods` | `["GET", "HEAD"]` | Methods that reach the slot. A list naming `GET` without `HEAD` accepts `HEAD` too, as a route matcher's `method` does |
| `skipFilePaths` | `false` | Opt back into 404ing paths whose last segment contains a dot. Cheaper responses for missing assets and bot probes, at the cost of breaking dotted routes |
| `redirectTrailingSlash` | `false` | 301 `/about/` to `/about` |
| `indexFile` | `"index.html"` | The shell the default handler serves; a string or `(ctx) => string` |
| `compress` | `"auto"` | Same form as `servePublicFiles` |

## Templated shells

`res.templateFile(path, data?, options?)` renders any HTML file from the files
source through [`LambderTemplatingEngine`](./templating.md) (compiled once,
cached across warm invocations) and returns it as an HTML response.

Template markers are HTML comments, so they survive a Vite or webpack build
untouched and the browser renders the default content during frontend
development:

```html
<!-- frontend index.html -->
<title><!--slot:title-->My App<!--/slot:title--></title>
<!--slot:head/-->
```

```typescript
lambder.servePublicFiles().serveIndexHtml(async (ctx, res) => {
    return res.templateFile("index.html", {
        title: pageTitle(ctx),                          // escaped automatically
        head: html`<link rel="canonical" href="${canonicalUrl(ctx)}" />`,
    }, { cacheControl: "no-cache" });
});
```

Files without template markers can opt into virtual slots (`title` is the
`<title>` element, `head` is the position before `</head>`) with
`res.templateFile(path, data, { htmlVirtualSlots: true })`.

## Multi-tenant hosting

Per-brand or per-tenant roots are just app logic in the path mapper:

```typescript
lambder
    .servePublicFiles({ path: (ctx, filePath) => `${getBrandFromHost(ctx.host)}${filePath}` })
    .serveIndexHtml(async (ctx, res) => {
        return res.templateFile(`${getBrandFromHost(ctx.host)}/index.html`, {
            title: pageTitle(ctx),
            head: html`<link rel="canonical" href="${canonicalUrl(ctx)}" />
                ${jsonScript("app-data", preloadedState(ctx))}`,
            isRtl: activeLang(ctx) === "ar",
        }, { cacheControl: "no-cache" });
    });
```

## The fallback chain in full

```typescript
lambder
    .addRoute(/* app routes first */)
    .servePublicFiles()                    // real files
    .serveIndexHtml()                      // app shell for page requests
    .setRouteFallbackHandler((ctx, res) => res.status404("Not Found"));
```

See [Routing](./routing.md#the-fallback-chain) for how the chain relates to
routes and APIs.
