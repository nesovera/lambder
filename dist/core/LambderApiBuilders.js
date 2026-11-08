import { buildApiGroup, buildLazyApiGroup, } from "../api/LambderApiDeclarations.js";
/**
 * The builders as values: the instance's own (module null), or a module's,
 * whose endpoints and lazy groups carry the module for registration to add.
 * Plain functions closing over nothing else, so an app may hand them out
 * detached.
 */
export const apiBuildersFor = (module) => ({
    defineApi: ((options, handler) => module ? { kind: "lambderApi", options, handler, module } : { kind: "lambderApi", options, handler }),
    defineApiGroup: ((name, ...parts) => buildApiGroup(name, parts)),
    lazyApiGroup: ((name, load) => buildLazyApiGroup(name, load, module)),
});
