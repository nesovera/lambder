import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
/**
 * The session fields that moved onto LambderDdbSessionStore in 7.0.0, refused
 * at creation. They are the one break the compiler cannot find: create() is
 * generic over `const TOptions`, which switches excess-property checking off
 * for the whole options object, so a leftover `partitionKey` compiles and
 * would be dropped in silence while the store fell back to its own table
 * defaults. A wrong table key is not something to discover from nobody being
 * able to log in.
 */
const MOVED_SESSION_OPTIONS = ["tableName", "tableRegion", "partitionKey", "sortKey", "compression"];
/**
 * Everything create() refuses before an instance exists.
 *
 * One place rather than five checks spread through the constructor's wiring:
 * a value that cannot work is a startup error naming the option, not a 404 on
 * every API call (an apiPath with no leading slash) or a 500 on every response
 * (maxResponseBytes: 0) that an app discovers in production.
 */
export const assertCreateOptions = (options) => {
    // The path is compared to ctx.path, which always starts with a slash, so
    // apiPath: "api" made every API call a 404 and nothing said why.
    if (options.apiPath !== undefined && (options.apiPath === "" || !options.apiPath.startsWith("/"))) {
        throw new Error(`Lambder: apiPath must be a path starting with "/", got ${JSON.stringify(options.apiPath)}.`);
    }
    // 0 or a negative ceiling turned every response into the size guard's own 500.
    if (options.maxResponseBytes !== undefined)
        assertPositiveInteger(options.maxResponseBytes, "maxResponseBytes");
    const session = options.session;
    const movedOptions = session ? MOVED_SESSION_OPTIONS.filter((key) => key in session) : [];
    if (movedOptions.length) {
        throw new Error(`Lambder: the session option no longer takes ${movedOptions.join(", ")}. `
            + "They belong to the store now: session: { store: new LambderDdbSessionStore({ tableName, region, partitionKey, sortKey, compression }), sessionSalt }.");
    }
    if ((options.requireSessionApiGuards || options.requirePublicApiGuards) && !options.guards) {
        const requireFlag = options.requireSessionApiGuards ? "requireSessionApiGuards" : "requirePublicApiGuards";
        throw new Error(`Lambder: ${requireFlag} needs a guards map at creation for APIs to declare from.`);
    }
};
