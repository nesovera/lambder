import { type LambderHtmlValue } from "../shared/LambderHtml.js";
/**
 * What a template renders with: a value per slot or condition name. TNames,
 * when given, is the template's names, so a key outside them is a compile
 * error; left out, any name is accepted here and checked at render.
 */
export type LambderTemplateData<TNames extends string = string> = {
    [Name in TNames]?: LambderHtmlValue;
};
export type LambderTemplatingEngineOptions = {
    /**
     * For full HTML documents without declared markers: expose the <title>
     * element content as slot "title" and the position before </head> as
     * insert-only slot "head". Default: false.
     */
    htmlVirtualSlots?: boolean;
};
/**
 * A comment-only HTML template, compiled once. TNames is the caller's
 * statement of its slot and condition names, which types render()'s data;
 * left out, any name compiles, and render() checks every key either way.
 */
export declare class LambderTemplatingEngine<TNames extends string = string> {
    private nodes;
    /** Every slot and condition name: what a data key has to be one of. */
    private names;
    /** Slot names discovered at compile time. */
    readonly slotNames: readonly string[];
    /** Condition names discovered at compile time. */
    readonly conditionNames: readonly string[];
    /** Parse `source`; throws on unclosed or mismatched blocks. */
    constructor(source: string, options?: LambderTemplatingEngineOptions);
    /** Read and parse a template file (compile once, render many times). */
    static fromFile<TNames extends string = string>(filePath: string, options?: LambderTemplatingEngineOptions): Promise<LambderTemplatingEngine<TNames>>;
    /** True when the template declares `name` as a slot or condition. */
    has(name: string): boolean;
    /**
     * Render with escaped-by-default data; omitted slots keep their defaults.
     * Throws for a key the template has no slot or condition for, naming it
     * and the template's names.
     */
    render(data?: LambderTemplateData<TNames>): string;
}
