import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
/**
 * Everything create() refuses before an instance exists, in one place: a
 * value that cannot work is a startup error naming the option, not a 404 on
 * every API call (an apiPath with no leading slash) or a 500 on every
 * response (maxResponseBytes: 0) that an app discovers in production.
 */
export const assertCreateOptions = (options) => {
    // The path is compared to ctx.path, which always starts with a slash, so
    // apiPath: "api" would make every API call a 404 with no reason given.
    if (options.apiPath !== undefined && (options.apiPath === "" || !options.apiPath.startsWith("/"))) {
        throw new Error(`Lambder: apiPath must be a path starting with "/", got ${JSON.stringify(options.apiPath)}.`);
    }
    // 0 or a negative ceiling would turn every response into the size guard's own 500.
    if (options.maxResponseBytes !== undefined)
        assertPositiveInteger(options.maxResponseBytes, "maxResponseBytes");
    // 0 or a negative bound would give up on every report before it started.
    if (options.crashes?.reportTimeoutMs !== undefined)
        assertPositiveInteger(options.crashes.reportTimeoutMs, "crashes.reportTimeoutMs");
    // Credentials with every origin allowed would echo whatever Origin asked,
    // so any website could read a signed-in user's session routes. The usual
    // reason to turn credentials on (SameSite=None cookies) is exactly the
    // setting in which that is reachable.
    const cors = options.cors;
    if (typeof cors === "object" && cors.credentials && (cors.origins === undefined || cors.origins === "*")) {
        throw new Error('Lambder: cors.credentials needs cors.origins to be an allowlist or a predicate. With every origin allowed, any website could make credentialed calls and read the answers.');
    }
    if ((options.requireSessionApiGuards || options.requirePublicApiGuards) && !options.guards) {
        const requireFlag = options.requireSessionApiGuards ? "requireSessionApiGuards" : "requirePublicApiGuards";
        throw new Error(`Lambder: ${requireFlag} needs a guards map at creation for APIs to declare from.`);
    }
};
