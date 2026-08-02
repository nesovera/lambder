import LambderResponseBuilder, { type LambderApiResponseConfig, type LambderResponseOptions } from "./LambderResponseBuilder.js";
import type { LambderResponse } from "./LambderResponse.js";
type SyncDie<T extends (...args: any[]) => LambderResponse> = (...args: Parameters<T>) => never;
type AsyncDie<T extends (...args: any[]) => Promise<LambderResponse>> = (...args: Parameters<T>) => Promise<never>;
export interface DieResolverMethods<TOutput> {
    raw: SyncDie<LambderResponseBuilder["raw"]>;
    json: SyncDie<LambderResponseBuilder["json"]>;
    text: SyncDie<LambderResponseBuilder["text"]>;
    xml: SyncDie<LambderResponseBuilder["xml"]>;
    html: SyncDie<LambderResponseBuilder["html"]>;
    status: SyncDie<LambderResponseBuilder["status"]>;
    status404: SyncDie<LambderResponseBuilder["status404"]>;
    redirect: SyncDie<LambderResponseBuilder["redirect"]>;
    versionExpired: SyncDie<LambderResponseBuilder["versionExpired"]>;
    fileBase64: SyncDie<LambderResponseBuilder["fileBase64"]>;
    api: (payload: TOutput | null, config?: LambderApiResponseConfig, options?: LambderResponseOptions) => never;
    apiBinary: (payload: TOutput | null, config?: LambderApiResponseConfig, options?: LambderResponseOptions) => never;
    file: AsyncDie<LambderResponseBuilder["file"]>;
    templateFile: AsyncDie<LambderResponseBuilder["templateFile"]>;
}
/**
 * Response builder passed to route/api handlers and hooks.
 *
 * `res.die.*` builds the response and THROWS it, immediately halting the
 * request at any call depth (handlers, hooks, nested service functions).
 * Lambder's render pipeline catches thrown LambderResponse instances and uses
 * them as the response. Plain `throw res.html(...)` works the same way.
 */
export default class LambderResolver<TOutput = any> extends LambderResponseBuilder<TOutput> {
    die: DieResolverMethods<TOutput>;
    constructor(...args: ConstructorParameters<typeof LambderResponseBuilder>);
    api(payload: TOutput | null, config?: LambderApiResponseConfig, options?: LambderResponseOptions): LambderResponse;
    apiBinary(payload: TOutput | null, config?: LambderApiResponseConfig, options?: LambderResponseOptions): LambderResponse;
}
export {};
