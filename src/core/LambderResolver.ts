import type { LambderApiNullAnswerConfig } from "../shared/wire/LambderApiContract.js";
import LambderResponseBuilder, {
    type LambderResolverApiMethod,
    type LambderApiResponseConfig,
    type LambderResponseOptions,
} from "./LambderResponseBuilder.js";
import type { LambderResponse } from "./LambderResponse.js";

type SyncDie<T extends (...args: any[]) => LambderResponse> = (...args: Parameters<T>) => never;
type AsyncDie<T extends (...args: any[]) => Promise<LambderResponse>> = (...args: Parameters<T>) => Promise<never>;

/** The `res.die.*` surface: every builder method, throwing what it built. Internal to the resolver, which is the only thing that has one. */
interface DieResolverMethods<TOutput> {
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
    api: LambderResolverApiMethod<TOutput, never>;
    apiBinary: LambderResolverApiMethod<TOutput, never>;
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
    public die: DieResolverMethods<TOutput>;

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
            // Overloaded on the payload (see LambderApiAnswer); the implementation takes both shapes.
            api: ((payload: TOutput | null, config?: LambderApiResponseConfig, options?: LambderResponseOptions) => {
                throw this.api(payload as TOutput, config, options);
            }) as LambderResolverApiMethod<TOutput, never>,
            apiBinary: ((payload: TOutput | null, config?: LambderApiResponseConfig, options?: LambderResponseOptions) => {
                throw this.apiBinary(payload as TOutput, config, options);
            }) as LambderResolverApiMethod<TOutput, never>,
            file: async (...a) => { throw await this.file(...a); },
            templateFile: async (...a) => { throw await this.templateFile(...a); },
        };
    }

    // Restated with the resolver's output type: the answer is the declared
    // output, or null beside a reason (see LambderApiAnswer).
    api(payload: TOutput, config?: LambderApiResponseConfig, options?: LambderResponseOptions): LambderResponse;
    api(payload: null, config: LambderApiNullAnswerConfig, options?: LambderResponseOptions): LambderResponse;
    api(payload: TOutput | null, config?: LambderApiResponseConfig, options?: LambderResponseOptions): LambderResponse {
        return super.api(payload as TOutput, config, options);
    }

    apiBinary(payload: TOutput, config?: LambderApiResponseConfig, options?: LambderResponseOptions): LambderResponse;
    apiBinary(payload: null, config: LambderApiNullAnswerConfig, options?: LambderResponseOptions): LambderResponse;
    apiBinary(payload: TOutput | null, config?: LambderApiResponseConfig, options?: LambderResponseOptions): LambderResponse {
        return super.apiBinary(payload as TOutput, config, options);
    }
}
