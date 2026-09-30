import { isActionName, isGroupName, LAMBDER_API_NAME_SEGMENT } from "../shared/wire/LambderApiNames.js";
const describeName = (name) => typeof name === "string" ? `"${name}"` : String(name);
/**
 * Builds a group from its parts, refusing a name no caller could carry, an
 * action two parts declare, and a value that is not an endpoint. A group is
 * usually one part; one declared across files gives each file's part.
 */
export const buildApiGroup = (name, parts) => {
    if (typeof name !== "string" || !isGroupName(name)) {
        throw new Error(`Lambder: ${describeName(name)} cannot name a group. A group is a letter then letters, digits or underscores, ` +
            `and not a name a caller already answers for (api, apiOutcome, then, ...).`);
    }
    const apis = {};
    for (const part of parts) {
        if (part === null || typeof part !== "object") {
            throw new Error(`Lambder: a part of group "${name}" is not an object of endpoints by action name.`);
        }
        for (const [action, declaration] of Object.entries(part)) {
            if (Object.prototype.hasOwnProperty.call(apis, action)) {
                throw new Error(`Lambder: "${name}.${action}" is declared by two parts of group "${name}". Each action is declared once.`);
            }
            apis[action] = declaration;
        }
    }
    if (Object.keys(apis).length === 0) {
        throw new Error(`Lambder: group "${name}" declares no endpoints. A group is its endpoints by action name: defineApiGroup("${name}", { action: defineApi(...) }).`);
    }
    for (const [action, declaration] of Object.entries(apis)) {
        if (!isActionName(action)) {
            throw new Error(`Lambder: "${name}.${action}" cannot name an endpoint. An action is a letter then letters, digits or underscores, ` +
                `and not a name a function already answers for (then, outcome, call, ...).`);
        }
        if (declaration?.kind !== "lambderApi") {
            throw new Error(`Lambder: "${name}.${action}" is not an endpoint declaration. Declare it with the instance's defineApi().`);
        }
    }
    return { kind: "lambderApiGroup", name, apis: apis };
};
/** Builds a lazy group; the name is checked here, the group it loads when it loads. */
export const buildLazyApiGroup = (name, load) => {
    if (typeof name !== "string" || !isGroupName(name)) {
        throw new Error(`Lambder: ${describeName(name)} cannot name a group. A group is a letter then letters, digits or underscores, and not a name a caller already answers for.`);
    }
    if (typeof load !== "function")
        throw new Error(`Lambder: lazy group "${name}" has no loader. Pass a function that imports the group: () => import("./orders.js").then((m) => m.orderApis).`);
    return { kind: "lambderLazyApiGroup", name, load };
};
/** Whether a value is either kind of group registerApiGroups() takes. */
export const isRegistrableApiGroup = (value) => {
    const kind = value?.kind;
    return (kind === "lambderApiGroup" || kind === "lambderLazyApiGroup") && typeof value.name === "string" && LAMBDER_API_NAME_SEGMENT.test(value.name);
};
