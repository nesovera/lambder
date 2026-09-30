import { isActionName, isGroupName } from "./LambderApiNames.js";

/*
 * Every Lambder caller reaches an endpoint two ways: by name,
 * `caller.api("orders.place", input)`, and by its group,
 * `caller.orders.place(input)`, with `caller.orders.place.outcome(input)`
 * for the full outcome. The second is the same call: a caller hands out, for
 * each group a contract names, an object whose actions call `api` and
 * `apiOutcome` with the name they spell. Nothing of the endpoints is needed
 * at runtime for it, so a client that imports its contract as a type alone
 * ships no endpoint list.
 */

/** The groups a contract's endpoint names hold: the part of each before its dot. */
export type LambderContractGroupsOf<TContract> =
    keyof TContract extends infer TName ? (TName extends `${infer TGroup}.${string}` ? TGroup : never) : never;

/** The endpoint names of one group. */
export type LambderContractNamesInGroup<TContract, TGroup extends string> = Extract<keyof TContract, `${TGroup}.${string}`> & string;

/** An endpoint name's action: the part after its dot. */
export type LambderContractActionOf<TName> = TName extends `${string}.${infer TAction}` ? TAction : never;

/** A call made through a group: the endpoint's name, and the arguments as the call site passed them. */
type LambderGroupCallRunner = (apiName: string, args: unknown[]) => unknown;

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
export const withApiGroupCalls = <TCaller extends object>(caller: TCaller, call: LambderGroupCallRunner, outcome: LambderGroupCallRunner): TCaller => {
    const methods = new WeakMap<(...args: unknown[]) => unknown, (...args: unknown[]) => unknown>();
    const methodOnCaller = (method: (...args: unknown[]) => unknown) => {
        let bound = methods.get(method);
        if(!bound){
            bound = (...args: unknown[]) => {
                const result = Reflect.apply(method, caller, args);
                return result === caller ? withGroups : result;
            };
            methods.set(method, bound);
        }
        return bound;
    };
    const groups = new Map<string, object>();
    const groupOf = (group: string): object => {
        let calls = groups.get(group);
        if(!calls){
            const actions = new Map<string, unknown>();
            calls = new Proxy(Object.freeze({}), {
                get: (target, action) => {
                    if(typeof action !== "string" || action in target || !isActionName(action)) return Reflect.get(target, action);
                    let endpoint = actions.get(action);
                    if(!endpoint){
                        const apiName = `${group}.${action}`;
                        endpoint = Object.freeze(Object.assign(
                            (...args: unknown[]) => call(apiName, args),
                            { outcome: (...args: unknown[]) => outcome(apiName, args) },
                        ));
                        actions.set(action, endpoint);
                    }
                    return endpoint;
                },
            });
            groups.set(group, calls);
        }
        return calls;
    };
    const withGroups: TCaller = new Proxy(caller, {
        get: (target, property) => {
            if(typeof property === "string" && !(property in target) && isGroupName(property)) return groupOf(property);
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" && property !== "constructor" ? methodOnCaller(value as (...args: unknown[]) => unknown) : value;
        },
        set: (target, property, value) => Reflect.set(target, property, value, target),
    });
    return withGroups;
};
