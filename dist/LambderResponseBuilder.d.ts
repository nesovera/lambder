import LambderUtils from "./LambderUtils.js";
export type LambderResolverResponse = {
    statusCode: number;
    multiValueHeaders?: Record<string, string[]>;
    body: string | null;
    isBase64Encoded?: boolean;
};
export type LambderApiResponseConfig = {
    versionExpired?: boolean;
    sessionExpired?: boolean;
    notAuthorized?: boolean;
    message?: any;
    errorMessage?: any;
};
export type LambderApiResponse<T> = LambderApiResponseConfig & {
    payload?: T | null;
};
export default class LambderResponseBuilder {
    private isCorsEnabled;
    private publicPath;
    private apiVersion;
    private lambderUtils;
    constructor({ isCorsEnabled, publicPath, apiVersion, lambderUtils }: {
        isCorsEnabled: boolean;
        publicPath: string;
        apiVersion?: string | null;
        lambderUtils: LambderUtils;
    });
    private readPublicFileSync;
    private checkPublicFileExist;
    raw(param: LambderResolverResponse): LambderResolverResponse;
    json(data: Record<string, any>, headers?: Record<string, string | string[]>): LambderResolverResponse;
    xml(data: string): LambderResolverResponse;
    html(data: string, headers?: Record<string, string | string[]>): LambderResolverResponse;
    status301(url: string, headers?: Record<string, string | string[]>): LambderResolverResponse;
    status404(data: string, headers?: Record<string, string | string[]>): LambderResolverResponse;
    cors(): LambderResolverResponse;
    fileBase64(fileBase64: string, mimeType: string, headers?: Record<string, string | string[]>): LambderResolverResponse;
    file(filePath: string, headers?: Record<string, string | string[]>, fallbackFilePath?: string): LambderResolverResponse;
    ejsTemplate(template: string, pageData: Record<string, any>, headers?: Record<string, string | string[]>): Promise<LambderResolverResponse>;
    ejsFile(filePath: string, pageData: Record<string, any>, headers?: Record<string, string | string[]>): Promise<LambderResolverResponse>;
    api<T = any>(payload: T | null, { versionExpired, sessionExpired, notAuthorized, message, errorMessage, }?: LambderApiResponseConfig, headers?: Record<string, string | string[]>): LambderResolverResponse;
}
