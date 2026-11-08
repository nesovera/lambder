import { storeApp } from "./storeApp.js";
import { orderApis } from "./orderApis.js";
import { MODULE_API_GROUPS, STORE_MODULES } from "./storeModules.js";

/** The entry: every group registered as one contract, then the hooks and every part's routes. */
export const lambder = storeApp
    .registerApiGroups(orderApis, ...MODULE_API_GROUPS)
    .addHook("beforeRender", (ctx) => ctx)
    .setGlobalErrorHandler((_error, _ctx, res) => res.text("Something went wrong.", { statusCode: 500 }))
    .use((instance) => { for(const part of STORE_MODULES) if("registerRoutes" in part) part.registerRoutes(instance); });

export type StoreApiContract = typeof lambder.ApiContract;
export const handler = lambder.getHandler();
