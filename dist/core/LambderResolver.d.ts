import LambderResponseBuilder, { type LambderTemplateFileOptions } from "./LambderResponseBuilder.js";
import type { LambderResponse } from "./LambderResponse.js";
import type { LambderTemplateData } from "./LambderTemplatingEngine.js";
type SyncDie<T extends (...args: any[]) => LambderResponse> = (...args: Parameters<T>) => never;
type AsyncDie<T extends (...args: any[]) => Promise<LambderResponse>> = (...args: Parameters<T>) => Promise<never>;
/** The `res.die.*` surface: every builder method, throwing what it built. Internal to the resolver, which is the only thing that has one. */
interface DieResolverMethods {
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
    apiRefusal: SyncDie<LambderResponseBuilder["apiRefusal"]>;
    file: AsyncDie<LambderResponseBuilder["file"]>;
    templateFile: <TNames extends string = string>(filePath: string, data?: LambderTemplateData<TNames>, options?: LambderTemplateFileOptions) => Promise<never>;
}
/**
 * Response builder passed to route handlers and hooks.
 *
 * `res.die.*` builds the response and THROWS it, immediately halting the
 * request at any call depth (handlers, hooks, nested service functions).
 * Lambder's render pipeline catches thrown LambderResponse instances and uses
 * them as the response. Plain `throw res.html(...)` works the same way.
 */
export default class LambderResolver extends LambderResponseBuilder {
    die: DieResolverMethods;
    constructor(...args: ConstructorParameters<typeof LambderResponseBuilder>);
}
export {};
