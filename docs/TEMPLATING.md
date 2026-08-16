# Templating — html/xml tags & LambderTemplatingEngine

Two standalone, zero-dependency templating tools. Both are importable directly from `lambder` and usable without the framework.

## Type-Safe Templating (html / xml)

Tagged template literals instead of a template engine. Interpolated values are HTML-escaped automatically, and everything is plain TypeScript, so templates are fully type-checked and refactorable.

```typescript
import { html, xml, raw, jsonScript } from "lambder";

// Values are escaped by default (XSS-safe):
const page = html`<h1>Hello ${user.name}</h1>`;

// Arrays flatten; nested fragments are not double-escaped:
const list = html`<ul>${items.map((item) => html`<li>${item.label}</li>`)}</ul>`;

// Conditionals: null/undefined/false render as empty string:
const nav = html`${isLoggedIn && html`<a href="/logout">Log out</a>`}`;

// raw() inserts trusted markup verbatim (never pass user input):
const head = html`${raw('<meta charset="utf-8">')}`;

// jsonScript() embeds JSON safely for client hydration:
const state = html`${jsonScript("app-data", preloadedState)}`;

// Works for XML too (xml is an alias of html):
return res.xml(xml`<?xml version="1.0" encoding="UTF-8"?>
<urlset>${urls.map((loc) => xml`<url><loc>${loc}</loc></url>`)}</urlset>`);
```

Exports: `html`, `xml`, `raw`, `jsonScript`, `escapeHtml`, `renderHtmlValue`, `LambderSafeHtml`, `LambderHtmlValue`.

## LambderTemplatingEngine

A standalone, comment-only HTML template engine. Every construct is an HTML comment, so templates survive HTML build pipelines (e.g. Vite) untouched, and during frontend development the browser simply renders the default content because the markers are invisible. It can template anything: SPA shells, emails, error pages.

**Syntax** (everything is an HTML comment):

```html
<title><!--slot:title-->Default Title<!--/slot:title--></title>   <!-- replaceable region -->
<!--slot:head/-->                                                  <!-- insert-only point -->
<!--if:isRtl--><body dir="rtl"><!--else--><body><!--/if:isRtl-->   <!-- conditional -->
<!--if:!minimal--><nav>...</nav><!--/if:!minimal-->                <!-- negated conditional -->
```

**Usage** (standalone, importable directly from `lambder`):

```typescript
import { LambderTemplatingEngine, html, jsonScript } from "lambder";

// Compile once (throws early on unclosed/mismatched blocks) ...
const template = await LambderTemplatingEngine.fromFile("./templates/page.html");
// ... render many times, per request:
const output = template.render({
    title: userInput,                                         // plain values are escaped (XSS-safe)
    head: html`<link rel="canonical" href="${canonicalUrl}" />
        ${jsonScript("app-data", preloadedState)}`,           // html`...`/raw()/jsonScript() inserted verbatim
    isRtl: lang === "ar",                                     // condition names use truthiness
});

// Runtime introspection (dynamically typed by design):
template.slotNames;       // e.g. ["title", "head"]
template.conditionNames;  // e.g. ["isRtl", "minimal"]
template.has("title");    // true
```

Rules:
- Slot values: strings/numbers escaped; `html`/`raw()`/`jsonScript()` verbatim; arrays flattened; `null`/`undefined`/`false` keep the slot's default content
- Unknown data keys are ignored, so one data object can serve several templates with different slots
- Blocks nest freely; there are intentionally no loops or inline expressions: build dynamic lists server-side with `html` and pass them into a slot
- Attribute-position values (e.g. `<html lang="...">`) are handled with if/else around whole-tag variants
- Compile-time rejection of slots in unquoted attribute positions and inside `<script>`/`<style>` (injection safety)

## Hosting a frontend build (servePublicFiles + templateFile)

Lambder has no SPA-specific machinery; hosting a frontend build is a recipe built from three generic primitives:

1. **`servePublicFiles(options?)`**: a terminal slot that serves real files under `publicPath`. It runs only when no route or API matched, so unlike a `"/(.*)"` catch-all route it can never shadow routes registered after it. Traversal-safe, mime-typed, memory-cached for warm invocations, immutable Cache-Control for content-hashed assets (`app-4f8a1b2c.js`), automatic ETag/gzip. When the file does not exist, the request **falls through**.
2. **`serveIndexHtml(handler?, options?)`**: the next slot in the fallback chain, gated only by method (`GET`/`HEAD` by default, option `methods`). It does **not** guess whether a path is a file: `servePublicFiles` already served every real file, so anything reaching this slot is an app route, including dotted ones like `/report/<jwt>`, `/map/41.0082,28.9784` or `/whois/example.com`. Set `skipFilePaths: true` to opt back into 404ing paths whose last segment contains a dot (cheaper responses for missing assets and bot probes, at the cost of breaking dotted routes). Optional `redirectTrailingSlash` (default false) 301s `/about/` to `/about`. Gated-out requests fall through to `setRouteFallbackHandler`. Without a handler it serves `publicPath/index.html` (option `indexFile`) via `res.templateFile` with `no-cache`, so plain hosting is zero-config and templating is opt-in.
3. **`res.templateFile(path, data?, options?)`**: render any HTML file under `publicPath` through `LambderTemplatingEngine` (compiled once, cached across warm invocations) and return it as an HTML response.

```html
<!-- frontend index.html (markers survive the Vite build; defaults show in vite dev) -->
<title><!--slot:title-->My App<!--/slot:title--></title>
<!--slot:head/-->
```

```typescript
lambder
    // Multi-tenant roots are just app logic in the path mapper:
    .servePublicFiles({ path: (ctx) => `${getBrandFromHost(ctx.host)}${ctx.path}` })
    // Only GET/HEAD page requests reach this handler:
    .serveIndexHtml(async (ctx, res) => {
        return res.templateFile(`${getBrandFromHost(ctx.host)}/index.html`, {
            title: pageTitle(ctx),                        // escaped automatically
            head: html`<link rel="canonical" href="${canonicalUrl(ctx)}" />
                ${jsonScript("app-data", preloadedState(ctx))}`,
            isRtl: activeLang(ctx) === "ar",
        }, { cacheControl: "no-cache" });
    });

// Or, zero-config for a single-tenant app without templating:
lambder.servePublicFiles().serveIndexHtml();
```

Files without template markers can opt into virtual slots (`title` = the `<title>` element, `head` = before `</head>`) with `res.templateFile(path, data, { htmlVirtualSlots: true })`. File cache policies (`cacheControl`, `immutablePattern`, `memoryCache`) are configurable via `LambderPublicFilesOptions`, and both slots take an explicit compression policy: `servePublicFiles({ compress: (ctx) => /\.(css|js|svg)$/.test(ctx.path) })` and `serveIndexHtml(handler, { compress: true })` (default "auto").
