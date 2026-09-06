import { type LambderHtmlValue } from "../shared/LambderHtml.js";
/**
 * LambderTemplatingEngine: a comment-only HTML template engine.
 *
 * Fully standalone: it has no dependency on Lambder routing or file serving,
 * and can template any HTML: app shells, emails, error pages. res.templateFile
 * uses it internally to render HTML files from publicPath per request.
 *
 * Every construct is an HTML comment. That is the whole point: templates
 * survive HTML build pipelines (e.g. Vite) untouched, and are invisible in the
 * browser during frontend development, where the default content between the
 * markers renders as-is.
 *
 * Syntax:
 *
 *   <!--slot:name-->default content<!--/slot:name-->    replaceable region;
 *                                                       default kept when the
 *                                                       data omits "name"
 *   <!--slot:name/-->                                   insert-only point
 *   <!--if:name--> ... <!--else--> ... <!--/if:name-->  conditional block,
 *                                                       shown when data.name
 *                                                       is truthy
 *   <!--if:!name--> ... <!--/if:!name-->                negated conditional
 *
 * Blocks nest freely (ifs in slots, slots in ifs). There are intentionally no
 * loops or inline expressions: dynamic lists are built server-side with the
 * html`...` tagged template and passed in as a slot value. Attribute-position
 * values (e.g. <html lang="...">) are handled with if/else around whole-tag
 * variants.
 *
 * Data is dynamically typed: one Record<string, LambderHtmlValue> shared by
 * slots and conditions.
 *   - strings/numbers are HTML-escaped on insertion (XSS-safe by default)
 *   - html`...` / raw() / jsonScript() values are inserted verbatim
 *   - arrays are flattened; null/undefined/false render the slot default
 *   - unknown data keys are ignored, so one data object can serve several
 *     templates with different slots
 *
 * Templates are parsed once (construction throws on unclosed or mismatched
 * blocks with a descriptive message); render() is a cheap tree walk, safe to
 * call per request. Discovered names are exposed on `slotNames` and
 * `conditionNames` for runtime validation.
 *
 * @example
 * ```typescript
 * import { LambderTemplatingEngine, html } from "lambder";
 *
 * const template = new LambderTemplatingEngine(`
 *     <title><!--slot:title-->My Site<!--/slot:title--></title>
 *     <!--if:isBeta--><meta name="robots" content="noindex" /><!--/if:isBeta-->
 *     <!--slot:head/-->
 * `);
 *
 * template.render({
 *     title: userInput,                                      // escaped
 *     isBeta: stage === "beta",
 *     head: html`<link rel="canonical" href="${canonical}" />`, // verbatim
 * });
 *
 * // Or load from disk (compile once, render many times):
 * const emailTemplate = await LambderTemplatingEngine.fromFile("./templates/welcome.html");
 * ```
 */
export type LambderTemplateData = Record<string, LambderHtmlValue>;
export type LambderTemplatingEngineOptions = {
    /**
     * For full HTML documents without declared markers: expose the <title>
     * element content as slot "title" and the position before </head> as
     * insert-only slot "head". Default: false.
     */
    htmlVirtualSlots?: boolean;
};
export declare class LambderTemplatingEngine {
    private nodes;
    /** Slot names discovered at compile time (dynamic typing surface). */
    readonly slotNames: readonly string[];
    /** Condition names discovered at compile time. */
    readonly conditionNames: readonly string[];
    /** Parse `source`; throws on unclosed or mismatched blocks. */
    constructor(source: string, options?: LambderTemplatingEngineOptions);
    /** Read and parse a template file (compile once, render many times). */
    static fromFile(filePath: string, options?: LambderTemplatingEngineOptions): Promise<LambderTemplatingEngine>;
    /** True when the template declares `name` as a slot or condition. */
    has(name: string): boolean;
    /** Render with escaped-by-default data; unknown keys ignored, omitted slots keep defaults. */
    render(data?: LambderTemplateData): string;
}
