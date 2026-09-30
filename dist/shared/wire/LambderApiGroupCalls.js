import { isActionName, isGroupName } from "./LambderApiNames.js";
/**
 * The caller, answering for each group a contract could name besides its
 * own members. A member the caller has (a method, a field) is always the
 * caller's; a name that could be a group (see isGroupName: an identifier no
 * caller member has) is one; anything else a runtime or a framework asks of
 * an object (then, toJSON, a symbol, `__v_isRef`) is what the caller itself
 * answers, so a caller is never mistaken for a promise, a ref or a
 * serializable record.
 *
 * A caller keeps its state in #private fields, which no property name
 * reaches, so a group may take any name its public members leave free. Such
 * a field is readable only on the caller itself, never through this proxy,
 * so a member is read and a method run on the caller; a method that returns
 * the caller (setTransport) hands back the proxy, groups and all.
 *
 * A group answers the same way one level down: an ordinary object's own
 * members (toString, valueOf, hasOwnProperty) are an ordinary object's, so
 * converting a group to a string or asking it what it holds calls no
 * endpoint; any other name that could be an action (see isActionName) is
 * one. A group is read-only, like the type that describes it.
 */
export const withApiGroupCalls = (caller, call, outcome) => {
    const methods = new WeakMap();
    const methodOnCaller = (method) => {
        let bound = methods.get(method);
        if (!bound) {
            bound = (...args) => {
                const result = Reflect.apply(method, caller, args);
                return result === caller ? withGroups : result;
            };
            methods.set(method, bound);
        }
        return bound;
    };
    const groups = new Map();
    const groupOf = (group) => {
        let calls = groups.get(group);
        if (!calls) {
            const actions = new Map();
            calls = new Proxy(Object.freeze({}), {
                get: (target, action) => {
                    if (typeof action !== "string" || action in target || !isActionName(action))
                        return Reflect.get(target, action);
                    let endpoint = actions.get(action);
                    if (!endpoint) {
                        const apiName = `${group}.${action}`;
                        endpoint = Object.freeze(Object.assign((...args) => call(apiName, args), { outcome: (...args) => outcome(apiName, args) }));
                        actions.set(action, endpoint);
                    }
                    return endpoint;
                },
            });
            groups.set(group, calls);
        }
        return calls;
    };
    const withGroups = new Proxy(caller, {
        get: (target, property) => {
            if (typeof property === "string" && !(property in target) && isGroupName(property))
                return groupOf(property);
            const value = Reflect.get(target, property, target);
            return typeof value === "function" && property !== "constructor" ? methodOnCaller(value) : value;
        },
        set: (target, property, value) => Reflect.set(target, property, value, target),
    });
    return withGroups;
};
