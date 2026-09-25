import { getFS } from "../shared/util/LambderNodeModules.js";
import { renderHtmlValue, type LambderHtmlValue } from "../shared/LambderHtml.js";
import { HtmlPositionReader, URL_ATTRIBUTE_NAMES, safeUrlValue, valueLanguageOf, type HtmlPoint } from "../shared/LambderHtmlPositions.js";

/*
 * LambderTemplatingEngine: a comment-only HTML template engine.
 *
 * Fully standalone: it has no dependency on Lambder routing or file serving,
 * and can template any HTML: app shells, emails, error pages. res.templateFile
 * uses it internally to render HTML files from the files source per request.
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
 * variants, or with a slot inside a quoted value: refused in an event
 * handler, `style` or `srcdoc`, whose values the browser reads as another
 * language, and checked in a URL attribute, whose value renders as
 * `about:invalid` when a slot gave it a scheme other than http, https,
 * mailto or tel. The branches of an if/else, and a slot's default content
 * and its value, have to leave the HTML in the same position (inside the
 * same tag, value or element) before the next slot or block, so a slot's
 * position never depends on the data.
 *
 * Data is dynamically typed: one Record<string, LambderHtmlValue> shared by
 * slots and conditions.
 *   - strings/numbers are HTML-escaped on insertion (XSS-safe by default)
 *   - html`...` / raw() / jsonScript() values are inserted verbatim, never
 *     escaped again (an html`...` value placed its own interpolations when it
 *     was built), and the slot's position rules above hold for them as well
 *   - arrays are flattened
 *   - only `undefined` (or a key the data does not carry) keeps a slot's
 *     default content; `null`, `false` and `""` render it empty, so write
 *     `value ?? undefined` when a missing value should fall back to the
 *     default instead
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
    | { type: "if", name: string, negated: boolean, thenNodes: TemplateNode[], elseNodes: TemplateNode[] }
    /** A quoted URL attribute value holding a slot, between its quotes: rendered whole, then checked (safeUrlValue). */
    | { type: "urlValue", nodes: TemplateNode[] };

type OpenFrame = {
    kind: "root" | "slot" | "if" | "urlValue";
    name: string;
    negated: boolean;
    nodes: TemplateNode[];
    elseNodes: TemplateNode[];
    inElse: boolean;
};

const TOKEN_PATTERN = /<!--\s*(?:(slot:([\w-]+)\s*\/)|(slot:([\w-]+))|(\/slot:([\w-]+))|(if:(!?)([\w-]+))|(else)|(\/if:(!?)([\w-]+)))\s*-->/g;

/**
 * Fail loudly on slot positions where HTML escaping cannot protect against
 * injection:
 * - an unquoted attribute value (`class=<!--slot:x/-->`, with or without a
 *   prefix before the slot), where a space in the value starts a new
 *   attribute;
 * - inside a tag where an attribute name goes (`<input <!--slot:x/-->>`),
 *   where any value is a new attribute;
 * - inside the quoted value of an event handler, `style` or `srcdoc`, which
 *   the browser reads as another language (see valueLanguageOf);
 * - inside <script>/<style> elements (HTML escaping is the wrong grammar
 *   there; embed data with jsonScript() into a normal slot instead).
 * Attribute values vary through if/else around whole-tag variants, or a
 * slot inside a quoted value.
 */
const assertSafeSlotPosition = (point: HtmlPoint, slotName: string): void => {
    if(point.position === "afterEquals" || point.position === "unquoted"){
        throw new Error(
            `LambderTemplatingEngine: slot "${slotName}" is in an unquoted attribute position. ` +
            `Escaping cannot prevent injection there; quote the attribute: attr="<!--slot:${slotName}/-->".`,
        );
    }
    if(point.position === "tag"){
        throw new Error(
            `LambderTemplatingEngine: slot "${slotName}" is inside a tag where an attribute name goes. ` +
            `Escaping cannot prevent injection there; put the slot inside a quoted value, or vary the whole tag with <!--if:...-->.`,
        );
    }
    const valueLanguage = point.position === "quoted" ? valueLanguageOf(point.attributeName) : null;
    if(valueLanguage){
        throw new Error(
            `LambderTemplatingEngine: slot "${slotName}" is inside the ${point.attributeName} attribute, whose value the browser ` +
            `reads as ${valueLanguage} once it has decoded the HTML escapes, so escaping cannot prevent injection there. ` +
            `Pass the value in a data- attribute a script reads, or vary the whole tag with <!--if:...-->.`,
        );
    }
    if(point.position === "rawText"){
        throw new Error(
            `LambderTemplatingEngine: slot "${slotName}" is inside a <${point.tagName}> element where HTML ` +
            `escaping does not apply. Pass data with the jsonScript() helper in a regular slot instead.`,
        );
    }
};

/** Where a point sits, in the words of a refusal. */
const describePoint = (point: HtmlPoint): string => {
    switch(point.position){
        case "text": return "in text";
        case "comment": return "in a comment";
        case "tag": return "inside a tag where an attribute name goes";
        case "afterEquals":
        case "unquoted": return `in the unquoted ${point.attributeName} value`;
        case "quoted": return `in the quoted ${point.attributeName} value`;
        case "rawText": return `inside a <${point.tagName}> element`;
    }
};

/** What a refusal of branches that leave the template in different positions tells the author to do. */
const BRANCH_ADVICE = "Vary the whole tag or element inside the branches instead, so every branch ends where the others do.";

/** A quoted URL value holding a slot, as source indexes: from just after its opening quote to its closing quote. */
type UrlValueRange = { start: number; end: number; attributeName: string };

/** A block the position walk in parseTemplate is inside. */
type WalkBlock = {
    /** The block's opening token as written: what a refusal names. */
    opening: string;
    /** "if:name", "if:!name" or "slot:name": what its closing token has to name. */
    key: string;
    /** The reading the second branch starts from: an if's else branch (empty without an <!--else-->), or a slot's value. */
    secondStart: HtmlPositionReader;
    /** The reading where an if's then branch ended, once its <!--else--> is read. */
    firstEnd: HtmlPositionReader | null;
};

const parseTemplate = (source: string): TemplateNode[] => {
    const tokens = [...source.matchAll(TOKEN_PATTERN)];

    // Every slot's position is checked before the tree is built, which also
    // finds the URL values holding one: the tree wraps each such value in a
    // node of its own, so a render can check the value whole.
    //
    // The HTML is read in one pass along the template's own structure, with
    // the tokens left out: they are not HTML, and inside a tag the ">" that
    // ends <!--if:x--> would otherwise read as the tag's end. Each branch of
    // an if is read from where the block starts, a missing else being an
    // empty branch, and a slot with default content is a block whose
    // branches are the default and the value. After a block, the text that
    // follows is read in both resulting readings until they sit at the same
    // position and join, and they have to before the next block, or which
    // position the next block's branches start from would depend on the
    // data. A slot met while they are still apart passes only when it lands
    // alike in both. Each character is read at most twice, whatever the
    // nesting. Malformed nesting stops the walk, and the build below refuses
    // it by name.
    const urlValues = new Map<number, UrlValueRange>();
    let readings = [new HtmlPositionReader()];
    let apartSince = "";
    const blocks: WalkBlock[] = [];
    const readOn = (text: string): void => {
        for(const reading of readings){
            reading.read(text);
            const undecidable = reading.undecidable;
            if(undecidable?.reason === "commentValue"){
                throw new Error(
                    `LambderTemplatingEngine: slot "${undecidable.label}" is inside a comment, right before text that ends the comment ` +
                    `or not depending on how the value ends ("-", "--" or "--!" before a ">"). Put a space after the slot.`,
                );
            }
            if(undecidable){
                throw new Error(
                    `LambderTemplatingEngine: the branches of ${undecidable.label} end after different attribute names, and the "=" ` +
                    `after them would give its value to a different attribute in each. ${BRANCH_ADVICE}`,
                );
            }
        }
        if(readings.length === 2 && readings[0]!.joinWith(readings[1]!, apartSince)) readings = [readings[0]!];
    };
    const requireOneReading = (token: string): HtmlPositionReader => {
        if(readings.length === 1) return readings[0]!;
        const [first, second] = readings.map((reading) => describePoint(reading.point()));
        throw new Error(
            `LambderTemplatingEngine: the branches of ${apartSince} leave the template in different positions` +
            `${first === second ? "" : ` (${first} after one, ${second} after the other)`}, and ${token} comes before they meet again. ` +
            BRANCH_ADVICE,
        );
    };
    let readCursor = 0;
    let walkedToEnd = true;
    for(const token of tokens){
        readOn(source.slice(readCursor, token.index));
        readCursor = token.index + token[0].length;
        const [, , selfClosingName, openSlot, openSlotName, closeSlot, closeSlotName, openIf, openIfNegation, openIfName, elseTag, , closeIfNegation, closeIfName] = token;
        const slotName = selfClosingName ?? openSlotName;
        if(slotName !== undefined){
            const [point, otherPoint] = readings.map((reading) => reading.point()) as [HtmlPoint, HtmlPoint?];
            if(otherPoint && (otherPoint.position !== point.position || otherPoint.attributeName !== point.attributeName
                || otherPoint.quote !== point.quote || otherPoint.tagName !== point.tagName)){
                throw new Error(
                    `LambderTemplatingEngine: slot "${slotName}" comes after ${apartSince}, whose branches leave the template in different ` +
                    `positions: the slot is ${describePoint(point)} after one, ${describePoint(otherPoint)} after the other. ${BRANCH_ADVICE}`,
                );
            }
            assertSafeSlotPosition(point, slotName);
            if(point.position === "quoted" && URL_ATTRIBUTE_NAMES.has(point.attributeName)){
                // No token holds a quote character, so the nearest quotes
                // around the slot are its value's own. A quote only one
                // branch holds leaves that block crossing the value's edge,
                // which the build below refuses.
                const start = source.lastIndexOf(point.quote, token.index) + 1;
                const end = source.indexOf(point.quote, token.index);
                if(end === -1){
                    throw new Error(`LambderTemplatingEngine: slot "${slotName}" is inside a quoted ${point.attributeName} value that never closes.`);
                }
                urlValues.set(start, { start, end, attributeName: point.attributeName });
            }
            if(openSlot){
                const valueReading = requireOneReading(token[0]).copy();
                valueReading.skipValue(slotName);
                blocks.push({ opening: token[0], key: `slot:${slotName}`, secondStart: valueReading, firstEnd: null });
            }else{
                for(const reading of readings) reading.skipValue(slotName);
            }
            continue;
        }
        if(openIf){
            blocks.push({ opening: token[0], key: `if:${openIfNegation}${openIfName}`, secondStart: requireOneReading(token[0]).copy(), firstEnd: null });
            continue;
        }
        const block = blocks.pop();
        const closingKey = closeSlot ? `slot:${closeSlotName}` : `if:${closeIfNegation}${closeIfName}`;
        if(!block || (elseTag ? !block.key.startsWith("if:") || block.firstEnd !== null : block.key !== closingKey)){
            walkedToEnd = false;
            break;
        }
        const reading = requireOneReading(token[0]);
        if(elseTag){
            block.firstEnd = reading;
            readings = [block.secondStart];
            blocks.push(block);
            continue;
        }
        readings = block.firstEnd ? [block.firstEnd, reading] : [reading, block.secondStart];
        apartSince = block.opening;
    }
    if(walkedToEnd) readOn(source.slice(readCursor));

    // In source order already: the values were met in token order, and two
    // never overlap.
    const boundaries = [...urlValues.values()].flatMap((range) => [
        { index: range.start, range, opens: true },
        { index: range.end, range, opens: false },
    ]);

    const root: OpenFrame = { kind: "root", name: "", negated: false, nodes: [], elseNodes: [], inElse: false };
    const stack: OpenFrame[] = [root];
    const top = (): OpenFrame => stack[stack.length - 1] as OpenFrame;
    const emit = (node: TemplateNode): void => {
        const frame = top();
        (frame.inElse ? frame.elseNodes : frame.nodes).push(node);
    };
    let cursor = 0;
    const emitTextUpTo = (index: number): void => {
        if(index > cursor) emit({ type: "text", value: source.slice(cursor, index) });
        cursor = index;
    };
    let nextBoundary = 0;
    const passBoundariesUpTo = (index: number): void => {
        for(; nextBoundary < boundaries.length && boundaries[nextBoundary]!.index <= index; nextBoundary += 1){
            const { index: boundaryIndex, range, opens } = boundaries[nextBoundary]!;
            emitTextUpTo(boundaryIndex);
            if(opens){
                stack.push({ kind: "urlValue", name: range.attributeName, negated: false, nodes: [], elseNodes: [], inElse: false });
                continue;
            }
            const frame = stack.pop()!;
            if(frame.kind !== "urlValue"){
                throw new Error(
                    `LambderTemplatingEngine: <!--${frame.kind}:${frame.name}--> opens inside a quoted ${range.attributeName} value holding a slot ` +
                    `and closes outside it. Keep the block wholly inside the value, or the value wholly inside the block.`,
                );
            }
            emit({ type: "urlValue", nodes: frame.nodes });
        }
    };

    for(const match of tokens){
        passBoundariesUpTo(match.index);
        emitTextUpTo(match.index);
        cursor = match.index + match[0].length;

        const [, selfClosingSlot, selfClosingName, openSlot, openSlotName, closeSlot, closeSlotName, openIf, openIfNegation, openIfName, elseTag, closeIf, closeIfNegation, closeIfName] = match;

        if((closeSlot || elseTag || closeIf) && top().kind === "urlValue"){
            throw new Error(
                `LambderTemplatingEngine: ${match[0]} belongs to a block opened outside the quoted ${top().name} value holding a slot it sits in. ` +
                `Keep the block wholly inside the value, or the value wholly inside the block.`,
            );
        }
        if(selfClosingSlot){
            emit({ type: "slot", name: selfClosingName as string, defaultNodes: [] });
        }else if(openSlot){
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
    passBoundariesUpTo(source.length);
    emitTextUpTo(source.length);
    if(stack.length !== 1){
        const frame = top();
        throw new Error(`LambderTemplatingEngine: unclosed <!--${frame.kind}:${frame.name}--> block.`);
    }
    return root.nodes;
};

/** What a render writes into: the HTML so far, and where in it the first value from the data landed (-1 until one has). */
type RenderOutput = { html: string; firstDataIndex: number };

const renderNodes = (nodes: TemplateNode[], data: LambderTemplateData, output: RenderOutput): void => {
    for(const node of nodes){
        if(node.type === "text"){
            output.html += node.value;
        }else if(node.type === "slot"){
            const value = Object.prototype.hasOwnProperty.call(data, node.name) ? data[node.name] : undefined;
            if(value === undefined){
                renderNodes(node.defaultNodes, data, output);
            }else{
                if(output.firstDataIndex === -1) output.firstDataIndex = output.html.length;
                output.html += renderHtmlValue(value);
            }
        }else if(node.type === "urlValue"){
            // Rendered on its own, so the check reads the value whole and
            // knows which part of it the template wrote.
            const value: RenderOutput = { html: "", firstDataIndex: -1 };
            renderNodes(node.nodes, data, value);
            output.html += safeUrlValue(value.html, value.firstDataIndex);
        }else{
            // Own properties only, the same lookup the slot branch uses:
            // through the prototype, <!--if:toString--> would be true on
            // every render.
            const value = Object.prototype.hasOwnProperty.call(data, node.name) ? data[node.name] : undefined;
            const condition = !!value !== node.negated;
            renderNodes(condition ? node.thenNodes : node.elseNodes, data, output);
        }
    }
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
        }else if(node.type === "urlValue"){
            collectNames(node.nodes, slots, conditions);
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
        if(!fs) throw new Error("Lambder: LambderTemplatingEngine.fromFile requires a Node.js environment.");
        const source = await fs.promises.readFile(filePath, "utf8");
        return new LambderTemplatingEngine(source, options);
    }

    /** True when the template declares `name` as a slot or condition. */
    has(name: string): boolean {
        return this.slotNames.includes(name) || this.conditionNames.includes(name);
    }

    /** Render with escaped-by-default data; unknown keys ignored, omitted slots keep defaults. */
    render(data: LambderTemplateData = {}): string {
        const output: RenderOutput = { html: "", firstDataIndex: -1 };
        renderNodes(this.nodes, data, output);
        return output.html;
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
