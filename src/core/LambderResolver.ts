import LambderResponseBuilder from "./LambderResponseBuilder.js";
import type { LambderResponse } from "./LambderResponse.js";

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
    api: SyncDie<LambderResponseBuilder["api"]>;
    file: AsyncDie<LambderResponseBuilder["file"]>;
    templateFile: AsyncDie<LambderResponseBuilder["templateFile"]>;
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
    public die: DieResolverMethods;

    constructor(...args: ConstructorParameters<typeof LambderResponseBuilder>){
        super(...args);

        this.die = {
            raw: (...a) => { throw this.raw(...a); },
            json: (...a) => { throw this.json(...a); },
            text: (...a) => { throw this.text(...a); },
            xml: (...a) => { throw this.xml(...a); },
            html: (...a) => { throw this.html(...a); },
            status: (...a) => { throw this.status(...a); },
            status404: (...a) => { throw this.status404(...a); },
            redirect: (...a) => { throw this.redirect(...a); },
            versionExpired: (...a) => { throw this.versionExpired(...a); },
            fileBase64: (...a) => { throw this.fileBase64(...a); },
            api: (...a) => { throw this.api(...a); },
            file: async (...a) => { throw await this.file(...a); },
            templateFile: async (...a) => { throw await this.templateFile(...a); },
        };
    }
}
