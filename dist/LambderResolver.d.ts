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
    resolve: (response: LambderResolverResponse) => void;
    reject: (err: Error) => void;
    die: DieResolverMethods;
    constructor({ isCorsEnabled, publicPath, apiVersion, lambderUtils, resolve, reject }: {
        isCorsEnabled: boolean;
        publicPath: string;
        apiVersion?: string | null;
        lambderUtils: LambderUtils;
        resolve: (response: LambderResolverResponse) => void;
        reject: (err: Error) => void;
    });
    private autoResolve;
    private autoResolvePromise;
}
export {};
