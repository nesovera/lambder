import { apiBuildersFor, } from "./LambderApiBuilders.js";
/**
 * A part of an app with guards and rate-limit policies of its own, for its
 * own endpoints: the declaration builders typed on its instance's types with
 * the module's guards and policies beside the instance's. Made by an
 * instance's defineApiModule(); its endpoints are registered on the instance
 * as any are (registerApiGroups), and their registration adds the module's
 * guards and policies to the instance, refusing a name the instance or
 * another module declares.
 *
 * So an app's core creates its instance knowing only its own policies, and
 * each module brings its own: nothing has to import every module's guards
 * before the instance can exist. Hand the builders out under the module's
 * name, as an instance's are:
 *
 * ```typescript
 * export const giftCardModule = storeApp.defineApiModule({ guards: { cardHolder }, rateLimitPolicies: { redeemPerCard } });
 * export type GiftCardModule = typeof giftCardModule;
 * export const defineApi: GiftCardModule["defineApi"] = giftCardModule.defineApi;
 * ```
 *
 * @typeParam TApp - @internal The module's app types (LambderModuleAppTypes): the instance's, widened by the module's guards and policies (do not pass manually)
 */
export class LambderApiModule {
    /**
     * Type property for the module's app types, as an instance's AppTypes
     * is: what LambderRenderContextOf<typeof module> reads, for a helper
     * handed one of the module's handler contexts, its policies typed. It
     * has no value.
     */
    AppTypes;
    /** Declares one of the module's endpoints: its guards and rate limits may name the instance's and the module's own. */
    defineApi;
    /** Gathers endpoints into a named group, as the instance's does. */
    defineApiGroup;
    /** A group of the module's loaded on the first call to it, carrying the module, so its guards and policies are added when the group is registered. */
    lazyApiGroup;
    /** Called by an instance's defineApiModule(), with the declarations it checked; an app does not construct one. */
    constructor(declarations) {
        const builders = apiBuildersFor(declarations);
        this.defineApi = builders.defineApi;
        this.defineApiGroup = builders.defineApiGroup;
        this.lazyApiGroup = builders.lazyApiGroup;
    }
}
