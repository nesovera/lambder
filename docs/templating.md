# Templating

Two standalone, zero-dependency templating tools. Both are importable directly
from `lambder` (and from `lambder/client`, since they are isomorphic) and
usable without the framework.

- **`html` / `xml` tagged templates** for building markup in TypeScript.
- **`LambderTemplatingEngine`** for rendering HTML files whose template
  constructs are HTML comments, so a build pipeline leaves them alone.

For serving those templates as an app shell, see
[Frontend hosting](./frontend-hosting.md).

## Type-safe templating (html / xml)

Tagged template literals instead of a template engine. Interpolated values are
HTML-escaped automatically, and everything is plain TypeScript, so templates
are fully type-checked and refactorable.

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

Exports: `html`, `xml`, `raw`, `jsonScript`, `escapeHtml`, `renderHtmlValue`,
`LambderSafeHtml`, `LambderHtmlValue`.

## LambderTemplatingEngine

A standalone, comment-only HTML template engine. Every construct is an HTML
comment, so templates survive HTML build pipelines (Vite, for instance)
untouched, and during frontend development the browser simply renders the
default content because the markers are invisible. It can template anything:
SPA shells, emails, error pages.

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

- Slot values: strings and numbers escaped; `html`, `raw()` and `jsonScript()`
  verbatim; arrays flattened; `null`, `undefined` and `false` keep the slot's
  default content
- Unknown data keys are ignored, so one data object can serve several
  templates with different slots
- Blocks nest freely; there are intentionally no loops or inline expressions:
  build dynamic lists server-side with `html` and pass them into a slot
- Attribute-position values (`<html lang="...">`, say) are handled with
  if/else around whole-tag variants
- Compile-time rejection of slots in unquoted attribute positions and inside
  `<script>` and `<style>` (injection safety)

## Rendering a template as a response

Inside a handler, `res.templateFile(path, data?, options?)` reads the file
through the instance's file source, compiles it once, caches the compiled
template across warm invocations, and returns the rendered HTML:

```typescript
lambder.addRoute("/about", async (ctx, res) => {
    return res.templateFile("about.html", { title: "About us" });
});
```

Files without template markers can opt into virtual slots (`title` is the
`<title>` element, `head` is the position before `</head>`) with
`{ htmlVirtualSlots: true }`. See
[Frontend hosting](./frontend-hosting.md#templated-shells) for the app-shell
recipe and the multi-tenant variant.
