import type { LambderRegistrableApiGroup } from "lambder";
import type { StoreLambder } from "./storeApp.js";
import { lazyApiGroup } from "./storeBuilders.js";
import { giftCardModule } from "./giftCardModule.js";
import { storeRoutes } from "./storeRoutes.js";

/**
 * A part of the store as the entry registers it: its groups, a lazy one
 * among them, and the routes it adds. The shape an app's module list holds.
 */
export type StoreModuleDeclaration = {
    readonly apiGroups: readonly LambderRegistrableApiGroup[];
    readonly registerRoutes?: (lambder: StoreLambder) => unknown;
};

export const reportServerModule = {
    apiGroups: [lazyApiGroup("reports", () => import("./reportApis.js").then((m) => m.reportApis))] as const,
    registerRoutes: storeRoutes,
};

export const giftCardServerModule = {
    apiGroups: [giftCardModule.lazyApiGroup("giftCards", () => import("./giftCardApis.js").then((m) => m.giftCardApis))] as const,
};

/** Every part, as a generated list holds them. */
export const STORE_MODULES = [reportServerModule, giftCardServerModule] as const satisfies readonly StoreModuleDeclaration[];

/** Every part's groups, written out part by part so the one registration types each. */
export const MODULE_API_GROUPS = [...reportServerModule.apiGroups, ...giftCardServerModule.apiGroups] as const;
