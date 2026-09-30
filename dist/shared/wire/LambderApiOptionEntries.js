/**
 * The declared options of an app's APIs as plain data: what
 * `lambder.apiOptionEntries()` reports and `writeApiOptions` (lambder/build)
 * writes to a module a mock or a test imports instead of the server. The
 * contract carries the same options as types; this is the same fact as a
 * value, for the code that has to decide something at runtime with it (which
 * declarations a mock restates, which APIs a test walks). A screen reads one
 * guard's parameters instead (writeApiGuardParams), since this table names
 * every endpoint.
 *
 * Declared here, below the contract and the engines, for the reason
 * LambderApiOptionValues is: the generated module names these types through
 * `lambder/client`, the instance method fills them, and neither may reach
 * into `api/`. The three vocabularies the engines share with the entries
 * (when a guard runs, what a budget spans, when a custom key is charged) are
 * declared here too and re-exported by the engines that read them.
 */
import { splitApiName } from "./LambderApiNames.js";
/**
 * The parameter an API's guards option gives guard N, read off a generated
 * `apiOptions` table with the type the table pins: the literal a permission
 * was declared as, `true` for a guard named without a parameter, and
 * `undefined` when the API does not declare the guard. What a test or a mock
 * reads instead of the source.
 */
export const apiGuardParam = (options, name, guard) => {
    const guards = options[name]?.guards;
    let param;
    if (typeof guards === "string")
        param = guards === guard ? true : undefined;
    else if (Array.isArray(guards))
        param = guards.includes(guard) ? true : undefined;
    else if (guards !== undefined && Object.prototype.hasOwnProperty.call(guards, guard))
        param = guards[guard];
    return param;
};
/**
 * The identifier writeApiGuardParams exports an API's parameter under: its
 * group, its action capitalized, then `GuardParam` (`orders.list` exports
 * `ordersListGuardParam`). What code that reads a generated module by API
 * name (a test comparing it with the server) looks each export up by.
 */
export const apiGuardParamExportName = (apiName) => {
    const parts = splitApiName(apiName);
    if (!parts)
        throw new Error(`Lambder: "${apiName}" is not an endpoint name, so its guard parameter has no export name.`);
    return `${parts.group}${parts.action[0].toUpperCase()}${parts.action.slice(1)}GuardParam`;
};
