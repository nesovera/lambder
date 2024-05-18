import type { LambderRenderContext } from "./Lambder.js";
import LambderResponseBuilder, { LambderResolverResponse } from "./LambderResponseBuilder.js";
import LambderUtils from "./LambderUtils.js";

type MethodType<T, M extends keyof T> = T[M] extends (...args: any[]) => any ? T[M] : never;

interface DieResolverMethods {
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
    api: MethodType<LambderResponseBuilder, 'api'>;
}

export default class LambderResolver extends LambderResponseBuilder {
    public resolve: (response: LambderResolverResponse) => void;
    public reject: (err: Error) => void;
    public die: DieResolverMethods;

    constructor(
        { isCorsEnabled, publicPath, apiVersion, lambderUtils, ctx, resolve, reject }: 
        { 
            isCorsEnabled: boolean, 
            publicPath: string,
            apiVersion?: string|null,
            lambderUtils: LambderUtils,
            ctx: LambderRenderContext,
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