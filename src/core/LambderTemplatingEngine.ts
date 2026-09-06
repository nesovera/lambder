import { getFS } from "../shared/node-polyfills.js";
import { renderHtmlValue, type LambderHtmlValue } from "../shared/LambderHtml.js";

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

type TemplateNode =
    | { type: "text", value: string }
    | { type: "slot", name: string, defaultNodes: TemplateNode[] }
    | { type: "if", name: string, negated: boolean, thenNodes: TemplateNode[], elseNodes: TemplateNode[] };

type OpenFrame = {
    kind: "root" | "slot" | "if";
    name: string;
    negated: boolean;
    nodes: TemplateNode[];
    elseNodes: TemplateNode[];
    inElse: boolean;
};

const TOKEN_PATTERN = /<!--\s*(?:(slot:([\w-]+)\s*\/)|(slot:([\w-]+))|(\/slot:([\w-]+))|(if:(!?)([\w-]+))|(else)|(\/if:(!?)([\w-]+)))\s*-->/g;

/**
 * Fail loudly on slot positions where HTML escaping cannot protect against
 * injection: unquoted attribute values (`class=<!--slot:x/-->`) and inside
 * <script>/<style> elements (HTML escaping is the wrong grammar there; embed
 * data with jsonScript() into a normal slot instead).
 */
const assertSafeSlotPosition = (source: string, slotIndex: number, slotName: string): void => {
    const before = source.slice(0, slotIndex);
    if(/=\s*$/.test(before)){
        throw new Error(
            `LambderTemplatingEngine: slot "${slotName}" is in an unquoted attribute position. ` +
            `Escaping cannot prevent injection there; quote the attribute: attr="<!--slot:${slotName}/-->".`,
        );
    }
    for(const tag of ["script", "style"] as const){
        const lastOpen = before.toLowerCase().lastIndexOf(`<${tag}`);
        if(lastOpen !== -1 && before.toLowerCase().indexOf(`</${tag}`, lastOpen) === -1){
            throw new Error(
                `LambderTemplatingEngine: slot "${slotName}" is inside a <${tag}> element where HTML ` +
                `escaping does not apply. Pass data with the jsonScript() helper in a regular slot instead.`,
            );
        }
    }
};

const parseTemplate = (source: string): TemplateNode[] => {
    const root: OpenFrame = { kind: "root", name: "", negated: false, nodes: [], elseNodes: [], inElse: false };
    const stack: OpenFrame[] = [root];
    const top = (): OpenFrame => stack[stack.length - 1] as OpenFrame;
    const emit = (node: TemplateNode): void => {
        const frame = top();
        (frame.inElse ? frame.elseNodes : frame.nodes).push(node);
    };

    TOKEN_PATTERN.lastIndex = 0;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while((match = TOKEN_PATTERN.exec(source)) !== null){
        if(match.index > cursor){
            emit({ type: "text", value: source.slice(cursor, match.index) });
        }
        cursor = TOKEN_PATTERN.lastIndex;

        const [, selfClosingSlot, selfClosingName, openSlot, openSlotName, closeSlot, closeSlotName, openIf, openIfNegation, openIfName, elseTag, closeIf, closeIfNegation, closeIfName] = match;

        if(selfClosingSlot){
            assertSafeSlotPosition(source, match.index, selfClosingName as string);
            emit({ type: "slot", name: selfClosingName as string, defaultNodes: [] });
        }else if(openSlot){
            assertSafeSlotPosition(source, match.index, openSlotName as string);
            stack.push({ kind: "slot", name: openSlotName as string, negated: false, nodes: [], elseNodes: [], inElse: false });
        }else if(closeSlot){
            const frame = stack.pop();
            if(!frame || frame.kind !== "slot" || frame.name !== closeSlotName){
                throw new Error(`LambderTemplatingEngine: unexpected <!--/slot:${closeSlotName}--> (open block: ${frame ? `${frame.kind}:${frame.name}` : "none"}).`);
            }
            emit({ type: "slot", name: frame.name, defaultNodes: frame.nodes });
        }else if(openIf){
            stack.push({ kind: "if", name: openIfName as string, negated: openIfNegation === "!", nodes: [], elseNodes: [], inElse: false });
        }else if(elseTag){
            const frame = top();
            if(frame.kind !== "if" || frame.inElse){
                throw new Error("LambderTemplatingEngine: <!--else--> outside of an <!--if:...--> block.");
            }
            frame.inElse = true;
        }else if(closeIf){
            const frame = stack.pop();
            const negated = closeIfNegation === "!";
            if(!frame || frame.kind !== "if" || frame.name !== closeIfName || frame.negated !== negated){
                throw new Error(`LambderTemplatingEngine: unexpected <!--/if:${closeIfNegation}${closeIfName}--> (open block: ${frame ? `${frame.kind}:${frame.name}` : "none"}).`);
            }
            emit({ type: "if", name: frame.name, negated: frame.negated, thenNodes: frame.nodes, elseNodes: frame.elseNodes });
        }
    }
    if(cursor < source.length){
        emit({ type: "text", value: source.slice(cursor) });
    }
    if(stack.length !== 1){
        const frame = top();
        throw new Error(`LambderTemplatingEngine: unclosed <!--${frame.kind}:${frame.name}--> block.`);
    }
    return root.nodes;
};

const renderNodes = (nodes: TemplateNode[], data: LambderTemplateData): string => {
    let out = "";
    for(const node of nodes){
        if(node.type === "text"){
            out += node.value;
        }else if(node.type === "slot"){
            const value = Object.prototype.hasOwnProperty.call(data, node.name) ? data[node.name] : undefined;
            out += value === undefined ? renderNodes(node.defaultNodes, data) : renderHtmlValue(value);
        }else{
            const condition = !!data[node.name] !== node.negated;
            out += renderNodes(condition ? node.thenNodes : node.elseNodes, data);
        }
    }
    return out;
};

const collectNames = (nodes: TemplateNode[], slots: Set<string>, conditions: Set<string>): void => {
    for(const node of nodes){
        if(node.type === "slot"){
            slots.add(node.name);
            collectNames(node.defaultNodes, slots, conditions);
        }else if(node.type === "if"){
            conditions.add(node.name);
            collectNames(node.thenNodes, slots, conditions);
            collectNames(node.elseNodes, slots, conditions);
        }
    }
};

export type LambderTemplatingEngineOptions = {
    /**
     * For full HTML documents without declared markers: expose the <title>
     * element content as slot "title" and the position before </head> as
     * insert-only slot "head". Default: false.
     */
    htmlVirtualSlots?: boolean;
};

export class LambderTemplatingEngine {
    private nodes: TemplateNode[];
    /** Slot names discovered at compile time (dynamic typing surface). */
    readonly slotNames: readonly string[];
    /** Condition names discovered at compile time. */
    readonly conditionNames: readonly string[];

    /** Parse `source`; throws on unclosed or mismatched blocks. */
    constructor(source: string, options: LambderTemplatingEngineOptions = {}){
        this.nodes = parseTemplate(options.htmlVirtualSlots ? applyHtmlVirtualSlots(source) : source);
        const slots = new Set<string>();
        const conditions = new Set<string>();
        collectNames(this.nodes, slots, conditions);
        this.slotNames = [...slots];
        this.conditionNames = [...conditions];
    }

    /** Read and parse a template file (compile once, render many times). */
    static async fromFile(filePath: string, options: LambderTemplatingEngineOptions = {}): Promise<LambderTemplatingEngine> {
        const fs = await getFS();
        if(!fs) throw new Error("LambderTemplatingEngine.fromFile requires a Node.js environment.");
        const source = await fs.promises.readFile(filePath, "utf8");
        return new LambderTemplatingEngine(source, options);
    }

    /** True when the template declares `name` as a slot or condition. */
    has(name: string): boolean {
        return this.slotNames.includes(name) || this.conditionNames.includes(name);
    }

    /** Render with escaped-by-default data; unknown keys ignored, omitted slots keep defaults. */
    render(data: LambderTemplateData = {}): string {
        return renderNodes(this.nodes, data);
    }
}

/** Wrap the <title> content and the pre-</head> position in virtual slot markers. */
const applyHtmlVirtualSlots = (source: string): string => {
    let out = source;
    if(!/<!--\s*slot:title\b/.test(out)){
        out = out.replace(
            /(<title[^>]*>)([\s\S]*?)(<\/title>)/i,
            (_all, open: string, inner: string, close: string) =>
                `${open}<!--slot:title-->${inner}<!--/slot:title-->${close}`,
        );
    }
    if(!/<!--\s*slot:head\b/.test(out)){
        out = out.replace(/<\/head\s*>/i, (headClose) => `<!--slot:head/-->${headClose}`);
    }
    return out;
};
