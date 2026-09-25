# Templating

Two standalone, zero-dependency templating tools. Both are importable directly
from `lambder` and usable without the framework; the tagged templates come from
`lambder/client` too, since they are isomorphic.

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

Escaping protects a value in text and inside a quoted attribute value, and
nowhere else. So every call reads its own template to find where each
interpolation lands, and throws where escaping cannot protect it:

- An unquoted attribute value (`class=${x}`, `href=/users/${id}`), where a
  space in the value starts a new attribute. Quote it: `class="${x}"`.
- Inside a tag where an attribute name goes (`<input ${attributes}>`), where
  any value is a new attribute. Build the whole tag conditionally instead:
  `` ${checked ? html`<input checked>` : html`<input>`} ``.
- Inside the quoted value of an event handler (`onclick` and every other `on`
  attribute), `style` or `srcdoc`. The browser decodes the escapes and then
  reads that value as JavaScript, CSS or a whole HTML document, so
  `onclick="go('${x}')"` would run `');alert(1);//`. Pass the value in a
  `data-` attribute a script reads, or build the whole tag conditionally.
- Inside a `<script>` or `<style>` element, where HTML escaping is the wrong
  grammar. Embed data with `jsonScript()` outside the element instead.
- Inside a comment, right before a `-`, `!` or `>` that would end the comment
  after a value ending in `-`, `--` or `--!` (`<!-- ${version}> -->`). Put a
  space after the interpolation: `<!-- ${version} -->`.

The template is read the way a browser reads it, so a comment ends where the
browser ends it (at `-->` and `--!>`, and at `<!-->` or `<!--->` right where
it opens), and the content of `<title>` and `<textarea>` is text up to the
element's own end tag.

A nested `` html`...` `` fragment has to be complete markup: a call whose
template ends inside a tag, an attribute value, a comment or a `<script>`
throws, since the template around it places its values without reading it.
`raw()` content is never read, so what it holds is the author's
responsibility. The check reads the template as plain HTML, while inline SVG
and MathML read the content of `<title>`, `<textarea>` and the other
text-only elements as markup, so once such content holds a tag every value
after it is refused, past the element's end tag too; the same goes for a
CDATA section that runs past its first `>`.

A quoted URL attribute value (`href`, `src`, `action` and the rest of the
list under [LambderTemplatingEngine](#lambdertemplatingengine)'s rules) that
holds an interpolation is checked whole once rendered: unless the template's
own text before the first interpolation holds a `:`, `/`, `?` or `#`, a
scheme other than `http`, `https`, `mailto` or `tel` renders the value as
`about:invalid`. So `href="${user.website}"` is fine for a link a user gave
(`javascript:alert(document.cookie)` renders as `about:invalid`), while
`href="/users/${id}"` and `src="data:image/png;base64,${pngBase64}"` render as
written.

Two things the URL check leaves to you:

- It checks the URL attributes and nothing else that holds a URL. An SVG
  animation that sets one (`<set>` or `<animate>` with an `attributeName` of
  `href` or `xlink:href`, the URL in its `to`, `values`, `from` or `by`) and
  the `content` of `<meta http-equiv="refresh">` render whatever value they
  get, `javascript:` included. Write the scheme in the template
  (`content="0; url=https://example.com/${path}"`), or vary the whole element
  so a value never reaches those attributes.
- A relative value passes as written, and the browser resolves it against
  the page. So a root-relative value the template starts,
  `href="/${path}"`, turns protocol-relative when the value itself starts
  with `/` or `\`: `/evil.example` renders `href="//evil.example"`, a link to
  another site. Check such a value in the handler (a path that has to stay on
  the site does not start with `/` or `\`).

These rules follow the template, not the value. They hold whatever an
interpolation carries (a string, a number, a nested `` html`...` ``,
`raw()`), and for `null`, `undefined` and `false` too, so a template that
breaks one throws on its first call rather than on some later data. `xml`
applies the same rules: sitemaps, feeds and SVG attributes work as written,
and SVG, which runs script, keeps its `on` attributes and `<script>` refused
and its links checked.

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
  verbatim; arrays flattened
- A slot keeps its default content only for `undefined`, or for a key the data
  object does not carry at all. `null`, `false` and `""` are values, and they
  render the slot empty. So `res.templateFile("index.html", { title:
  page.seoTitle })` with a `seoTitle` that comes back `null` ships an empty
  `<title>`; write `page.seoTitle ?? undefined` when a missing value should
  fall back to the shell's own default
- Unknown data keys are ignored, so one data object can serve several
  templates with different slots
- Blocks nest freely; there are intentionally no loops or inline expressions:
  build dynamic lists server-side with `html` and pass them into a slot
- Attribute-position values (`<html lang="...">`, say) are handled with
  if/else around whole-tag variants (see [Branches](#branches))
- Compile-time rejection of slots in unquoted attribute positions, where an
  attribute name goes inside a tag (`<input <!--slot:x/-->>`), inside
  `<script>` and `<style>`, and inside a comment right before a `-`, `!` or
  `>` that a value ending in `--` would turn into the comment's end
  (`<!-- <!--slot:v/-->> -->`; put a space after the slot) (injection safety)
- A slot inside a quoted attribute value is escaped like any other, with two
  exceptions. The value of an event handler (`onclick` and every other `on`
  attribute), `style` or `srcdoc` is refused at compile time: the browser
  decodes the escapes and then reads that value as JavaScript, CSS or a whole
  HTML document, so `onclick="go('<!--slot:x/-->')"` would run `');alert(1);//`.
  Pass such a value in a `data-` attribute a script reads, or vary the whole
  tag with if/else. And the value of a URL attribute (`href`, `src`, `action`,
  `formaction`, `xlink:href`, `poster`, `cite`, `data`, `background`,
  `codebase`, `longdesc`, `manifest`) is checked when it renders: if the data
  can reach its scheme, because nothing the template wrote before the slot
  holds a `:`, `/`, `?` or `#`, a scheme other than `http`, `https`, `mailto`
  or `tel` renders the whole value as `about:invalid`. The scheme is read the
  way a browser reads it (case, leading spaces and control characters, tabs
  and line breaks inside ignored), and a character reference where it would be
  counts as unsafe. So `href="<!--slot:url/-->"` stays usable for a link a
  user gave, `href="/users/<!--slot:id/-->"` renders as written, and an image
  as a `data:` URL writes its scheme in the template
  (`src="data:image/png;base64,<!--slot:avatar/-->"`). What the check leaves
  to you (an SVG animation or a meta refresh that sets a URL, and a value
  that turns a root-relative URL protocol-relative) is listed under
  [`html` / `xml`](#type-safe-templating-html--xml)
- These are the rules the `html` / `xml` tagged templates apply to their
  interpolations too

### Branches

Where a slot lands must not depend on the data, so the template is read along
every way it can render. The branches of an if/else (a missing else counts as
an empty branch), and a slot's default content and its value, have to leave
the HTML in the same position (inside the same tag, the same attribute value
or the same element) by the time the next slot or block comes. Otherwise the
template refuses to compile, naming the block whose branches part. Vary whole
tags or whole elements inside the branches, not parts of one tag:

```html
<!-- Refused: whether the slot is in a title or in an onclick depends on x -->
<a <!--if:x-->title<!--else-->onclick<!--/if:x-->="<!--slot:v/-->">Open</a>

<!-- Fine: each branch holds its whole tag -->
<!--if:x--><a title="<!--slot:v/-->"><!--else--><a><!--/if:x-->Open</a>
```

A conditional boolean attribute is fine: in
`<input <!--if:checked-->checked<!--/if:checked--> name="a">` both branches
are between attributes once the space after the block is read. Keep that
space outside the block when another block follows:
`<input <!--if:a-->checked<!--/if:a--> <!--if:b-->disabled<!--/if:b-->>`
compiles, while
`<input<!--if:a--> checked<!--/if:a--><!--if:b--> disabled<!--/if:b-->>` is
refused, since one branch of the first block still ends inside the name
`checked` when the second block starts.

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
