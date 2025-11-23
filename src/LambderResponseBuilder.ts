import mimeTypeResolver from "mime-types";
import LambderUtils from "./LambderUtils.js";
import { LambderRenderContext } from "./Lambder.js";
import type { ApiContractShape } from "./LambderApiContract.js";
import { getFS, getPath } from "./node-polyfills.js";

const convertToMultiHeader = (
    headers: Record<string, string|string[]> | undefined
):Record<string, string[]>  =>
    Object.fromEntries(Object.entries(headers||{}).map(([k,v])=>[ k, Array.isArray(v) ? v : [v] ]));

const CORS_HEADERS = convertToMultiHeader({
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers" : "Origin, X-Requested-With, Content-Type, Accept",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
});

export type LambderResolverResponse = { 
    statusCode: number, 
    multiValueHeaders?: Record<string, string[]>, 
    body: string | null,
    isBase64Encoded?: boolean,
};

export type LambderApiResponseConfig = {
    versionExpired?: boolean; 
    sessionExpired?: boolean; 
    notAuthorized?: boolean; 
    message?: any; 
    errorMessage?: any;
    logList?: any[];
}


export type LambderApiResponse<T> = LambderApiResponseConfig & {
    payload?: T | null; 
}

export default class LambderResponseBuilder<TContract extends ApiContractShape = any> {
    private isCorsEnabled: boolean;
    private publicPath: string;
    private apiVersion: string|null;
    private lambderUtils: LambderUtils;
    private ctx?: LambderRenderContext<any>;

    constructor(
        { isCorsEnabled, publicPath, apiVersion, lambderUtils, ctx }: 
        { 
            isCorsEnabled: boolean, 
            publicPath: string,
            apiVersion?: string|null,
            lambderUtils: LambderUtils,
            ctx?: LambderRenderContext<any>,
        }
    ){
        this.isCorsEnabled = isCorsEnabled;
        this.publicPath = publicPath;
        this.apiVersion = apiVersion ?? null;
        this.lambderUtils = lambderUtils;
        this.ctx = ctx;
    };

    private async readPublicFileSync(filePath: string){
        const fs = await getFS();
        const path = await getPath();
        
        if (!fs || !path) {
            throw new Error("File system operations are not available in browser environment");
        }
        
        const publicPath = path.resolve(this.publicPath);
        const absolutePath = path.resolve(publicPath, filePath);
        console.log("readPublicFileSync", { filePath, publicPath, absolutePath });
        if(!absolutePath.startsWith(publicPath)){ return "forbidden-public-path"; }
        return await fs.promises.readFile(absolutePath);
    };

    private async checkPublicFileExist(filePath: string){
        const fs = await getFS();
        const path = await getPath();
        
        if (!fs || !path) { return false; }
        
        const publicPath = path.resolve(this.publicPath);
        const absolutePath = path.resolve(publicPath, filePath);
        console.log("checkPublicFileExist", { filePath, publicPath, absolutePath });
        if(!absolutePath.startsWith(publicPath)){ return false; }
        try {
            const stat = await fs.promises.stat(absolutePath);
            return stat.isFile();
        } catch {
            return false;
        }
    };

    addHeader(key: string, value: string){
        if(!this.ctx) throw new Error(".addHeader function is not available within this hook"); 
        else{
            this.ctx._otherInternal.addHeaderFnAccumulator.push({ key, value });
        }
    };

    setHeader(key: string, value: string|string[]){
        if(!this.ctx) throw new Error(".setHeader function is not available within this hook"); 
        else{
            this.ctx._otherInternal.addHeaderFnAccumulator = this.ctx._otherInternal.addHeaderFnAccumulator
                .filter(header=>header.key !== key);
            this.ctx._otherInternal.setHeaderFnAccumulator.push({ key, value });
        }
    };
    
    logToApiResponse(input:any){
        if(!this.ctx) throw new Error(".logToResponse function is not available within this hook"); 
        else{
            this.ctx._otherInternal.logToApiResponseAccumulator.push(input);
        }
    };


    raw(param: LambderResolverResponse){
        return param;
    };

	json(
        data: Record<string, any>, 
        headers?: Record<string, string|string[]>
    ):LambderResolverResponse{
        return this.raw({
            statusCode: 200,
            multiValueHeaders: { 
                "Content-Type": ["application/json; charset=utf-8"],
                 ...(this.isCorsEnabled ? CORS_HEADERS : {}), 
                 ...convertToMultiHeader(headers)
            },
            body: JSON.stringify(data),
        });
    }

	xml(data: string):LambderResolverResponse{
        return this.raw({
            statusCode: 200,
            isBase64Encoded: true,
            multiValueHeaders: { "Content-Type": ["application/xml; charset=utf-8"]}, 
            body: Buffer.from(data).toString("base64"),
        });
    };

	html(
        data: string, 
        headers?: Record<string, string|string[]>,
    ):LambderResolverResponse{
        return this.raw({
            statusCode: 200,
            isBase64Encoded: true,
            multiValueHeaders: {"Content-Type": ["text/html; charset=utf-8"], ...convertToMultiHeader(headers)},
            body: Buffer.from(data).toString("base64"),
        });
    };

	status301(
        url: string, 
        headers?: Record<string, string|string[]>,
    ):LambderResolverResponse{
        return this.raw({
            statusCode: 301, 
            multiValueHeaders: { "Location" : [url], ...convertToMultiHeader(headers) },
            body:null
        });
    };

	status404(
        data: string,
        headers?: Record<string, string|string[]>,
    ):LambderResolverResponse{
        return this.raw({
            statusCode: 404,
            isBase64Encoded: true,
            multiValueHeaders: {"Content-Type": ["text/html; charset=utf-8"], ...convertToMultiHeader(headers)},
            body: Buffer.from(data).toString("base64"),
        });
    };

	versionExpired(
        headers?: Record<string, string|string[]>,
    ):LambderResolverResponse{
        return this.api(null, { versionExpired: true }, headers);
    };

	cors():LambderResolverResponse{
        return this.raw({ 
            statusCode: 200,
            multiValueHeaders: this.isCorsEnabled ? CORS_HEADERS: {},
            body: JSON.stringify(""),
        });
    };

	fileBase64 (
        fileBase64: string, 
        mimeType: string, 
        headers?: Record<string, string|string[]>,
    ):LambderResolverResponse{
        return this.raw({ 
            statusCode: 200, 
            isBase64Encoded: true, 
            multiValueHeaders: { "Content-Type": [mimeType || "text/html"], ...convertToMultiHeader(headers) }, 
            body: fileBase64, 
        });
    };

	async file(
        filePath: string, 
        headers?: Record<string, string|string[]>,
        fallbackFilePath?: string,
    ):Promise<LambderResolverResponse>{
        const doesFileExist = await this.checkPublicFileExist(filePath);
        if(!doesFileExist && fallbackFilePath){
            const doesFallbackExist = await this.checkPublicFileExist(fallbackFilePath);
            if(doesFallbackExist){
                return await this.file(fallbackFilePath, headers);
            }
            return this.json({ error: "File not found: " + filePath })
        }
        const mimeType = mimeTypeResolver.lookup(filePath);
        const body = await this.readPublicFileSync(filePath);
        if (body === "forbidden-public-path") {
            throw { error: "Forbidden public path: " + filePath };
        }
        const bodyBuffer: Buffer =  Buffer.isBuffer(body) ? body : Buffer.from(body);
        const bodyBase64 = bodyBuffer.toString("base64");
        console.log("bodyBase64.length",bodyBase64.length);
        return this.fileBase64(bodyBase64, mimeType || "", headers);
    };

	async ejsTemplate(
        template: string, 
        pageData: Record<string, any>,
        headers?: Record<string, string|string[]>,
    ):Promise<LambderResolverResponse>{
        const renderedResult = await this.lambderUtils.renderEjs(template, pageData);

        return this.raw({
            statusCode: 200,
            isBase64Encoded: true,
            multiValueHeaders: {"Content-Type": ["text/html; charset=utf-8"], ...convertToMultiHeader(headers)},
            body: Buffer.from(renderedResult).toString("base64"),
        });
    };

	async ejsFile(
        filePath: string, 
        pageData: Record<string, any>,
        headers?: Record<string, string|string[]>,
    ):Promise<LambderResolverResponse>{
        const renderedResult = await this.lambderUtils.renderEjsFile(filePath, pageData);

        return this.raw({
            statusCode: 200,
            isBase64Encoded: true,
            multiValueHeaders: {"Content-Type": ["text/html; charset=utf-8"], ...convertToMultiHeader(headers)},
            body: Buffer.from(renderedResult).toString("base64"),
        });
    };

    api<T=any>(
        payload: T | null, 
        {
            versionExpired, sessionExpired, notAuthorized, 
            message, errorMessage, logList,
        }: LambderApiResponseConfig = {
            versionExpired: undefined, sessionExpired: undefined, notAuthorized: undefined, 
            message: null, errorMessage: null, logList: undefined
        }, 
        headers?: Record<string, string|string[]>,
    ): LambderResolverResponse {
        const finalLogList = logList || this.ctx?._otherInternal?.logToApiResponseAccumulator;
        return this.json({ 
            apiVersion: this.apiVersion,
            payload,
            ...(versionExpired ? {versionExpired} : {}),
            ...(sessionExpired ? {sessionExpired} : {}),
            ...(notAuthorized ? {notAuthorized} : {}),
            ...(message ? {message} : {}),
            ...(errorMessage ? {errorMessage} : {}),
            ...(finalLogList?.length ? {logList: finalLogList} : {}),
        }, headers);
    };

    apiBinary<T=any>(
        payload: T | null, 
        {
            versionExpired, sessionExpired, notAuthorized, 
            message, errorMessage, logList,
        }: LambderApiResponseConfig = {
            versionExpired: undefined, sessionExpired: undefined, notAuthorized: undefined, 
            message: null, errorMessage: null, logList: undefined
        }, 
        headers?: Record<string, string|string[]>,
    ): LambderResolverResponse {
        const finalLogList = logList || this.ctx?._otherInternal?.logToApiResponseAccumulator;
        const result = { 
            apiVersion: this.apiVersion,
            payload,
            ...(versionExpired ? {versionExpired} : {}),
            ...(sessionExpired ? {sessionExpired} : {}),
            ...(notAuthorized ? {notAuthorized} : {}),
            ...(message ? {message} : {}),
            ...(errorMessage ? {errorMessage} : {}),
            ...(finalLogList?.length ? {logList: finalLogList} : {}),
        };

        return this.raw({ 
            statusCode: 200, 
            isBase64Encoded: true, 
            multiValueHeaders: { 
                "Content-Type": ["application/lambder-json-stream"],
                "Content-Encoding": ["gzip"],
                ...convertToMultiHeader(headers) 
            }, 
            body: Buffer.from(JSON.stringify(result)).toString("base64"), 
        });
    };

};