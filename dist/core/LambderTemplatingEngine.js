import { getFS } from "../shared/node-polyfills.js";
import { renderHtmlValue } from "../shared/LambderHtml.js";
const TOKEN_PATTERN = /<!--\s*(?:(slot:([\w-]+)\s*\/)|(slot:([\w-]+))|(\/slot:([\w-]+))|(if:(!?)([\w-]+))|(else)|(\/if:(!?)([\w-]+)))\s*-->/g;
/**
 * Fail loudly on slot positions where HTML escaping cannot protect against
 * injection: unquoted attribute values (`class=<!--slot:x/-->`) and inside
 * <script>/<style> elements (HTML escaping is the wrong grammar there; embed
 * data with jsonScript() into a normal slot instead).
 */
const assertSafeSlotPosition = (source, slotIndex, slotName) => {
    const before = source.slice(0, slotIndex);
    if (/=\s*$/.test(before)) {
        throw new Error(`LambderTemplatingEngine: slot "${slotName}" is in an unquoted attribute position. ` +
            `Escaping cannot prevent injection there; quote the attribute: attr="<!--slot:${slotName}/-->".`);
    }
    for (const tag of ["script", "style"]) {
        const lastOpen = before.toLowerCase().lastIndexOf(`<${tag}`);
        if (lastOpen !== -1 && before.toLowerCase().indexOf(`</${tag}`, lastOpen) === -1) {
            throw new Error(`LambderTemplatingEngine: slot "${slotName}" is inside a <${tag}> element where HTML ` +
                `escaping does not apply. Pass data with the jsonScript() helper in a regular slot instead.`);
        }
    }
};
const parseTemplate = (source) => {
    const root = { kind: "root", name: "", negated: false, nodes: [], elseNodes: [], inElse: false };
    const stack = [root];
    const top = () => stack[stack.length - 1];
    const emit = (node) => {
        const frame = top();
        (frame.inElse ? frame.elseNodes : frame.nodes).push(node);
    };
    TOKEN_PATTERN.lastIndex = 0;
    let cursor = 0;
    let match;
    while ((match = TOKEN_PATTERN.exec(source)) !== null) {
        if (match.index > cursor) {
            emit({ type: "text", value: source.slice(cursor, match.index) });
        }
        cursor = TOKEN_PATTERN.lastIndex;
        const [, selfClosingSlot, selfClosingName, openSlot, openSlotName, closeSlot, closeSlotName, openIf, openIfNegation, openIfName, elseTag, closeIf, closeIfNegation, closeIfName] = match;
        if (selfClosingSlot) {
            assertSafeSlotPosition(source, match.index, selfClosingName);
            emit({ type: "slot", name: selfClosingName, defaultNodes: [] });
        }
        else if (openSlot) {
            assertSafeSlotPosition(source, match.index, openSlotName);
            stack.push({ kind: "slot", name: openSlotName, negated: false, nodes: [], elseNodes: [], inElse: false });
        }
        else if (closeSlot) {
            const frame = stack.pop();
            if (!frame || frame.kind !== "slot" || frame.name !== closeSlotName) {
                throw new Error(`LambderTemplatingEngine: unexpected <!--/slot:${closeSlotName}--> (open block: ${frame ? `${frame.kind}:${frame.name}` : "none"}).`);
            }
            emit({ type: "slot", name: frame.name, defaultNodes: frame.nodes });
        }
        else if (openIf) {
            stack.push({ kind: "if", name: openIfName, negated: openIfNegation === "!", nodes: [], elseNodes: [], inElse: false });
        }
        else if (elseTag) {
            const frame = top();
            if (frame.kind !== "if" || frame.inElse) {
                throw new Error("LambderTemplatingEngine: <!--else--> outside of an <!--if:...--> block.");
            }
            frame.inElse = true;
        }
        else if (closeIf) {
            const frame = stack.pop();
            const negated = closeIfNegation === "!";
            if (!frame || frame.kind !== "if" || frame.name !== closeIfName || frame.negated !== negated) {
                throw new Error(`LambderTemplatingEngine: unexpected <!--/if:${closeIfNegation}${closeIfName}--> (open block: ${frame ? `${frame.kind}:${frame.name}` : "none"}).`);
            }
            emit({ type: "if", name: frame.name, negated: frame.negated, thenNodes: frame.nodes, elseNodes: frame.elseNodes });
        }
    }
    if (cursor < source.length) {
        emit({ type: "text", value: source.slice(cursor) });
    }
    if (stack.length !== 1) {
        const frame = top();
        throw new Error(`LambderTemplatingEngine: unclosed <!--${frame.kind}:${frame.name}--> block.`);
    }
    return root.nodes;
};
const renderNodes = (nodes, data) => {
    let out = "";
    for (const node of nodes) {
        if (node.type === "text") {
            out += node.value;
        }
        else if (node.type === "slot") {
            const value = Object.prototype.hasOwnProperty.call(data, node.name) ? data[node.name] : undefined;
            out += value === undefined ? renderNodes(node.defaultNodes, data) : renderHtmlValue(value);
        }
        else {
            const condition = !!data[node.name] !== node.negated;
            out += renderNodes(condition ? node.thenNodes : node.elseNodes, data);
        }
    }
    return out;
};
const collectNames = (nodes, slots, conditions) => {
    for (const node of nodes) {
        if (node.type === "slot") {
            slots.add(node.name);
            collectNames(node.defaultNodes, slots, conditions);
        }
        else if (node.type === "if") {
            conditions.add(node.name);
            collectNames(node.thenNodes, slots, conditions);
            collectNames(node.elseNodes, slots, conditions);
        }
    }
};
export class LambderTemplatingEngine {
    nodes;
    /** Slot names discovered at compile time (dynamic typing surface). */
    slotNames;
    /** Condition names discovered at compile time. */
    conditionNames;
    /** Parse `source`; throws on unclosed or mismatched blocks. */
    constructor(source, options = {}) {
        this.nodes = parseTemplate(options.htmlVirtualSlots ? applyHtmlVirtualSlots(source) : source);
        const slots = new Set();
        const conditions = new Set();
        collectNames(this.nodes, slots, conditions);
        this.slotNames = [...slots];
        this.conditionNames = [...conditions];
    }
    /** Read and parse a template file (compile once, render many times). */
    static async fromFile(filePath, options = {}) {
        const fs = await getFS();
        if (!fs)
            throw new Error("LambderTemplatingEngine.fromFile requires a Node.js environment.");
        const source = await fs.promises.readFile(filePath, "utf8");
        return new LambderTemplatingEngine(source, options);
    }
    /** True when the template declares `name` as a slot or condition. */
    has(name) {
        return this.slotNames.includes(name) || this.conditionNames.includes(name);
    }
    /** Render with escaped-by-default data; unknown keys ignored, omitted slots keep defaults. */
    render(data = {}) {
        return renderNodes(this.nodes, data);
    }
}
/** Wrap the <title> content and the pre-</head> position in virtual slot markers. */
const applyHtmlVirtualSlots = (source) => {
    let out = source;
    if (!/<!--\s*slot:title\b/.test(out)) {
        out = out.replace(/(<title[^>]*>)([\s\S]*?)(<\/title>)/i, (_all, open, inner, close) => `${open}<!--slot:title-->${inner}<!--/slot:title-->${close}`);
    }
    if (!/<!--\s*slot:head\b/.test(out)) {
        out = out.replace(/<\/head\s*>/i, (headClose) => `<!--slot:head/-->${headClose}`);
    }
    return out;
};
