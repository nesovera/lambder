import type { LambderRenderContext } from "./Lambder.js";
import LambderResponseBuilder, { LambderResolverResponse } from "./LambderResponseBuilder.js";
import LambderUtils from "./LambderUtils.js";
import type { ApiContractShape, ApiOutput } from "./LambderApiContract.js";
type MethodType<T, M extends keyof T> = T[M] extends (...args: any[]) => any ? T[M] : never;
interface DieResolverMethods<TContract extends ApiContractShape, TApiName extends keyof TContract & string> {
    raw: MethodType<LambderResponseBuilder<TContract>, 'raw'>;
    json: MethodType<LambderResponseBuilder<TContract>, 'json'>;
    xml: MethodType<LambderResponseBuilder<TContract>, 'xml'>;
    html: MethodType<LambderResponseBuilder<TContract>, 'html'>;
    status301: MethodType<LambderResponseBuilder<TContract>, 'status301'>;
    status404: MethodType<LambderResponseBuilder<TContract>, 'status404'>;
    cors: MethodType<LambderResponseBuilder<TContract>, 'cors'>;
    fileBase64: MethodType<LambderResponseBuilder<TContract>, 'fileBase64'>;
    file: MethodType<LambderResponseBuilder<TContract>, 'file'>;
    ejsFile: MethodType<LambderResponseBuilder<TContract>, 'ejsFile'>;
    ejsTemplate: MethodType<LambderResponseBuilder<TContract>, 'ejsTemplate'>;
    api: (payload: ApiOutput<TContract, TApiName> | null, config?: Parameters<LambderResponseBuilder<TContract>['api']>[1], headers?: Parameters<LambderResponseBuilder<TContract>['api']>[2]) => LambderResolverResponse;
}
export default class LambderResolver<TContract extends ApiContractShape = any, TApiName extends keyof TContract & string = any> extends LambderResponseBuilder<TContract> {
    resolve: (response: LambderResolverResponse) => void;
    reject: (err: Error) => void;
    die: DieResolverMethods<TContract, TApiName>;
    constructor({ isCorsEnabled, publicPath, apiVersion, lambderUtils, ctx, resolve, reject }: {
        isCorsEnabled: boolean;
        publicPath: string;
        apiVersion?: string | null;
        lambderUtils: LambderUtils;
        ctx: LambderRenderContext<any>;
        resolve: (response: LambderResolverResponse) => void;
        reject: (err: Error) => void;
    });
    api(payload: ApiOutput<TContract, TApiName> | null, config?: Parameters<LambderResponseBuilder<TContract>['api']>[1], headers?: Parameters<LambderResponseBuilder<TContract>['api']>[2]): LambderResolverResponse;
    private autoResolve;
    private autoResolvePromise;
}
export {};
