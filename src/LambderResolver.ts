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
    api: (
        payload: ApiOutput<TContract, TApiName> | null,
        config?: Parameters<LambderResponseBuilder<TContract>['api']>[1],
        headers?: Parameters<LambderResponseBuilder<TContract>['api']>[2]
    ) => LambderResolverResponse;
}

export default class LambderResolver<
    TContract extends ApiContractShape = any,
    TApiName extends keyof TContract & string = any
> extends LambderResponseBuilder<TContract> {
    public resolve: (response: LambderResolverResponse) => void;
    public reject: (err: Error) => void;
    public die: DieResolverMethods<TContract, TApiName>;

    constructor(
        { isCorsEnabled, publicPath, apiVersion, lambderUtils, ctx, resolve, reject }: 
        { 
            isCorsEnabled: boolean, 
            publicPath: string,
            apiVersion?: string|null,
            lambderUtils: LambderUtils,
            ctx: LambderRenderContext<any>,
            resolve: (response: LambderResolverResponse) => void,
            reject: (err: Error) => void,
        }
    ){
        super({ isCorsEnabled, publicPath, apiVersion, lambderUtils, ctx, });
        this.resolve = resolve;
        this.reject = reject;

        this.die = {
            raw: this.autoResolve(this.raw),
            json: this.autoResolve(this.json),
            xml: this.autoResolve(this.xml),
            html: this.autoResolve(this.html),
            status301: this.autoResolve(this.status301),
            status404: this.autoResolve(this.status404),
            cors: this.autoResolve(this.cors),
            fileBase64: this.autoResolve(this.fileBase64),
            file: this.autoResolve(this.file),
            ejsFile: this.autoResolvePromise(this.ejsFile),
            ejsTemplate: this.autoResolvePromise(this.ejsTemplate),
            api: this.autoResolve(this.api),
        };
    }

    // Override api method with proper typing
    api(
        payload: ApiOutput<TContract, TApiName> | null,
        config?: Parameters<LambderResponseBuilder<TContract>['api']>[1],
        headers?: Parameters<LambderResponseBuilder<TContract>['api']>[2]
    ): LambderResolverResponse {
        return super.api(payload, config, headers);
    }

    private autoResolve<
        T extends (...args: any[]) => LambderResolverResponse
    >(method: T): (...funcArgs: Parameters<T>) => LambderResolverResponse {
        return (...args: Parameters<T>): LambderResolverResponse => {
            const result: LambderResolverResponse = method.apply(this, args);
            this.resolve(result);
            return result;
        };
    }

    private autoResolvePromise<
        T extends (...args: any[]) => Promise<LambderResolverResponse>
    >(method: T): (...funcArgs: Parameters<T>) => Promise<LambderResolverResponse> {
        return (...args: Parameters<T>): Promise<LambderResolverResponse> => {
            return new Promise<LambderResolverResponse>((resolve, reject) => {
                method.apply(this, args)
                    .then(result => {
                        this.resolve(result);
                        resolve(result);
                    })
                    .catch(err => {
                        this.reject(err);
                        reject(err);
                    });
            });
        };
    }

};