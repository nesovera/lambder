/**
 * Type-safe templating via tagged template literals: interpolated values are
 * HTML-escaped by default, so templates are XSS-safe and fully type-checked by
 * TypeScript (no untyped template-locals bag like EJS).
 *
 * - strings/numbers are escaped
 * - null/undefined/booleans render as "" (enables `${cond && html`...`}`)
 * - arrays are flattened (`${items.map((i) => html`<li>${i}</li>`)}`)
 * - nested html`...` fragments are inserted verbatim (no double escaping)
 * - raw(value) marks a trusted string as safe; never pass user input to it
 *
 * The same escaping rules are valid XML, so `xml` is an alias for sitemaps etc.
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
export const html = (strings, ...values) => {
    let out = "";
    for (let i = 0; i < strings.length; i++) {
        out += strings[i];
        if (i < values.length)
            out += renderHtmlValue(values[i]);
    }
    return new LambderSafeHtml(out);
};
/** Alias of html for XML documents (identical, XML-valid escaping). */
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
