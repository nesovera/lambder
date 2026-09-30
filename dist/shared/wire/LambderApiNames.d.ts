/**
 * How an endpoint is named and where it is called. An endpoint belongs to a
 * group, and its name is the two joined by a dot: `orders.place`. Both are
 * identifiers, so the name is also a path: a call posts to
 * `{apiPath}/{group}/{action}`, which a gateway, a CDN and a log can meter,
 * limit and read per endpoint without opening the body.
 *
 * The group is also a property of every Lambder caller
 * (`caller.orders.place(input)`), so a group may not be named like anything a
 * caller already has.
 */
/** A group's or an action's name: a letter, then letters, digits or underscores. */
export declare const LAMBDER_API_NAME_SEGMENT: RegExp;
/**
 * Every public member of the three callers a group becomes a property of
 * (LambderCaller, LambderInvokeCaller, LambderTestVisitor), since a caller
 * looks a group up only after its own members. Their state is #private,
 * which no property name reaches, so only these can stand in a group's way.
 * A test holds this to the callers' public members, in their types and at
 * runtime, both ways.
 */
export declare const LAMBDER_CALLER_MEMBER_NAMES: readonly ["api", "apiOutcome", "caller", "clientIp", "fetchTrackerList", "host", "isLoading", "jar", "request", "setSessionCookieKey", "setTransport", "signIn"];
/**
 * Names no group may take: the callers' members, and what a JavaScript
 * runtime, a promise check, a serializer or a framework asks of any object.
 */
export declare const LAMBDER_RESERVED_GROUP_NAMES: readonly ["api", "apiOutcome", "caller", "clientIp", "fetchTrackerList", "host", "isLoading", "jar", "request", "setSessionCookieKey", "setTransport", "signIn", "constructor", "then", "catch", "finally", "toJSON", "toString", "valueOf", "toLocaleString", "prototype", "inspect", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable"];
/** A name no group may take; see LAMBDER_RESERVED_GROUP_NAMES. */
export type LambderReservedGroupName = typeof LAMBDER_RESERVED_GROUP_NAMES[number];
/**
 * Names no action may take: what a runtime, a promise check or a serializer
 * asks of a group or of the function a caller hands out for an action, and
 * the members every object has (toString, valueOf, hasOwnProperty), which a
 * group keeps as its own.
 */
export declare const LAMBDER_RESERVED_ACTION_NAMES: readonly ["then", "catch", "finally", "toJSON", "constructor", "prototype", "outcome", "bind", "call", "apply", "length", "name", "arguments", "caller", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable"];
/** A name no action may take; see LAMBDER_RESERVED_ACTION_NAMES. */
export type LambderReservedActionName = typeof LAMBDER_RESERVED_ACTION_NAMES[number];
/** Whether a name can be a group: an identifier segment, and not one a caller already answers for. */
export declare const isGroupName: (name: string) => boolean;
/** Whether a name can be an action of a group: an identifier segment, and not one a function already answers for. */
export declare const isActionName: (name: string) => boolean;
/** An endpoint's name split into its group and action, or null for a name that is not two segments. */
export declare const splitApiName: (apiName: string) => {
    group: string;
    action: string;
} | null;
/** Where a call to the endpoint goes: `{apiPath}/{group}/{action}`. An apiPath may be absolute (another origin) or end with a slash. */
export declare const apiCallPath: (apiPath: string, apiName: string) => string;
/**
 * The endpoint a request path calls, or null when the path is not a call
 * under apiPath: exactly `{apiPath}/{group}/{action}`, with no query, no
 * trailing slash and no further segment.
 */
export declare const apiNameOfCallPath: (apiPath: string, path: string) => string | null;
