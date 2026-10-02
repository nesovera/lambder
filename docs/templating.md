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

// ...and structured data for search engines, with the same escaping:
const ld = html`${jsonScript({ type: "application/ld+json" }, { "@context": "https://schema.org", "@type": "Store", name: "Hudson Street Books" })}`;

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

What these build is a `LambderSafeHtml`, and it is the only body `res.html`,
`res.status`, `res.status404` and `res.xml` take: a plain string there is a
compile error and throws, so a page is either built by a tag, marked trusted
with `raw()` where it can be seen, or sent as text with `res.text` (see
[Responses](./responses.md#html-bodies)).

Exports: `html`, `xml`, `raw`, `jsonScript`, `escapeHtml`, `renderHtmlValue`,
`LambderSafeHtml`, `LambderHtmlValue`.

## LambderTemplatingEngine

A standalone, comment-only HTML template engine. Every construct is an HTML
comment, so templates survive HTML build pipelines (Vite, for instance)
untouched, and where the browser reads a marker as a comment, between
elements, it shows nothing of it during frontend development and renders the
default content (what it shows elsewhere is under [The raw file in a
browser](#the-raw-file-in-a-browser)). It can template anything: SPA shells,
emails, error pages.

**Syntax** (everything is an HTML comment):

```html
<html lang="en" dir="<!--slot:dir-->ltr<!--/slot:dir-->">     <!-- a slot inside a quoted attribute value -->
<!--slot:head/-->                                           <!-- insert-only point -->
<h1><!--slot:heading-->Welcome<!--/slot:heading--></h1>     <!-- replaceable region -->
<!--if:signedIn--><a href="/account">Your account</a><!--else--><a href="/sign-in">Sign in</a><!--/if:signedIn-->
                                                            <!-- conditional, each branch whole elements -->
<!--if:!minimal--><nav>...</nav><!--/if:!minimal-->         <!-- negated conditional -->
```

The page title is not written with markers: `<title>`'s content is text to
a browser, so a marker there would show in the tab during development. Leave
the title plain (`<title>My App</title>`) and compile with
`htmlVirtualSlots: true`, which makes the `<title>` element's content the slot
`title`, and the position before `</head>` the insert-only slot `head`, for a
file that does not declare slots by those names itself. It works beside the
file's own markers.

**Usage** (standalone, importable directly from `lambder`):

```typescript
import { LambderTemplatingEngine, html, jsonScript } from "lambder";

// Compile once (throws early on unclosed/mismatched blocks) ...
const template = await LambderTemplatingEngine.fromFile("./templates/page.html", { htmlVirtualSlots: true });
// ... render many times, per request:
const output = template.render({
    title: userInput,                                         // plain values are escaped (XSS-safe)
    head: html`<link rel="canonical" href="${canonicalUrl}" />
        ${jsonScript("app-data", preloadedState)}`,           // html`...`/raw()/jsonScript() inserted verbatim
    signedIn: session !== null,                               // condition names use truthiness
    dir: lang === "ar" ? "rtl" : "ltr",
});

// The names it declares:
template.slotNames;       // e.g. ["dir", "title", "head", "heading"]
template.conditionNames;  // e.g. ["signedIn", "minimal"]
template.has("title");    // true

// A key it has no slot or condition for throws, naming the key and these names:
template.render({ titel: "About us" });   // Error: ... the data carries "titel" ...
```

The template is a file edited apart from the code that fills it, so every
render checks the data's keys against it: a slot renamed in the HTML fails the
render instead of dropping the server's content without a word. Code that
knows the names can state them, and the data is then typed to them, so a
misspelled key is a compile error as well:

```typescript
type PageNames = "dir" | "title" | "head" | "heading" | "signedIn" | "minimal";
const page = await LambderTemplatingEngine.fromFile<PageNames>("./templates/page.html", { htmlVirtualSlots: true });
page.render({ titel: "About us" });   // compile error: "titel" is not one of PageNames
```

The type parameter (on the constructor, `fromFile` and `res.templateFile`) is
optional, and it is the caller's statement about a file the compiler never
reads, so the render-time check holds either way.

Rules:

- Slot values: strings and numbers escaped; `html`, `raw()` and `jsonScript()`
  verbatim; arrays flattened
- A slot keeps its default content only for `undefined`, or for a key the data
  object does not carry at all. `null`, `false` and `""` are values, and they
  render the slot empty. So `res.templateFile("index.html", { title:
  page.seoTitle })` with a `seoTitle` that comes back `null` ships an empty
  `<title>`; write `page.seoTitle ?? undefined` when a missing value should
  fall back to the shell's own default
- A data key the template has no slot or condition for throws, naming the
  key and the template's slots and conditions. Code that fills several
  templates from one object picks each one's keys with `has()`
- Blocks nest freely; there are intentionally no loops or inline expressions:
  build dynamic lists server-side with `html` and pass them into a slot
- Attribute values (`<html dir="...">`, say) take a slot inside the quoted
  value; an if/else around whole-tag variants works rendered, and in a raw
  file only where both variants read as valid HTML side by side (see [The
  raw file in a browser](#the-raw-file-in-a-browser) and
  [Branches](#branches))
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

### The raw file in a browser

During frontend development the file is served as it is, with nothing
rendering it, so a browser reads each marker as whatever the HTML parser
makes of it where it stands. Between elements that is a comment, which shows
nothing, and a slot's default content renders. Elsewhere it is not:

- **Inside `<title>` or `<textarea>`**, whose content is text, a marker is
  text and shows: the tab would read `<!--slot:title-->My App<!--/slot:title-->`.
  The title takes the virtual slot instead (`htmlVirtualSlots`, above).
- **Inside a quoted attribute value**, a marker is part of the value. That is
  harmless where nothing shows the value (`dir="<!--slot:dir-->ltr<!--/slot:dir-->"`
  is a direction the browser does not know, so it lays the page out left to
  right), and visible where something does (a `title` or `alt` attribute).
- **Inside a tag**, where an attribute name goes (a conditional boolean
  attribute, `<input <!--if:checked-->checked<!--/if:checked--> name="a">`),
  the tag ends at the marker's `-->` and the rest of it shows as text. Such a
  template renders correctly and is broken raw.
- **An if/else** has nothing to choose a branch, so both render. Give each
  branch whole elements that read as valid HTML side by side, as the link in
  the syntax above does. Two variants of one start tag do not:
  `<!--if:isRtl--><body dir="rtl"><!--else--><body><!--/if:isRtl-->` renders
  raw as a single `<body dir="rtl">`, the parser merging the second `<body>`
  into the first, so the page is laid out right to left in development
  whatever the data. Vary the attribute with a slot inside its value instead.

## Rendering a template as a response

Inside a handler, `res.templateFile(path, data?, options?)` reads the file
through the instance's file source, compiles it once, caches the compiled
template across warm invocations, and returns the rendered HTML:

```typescript
lambder.addRoute("/about", async (ctx, res) => {
    return res.templateFile("about.html", { title: "About us" });
});
```

The data is checked against the file as above, and the error names the file.
`res.templateFile<"title" | "heading">("about.html", data)` types the data to
the file's names.

`{ htmlVirtualSlots: true }` gives a file the virtual slots (`title` is the
`<title>` element's content, `head` the position before `</head>`), beside
its own markers or without any. See
[Frontend hosting](./frontend-hosting.md#templated-shells) for the app-shell
recipe and the multi-tenant variant.
