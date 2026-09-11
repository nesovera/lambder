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
which does everything else for every source: traversal check, in-memory file
cache for warm invocations (default 32MB, 2MB per file), compiled-template
cache, mime fallback from the extension. Cache-Control (immutable for
content-hashed names), ETag and compression are applied by the serving slot and
the response pipeline.

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

A missing S3 object reads as null; grant `s3:ListBucket` besides `s3:GetObject`,
otherwise S3 answers a missing key with AccessDenied, which propagates as an
error instead of falling through. The object's Content-Type is used unless it
is a generic octet-stream, in which case the extension decides.

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

Each path segment is percent-encoded, so `a b.png` is requested as `a%20b.png`
and names the same object it would as an S3 key. A 404 or 410 reads as null and
the request falls through; any other failed status, a network error or a
timeout propagates as an error. Redirects are followed. The response's
Content-Type is used unless it is a generic octet-stream, and the ~6MB response
cap applies here too.

## servePublicFiles

A terminal slot that serves real files from the `files` source. It runs only
when no route or API matched, so unlike a `"/(.*)"` catch-all route it can
never shadow routes registered after it. Traversal-safe, mime-typed,
memory-cached for warm invocations, immutable Cache-Control for content-hashed
assets (`app-4f8a1b2c.js`), automatic ETag and compression. When the file does
not exist, the request **falls through**.

| Option | Default | Description |
| --- | --- | --- |
| `path` | `(ctx) => ctx.path` | Map the request to a file path (app-owned logic, per-tenant roots). Return null or undefined to skip |
| `cacheControl` | `"public, max-age=3600"` | A string, or `(ctx, relativePath) => string` |
| `immutablePattern` | content-hash heuristic | Filenames matching this get `immutableCacheControl`. `false` disables it |
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
| `methods` | `["GET", "HEAD"]` | Methods that reach the slot |
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
    .servePublicFiles({ path: (ctx) => `${getBrandFromHost(ctx.host)}${ctx.path}` })
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
