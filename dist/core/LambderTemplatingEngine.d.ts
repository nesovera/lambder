import { type LambderHtmlValue } from "../shared/LambderHtml.js";
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
