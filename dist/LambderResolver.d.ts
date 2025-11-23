import type { LambderRenderContext } from "./LambderContext.js";
import LambderResponseBuilder, { LambderResolverResponse } from "./LambderResponseBuilder.js";
import LambderUtils from "./LambderUtils.js";
type MethodType<T, M extends keyof T> = T[M] extends (...args: any[]) => any ? T[M] : never;
interface DieResolverMethods<TOutput> {
    raw: MethodType<LambderResponseBuilder, 'raw'>;
    json: MethodType<LambderResponseBuilder, 'json'>;
    xml: MethodType<LambderResponseBuilder, 'xml'>;
    html: MethodType<LambderResponseBuilder, 'html'>;
    status301: MethodType<LambderResponseBuilder, 'status301'>;
    status404: MethodType<LambderResponseBuilder, 'status404'>;
    cors: MethodType<LambderResponseBuilder, 'cors'>;
    fileBase64: MethodType<LambderResponseBuilder, 'fileBase64'>;
    file: MethodType<LambderResponseBuilder, 'file'>;
    ejsFile: MethodType<LambderResponseBuilder, 'ejsFile'>;
    ejsTemplate: MethodType<LambderResponseBuilder, 'ejsTemplate'>;
    api: (payload: TOutput | null, config?: Parameters<LambderResponseBuilder['api']>[1], headers?: Parameters<LambderResponseBuilder['api']>[2]) => LambderResolverResponse;
}
export default class LambderResolver<TOutput = any> extends LambderResponseBuilder<TOutput> {
    resolve: (response: LambderResolverResponse) => void;
    reject: (err: Error) => void;
    die: DieResolverMethods<TOutput>;
    constructor({ isCorsEnabled, publicPath, apiVersion, lambderUtils, ctx, resolve, reject }: {
        isCorsEnabled: boolean;
        publicPath: string;
        apiVersion?: string | null;
        lambderUtils: LambderUtils;
        ctx: LambderRenderContext<any>;
        resolve: (response: LambderResolverResponse) => void;
        reject: (err: Error) => void;
    });
    api(payload: TOutput | null, config?: Parameters<LambderResponseBuilder['api']>[1], headers?: Parameters<LambderResponseBuilder['api']>[2]): LambderResolverResponse;
    private autoResolve;
    private autoResolvePromise;
}
export {};
