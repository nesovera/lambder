import { HtmlPositionReader, RAW_TEXT_ELEMENTS, URL_ATTRIBUTE_NAMES, safeUrlValue, valueLanguageOf } from "./LambderHtmlPositions.js";
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
export class LambderSafeHtml {
    value;
    constructor(value) { this.value = value; }
    toString() { return this.value; }
}
export const escapeHtml = (value) => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
/** Serialize any LambderHtmlValue to a string (escaped unless marked safe). */
export const renderHtmlValue = (value) => {
    if (value === null || value === undefined || typeof value === "boolean")
        return "";
    if (value instanceof LambderSafeHtml)
        return value.value;
    if (Array.isArray(value))
        return value.map(renderHtmlValue).join("");
    if (typeof value === "number")
        return String(value);
    return escapeHtml(value);
};
/** Template text, quoted to name a place in an error message: its last 40 characters when it is longer. */
const quoteTemplateEnd = (text) => JSON.stringify(text.length > 40 ? `...${text.slice(-40)}` : text);
/** The interpolation at `index`, named in an error message by the template text just before it. */
const describeInterpolation = (strings, index) => `the interpolation after ${quoteTemplateEnd(strings.slice(0, index + 1).join("${...}"))}`;
export const html = (strings, ...values) => {
    const positions = new HtmlPositionReader();
    let out = "";
    // A quoted URL attribute value holding an interpolation, collected from
    // its opening quote to its closing one so safeUrlValue reads it whole.
    let urlValue = null;
    for (let index = 0; index < strings.length; index += 1) {
        const piece = strings[index];
        positions.read(piece);
        // With no branches to join, only a value in a comment can leave the
        // reader undecided: the one just before this piece.
        if (positions.undecidable) {
            throw new Error(`html\`...\`: ${describeInterpolation(strings, index - 1)} is inside a comment, right before text that ends the comment ` +
                `or not depending on how the value ends ("-", "--" or "--!" before a ">"). Put a space after the interpolation.`);
        }
        let text = piece;
        if (urlValue) {
            const end = text.indexOf(urlValue.quote);
            if (end === -1) {
                urlValue.url += text;
                text = "";
            }
            else {
                out += safeUrlValue(urlValue.url + text.slice(0, end), urlValue.firstValueIndex);
                urlValue = null;
                text = text.slice(end);
            }
        }
        if (index === values.length) {
            out += text;
            break;
        }
        const point = positions.point();
        if (point.position === "afterEquals" || point.position === "unquoted") {
            throw new Error(`html\`...\`: ${describeInterpolation(strings, index)} is in an unquoted attribute position. ` +
                `Escaping cannot prevent injection there; quote the attribute: attr="\${value}".`);
        }
        if (point.position === "tag") {
            throw new Error(`html\`...\`: ${describeInterpolation(strings, index)} is inside a tag where an attribute name goes. ` +
                `Escaping cannot prevent injection there; put the value inside a quoted attribute value, or build the whole tag ` +
                `conditionally: \${checked ? html\`<input checked>\` : html\`<input>\`}.`);
        }
        const valueLanguage = point.position === "quoted" ? valueLanguageOf(point.attributeName) : null;
        if (valueLanguage) {
            throw new Error(`html\`...\`: ${describeInterpolation(strings, index)} is inside the ${point.attributeName} attribute, whose value the browser ` +
                `reads as ${valueLanguage} once it has decoded the HTML escapes, so escaping cannot prevent injection there. ` +
                `Pass the value in a data- attribute a script reads, or build the whole tag conditionally.`);
        }
        if (point.position === "rawText" && RAW_TEXT_ELEMENTS.has(point.tagName)) {
            throw new Error(`html\`...\`: ${describeInterpolation(strings, index)} is inside a <${point.tagName}> element where HTML ` +
                `escaping does not apply. Pass data with the jsonScript() helper outside the element instead.`);
        }
        if (point.position === "rawText") {
            throw new Error(`html\`...\`: ${describeInterpolation(strings, index)} comes after <${point.tagName}> content that inline SVG and ` +
                `MathML read apart from plain HTML (a tag inside a text-only element, or a CDATA section), so where the value lands ` +
                `is not known. Write that content as text, with its "<" escaped as &lt;, and leave CDATA sections out: values are escaped anyway.`);
        }
        // A URL value no interpolation has opened yet opens in this piece,
        // and holds no quote of its kind before this interpolation, so its
        // opening quote is the last one in the text.
        if (!urlValue && point.position === "quoted" && URL_ATTRIBUTE_NAMES.has(point.attributeName)) {
            const start = text.lastIndexOf(point.quote) + 1;
            out += text.slice(0, start);
            text = text.slice(start);
            urlValue = { url: "", firstValueIndex: text.length, quote: point.quote, attributeName: point.attributeName };
        }
        positions.skipValue();
        const rendered = text + renderHtmlValue(values[index]);
        if (urlValue)
            urlValue.url += rendered;
        else
            out += rendered;
    }
    if (urlValue) {
        throw new Error(`html\`...\`: ${describeInterpolation(strings, values.length - 1)} is inside a quoted ` +
            `${urlValue.attributeName} value that never closes.`);
    }
    if (!positions.inPlainText) {
        throw new Error(`html\`...\`: the template ${quoteTemplateEnd(strings.join("${...}"))} ends inside markup it opened (a tag, an attribute ` +
            `value, a comment, or the content of a <script>, <title> or other text-only element), or after content inline SVG and ` +
            `MathML read apart from plain HTML. A template it is inserted into places its own values without reading it, so it has ` +
            `to be complete markup.`);
    }
    return new LambderSafeHtml(out);
};
/** Alias of html for XML documents (the same XML-valid escaping and position rules). */
export const xml = html;
/** Mark a trusted string as safe (inserted without escaping). Never pass user input. */
export const raw = (value) => new LambderSafeHtml(value);
/**
 * Server-preloaded state as <script type="application/json" id="..."> so an SPA
 * can hydrate without a first fetch. Escaped so the payload can't break out of
 * the script element. Read with JSON.parse(document.getElementById(id).textContent).
 */
export const jsonScript = (id, data) => {
    const json = JSON.stringify(data)
        .replace(/</g, "\\u003c")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
    return new LambderSafeHtml(`<script type="application/json" id="${escapeHtml(id)}">${json}</script>`);
};
