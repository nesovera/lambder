/**
 * Type-safe templating via tagged template literals: interpolated values are
 * HTML-escaped by default, so templates are XSS-safe and fully type-checked by
 * TypeScript (no untyped template-locals bag like EJS).
 *
 * - strings/numbers are escaped
 * - null/undefined/booleans render as "" (enables `${cond && html`...`}`)
 * - arrays are flattened (`${items.map((i) => html`<li>${i}</li>`)}`)
 * - nested html`...` fragments are inserted verbatim (no double escaping),
 *   wherever the position rules below let a value go
 * - raw(value) marks a trusted string as safe; never pass user input to it
 *
 * Escaping protects a value in text and inside a quoted attribute value, so
 * each call reads its own static strings to find where every interpolation
 * lands, and throws where escaping cannot protect it:
 * - an unquoted attribute value (`class=${x}`, with or without a prefix
 *   before the interpolation), where a space in the value starts a new
 *   attribute;
 * - inside a tag where an attribute name goes (`<input ${x}>`), where any
 *   value is a new attribute;
 * - inside the quoted value of an event handler, `style` or `srcdoc`, which
 *   the browser reads as JavaScript, CSS or a whole document once it has
 *   decoded the escapes: `onclick="go('${x}')"` would run `');alert(1);//`;
 * - inside a <script> or <style> element, where HTML escaping is the wrong
 *   grammar (embed data with jsonScript() outside it instead);
 * - inside a comment and right before a `-`, `!` or `>` that, after a value
 *   ending in `-`, `--` or `--!`, would end the comment there;
 * - after a tag inside a <title>, <textarea> or other text-only element, or
 *   after a CDATA section that runs past its first `>`, where inline SVG and
 *   MathML read the template apart from plain HTML.
 * A call whose template ends anywhere but in plain text throws as well: a
 * nested fragment is inserted without being read, so one that ends inside a
 * tag, an attribute value, a comment or a script would move every value the
 * template around it places after it.
 * Quote the attribute, pass what a script needs in a data- attribute, or
 * build the whole tag conditionally
 * (`${checked ? html`<input checked>` : html`<input>`}`). And a quoted URL
 * attribute value (href, src, action and the rest of URL_ATTRIBUTE_NAMES)
 * holding an interpolation is checked whole once rendered: unless the
 * template's own text before the first interpolation holds a `:`, `/`, `?`
 * or `#`, a scheme other than http, https, mailto or tel renders the value
 * as `about:invalid`. So `href="${user.website}"` stays usable for a link a
 * user gave, and `href="/users/${id}"` renders as written.
 *
 * These rules follow the template, not the value: they hold whatever an
 * interpolation carries (a string, a number, a nested html`...`, raw()), and
 * for one that renders "" too, so a call site that breaks one throws on every
 * call rather than on some data.
 *
 * The escaping is valid XML, and the rules hold for SVG, which runs script
 * too, so `xml` is an alias for sitemaps, feeds and SVG.
 */
export declare class LambderSafeHtml {
    readonly value: string;
    constructor(value: string);
    toString(): string;
}
export type LambderHtmlValue = string | number | boolean | null | undefined | LambderSafeHtml | LambderHtmlValue[];
export declare const escapeHtml: (value: string) => string;
/** Serialize any LambderHtmlValue to a string (escaped unless marked safe). */
export declare const renderHtmlValue: (value: LambderHtmlValue) => string;
export declare const html: (strings: TemplateStringsArray, ...values: LambderHtmlValue[]) => LambderSafeHtml;
/** Alias of html for XML documents (the same XML-valid escaping and position rules). */
export declare const xml: (strings: TemplateStringsArray, ...values: LambderHtmlValue[]) => LambderSafeHtml;
/** Mark a trusted string as safe (inserted without escaping). Never pass user input. */
export declare const raw: (value: string) => LambderSafeHtml;
/**
 * Server-preloaded state as <script type="application/json" id="..."> so an SPA
 * can hydrate without a first fetch. Escaped so the payload can't break out of
 * the script element. Read with JSON.parse(document.getElementById(id).textContent).
 */
export declare const jsonScript: (id: string, data: unknown) => LambderSafeHtml;
