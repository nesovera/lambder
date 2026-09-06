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
/** Alias of html for XML documents (identical, XML-valid escaping). */
export declare const xml: (strings: TemplateStringsArray, ...values: LambderHtmlValue[]) => LambderSafeHtml;
/** Mark a trusted string as safe (inserted without escaping). Never pass user input. */
export declare const raw: (value: string) => LambderSafeHtml;
/**
 * Server-preloaded state as <script type="application/json" id="..."> so an SPA
 * can hydrate without a first fetch. Escaped so the payload can't break out of
 * the script element. Read with JSON.parse(document.getElementById(id).textContent).
 */
export declare const jsonScript: (id: string, data: unknown) => LambderSafeHtml;
