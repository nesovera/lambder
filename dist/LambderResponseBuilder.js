import fs from "fs";
import * as path from "path";
import mimeTypeResolver from "mime-types";
const convertToMultiHeader = (headers) => Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
const CORS_HEADERS = convertToMultiHeader({
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
});
export default class LambderResponseBuilder {
    isCorsEnabled;
    publicPath;
    apiVersion;
    lambderUtils;
    ctx;
    constructor({ isCorsEnabled, publicPath, apiVersion, lambderUtils, ctx }) {
        this.isCorsEnabled = isCorsEnabled;
        this.publicPath = publicPath;
        this.apiVersion = apiVersion ?? null;
        this.lambderUtils = lambderUtils;
        this.ctx = ctx;
    }
    ;
    readPublicFileSync(filePath) {
        const publicPath = path.resolve(this.publicPath);
        const absolutePath = path.join(publicPath, filePath);
        console.log("readPublicFileSync", { filePath, publicPath, absolutePath });
        if (!absolutePath.includes(publicPath)) {
            return "forbidden-public-path";
        }
        return fs.readFileSync(absolutePath);
    }
    ;
    checkPublicFileExist(filePath) {
        const publicPath = path.resolve(this.publicPath);
        const absolutePath = path.join(this.publicPath, filePath);
        console.log("checkPublicFileExist", { filePath, publicPath, absolutePath });
        if (!absolutePath.includes(publicPath)) {
            return false;
        }
        return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
    }
    ;
    addHeader(key, value) {
        if (!this.ctx)
            throw new Error(".addHeader function is not available within this hook");
        else {
            this.ctx._otherInternal.addHeaderFnAccumulator.push({ key, value });
        }
    }
    ;
    setHeader(key, value) {
        if (!this.ctx)
            throw new Error(".setHeader function is not available within this hook");
        else {
            this.ctx._otherInternal.addHeaderFnAccumulator = this.ctx._otherInternal.addHeaderFnAccumulator
                .filter(header => header.key !== key);
            this.ctx._otherInternal.setHeaderFnAccumulator.push({ key, value });
        }
    }
    ;
    logToApiResponse(input) {
        if (!this.ctx)
            throw new Error(".logToResponse function is not available within this hook");
        else {
            this.ctx._otherInternal.logToApiResponseAccumulator.push(input);
        }
    }
    ;
    raw(param) {
        return param;
    }
    ;
    json(data, headers) {
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
    xml(data) {
        return this.raw({
            statusCode: 200,
            isBase64Encoded: true,
            multiValueHeaders: { "Content-Type": ["application/xml; charset=utf-8"] },
            body: Buffer.from(data).toString("base64"),
        });
    }
    ;
    html(data, headers) {
        return this.raw({
            statusCode: 200,
            isBase64Encoded: true,
            multiValueHeaders: { "Content-Type": ["text/html; charset=utf-8"], ...convertToMultiHeader(headers) },
            body: Buffer.from(data).toString("base64"),
        });
    }
    ;
    status301(url, headers) {
        return this.raw({
            statusCode: 301,
            multiValueHeaders: { "Location": [url], ...convertToMultiHeader(headers) },
            body: null
        });
    }
    ;
    status404(data, headers) {
        return this.raw({
            statusCode: 404,
            isBase64Encoded: true,
            multiValueHeaders: { "Content-Type": ["text/html; charset=utf-8"], ...convertToMultiHeader(headers) },
            body: Buffer.from(data).toString("base64"),
        });
    }
    ;
    cors() {
        return this.raw({
            statusCode: 200,
            multiValueHeaders: this.isCorsEnabled ? CORS_HEADERS : {},
            body: JSON.stringify(""),
        });
    }
    ;
    fileBase64(fileBase64, mimeType, headers) {
        return this.raw({
            statusCode: 200,
            isBase64Encoded: true,
            multiValueHeaders: { "Content-Type": [mimeType || "text/html"], ...convertToMultiHeader(headers) },
            body: fileBase64,
        });
    }
    ;
    file(filePath, headers, fallbackFilePath) {
        if (!this.checkPublicFileExist(filePath)) {
            if (fallbackFilePath && this.checkPublicFileExist(fallbackFilePath)) {
                return this.file(fallbackFilePath, headers);
            }
            return this.json({ error: "File not found: " + filePath });
        }
        const mimeType = mimeTypeResolver.lookup(filePath);
        const body = this.readPublicFileSync(filePath);
        const bodyBase64 = Buffer.from(body).toString("base64");
        console.log("bodyBase64.length", bodyBase64.length);
        return this.fileBase64(bodyBase64, mimeType || "", headers);
    }
    ;
    async ejsTemplate(template, pageData, headers) {
        const renderedResult = await this.lambderUtils.renderEjs(template, pageData);
        return this.raw({
            statusCode: 200,
            isBase64Encoded: true,
            multiValueHeaders: { "Content-Type": ["text/html; charset=utf-8"], ...convertToMultiHeader(headers) },
            body: Buffer.from(renderedResult).toString("base64"),
        });
    }
    ;
    async ejsFile(filePath, pageData, headers) {
        const renderedResult = await this.lambderUtils.renderEjsFile(filePath, pageData);
        return this.raw({
            statusCode: 200,
            isBase64Encoded: true,
            multiValueHeaders: { "Content-Type": ["text/html; charset=utf-8"], ...convertToMultiHeader(headers) },
            body: Buffer.from(renderedResult).toString("base64"),
        });
    }
    ;
    api(payload, { versionExpired, sessionExpired, notAuthorized, message, errorMessage, logList, } = {
        versionExpired: undefined, sessionExpired: undefined, notAuthorized: undefined,
        message: null, errorMessage: null, logList: undefined
    }, headers) {
        const finalLogList = logList || this.ctx?._otherInternal?.logToApiResponseAccumulator;
        return this.json({
            apiVersion: this.apiVersion,
            payload,
            ...(versionExpired ? { versionExpired } : {}),
            ...(sessionExpired ? { sessionExpired } : {}),
            ...(notAuthorized ? { notAuthorized } : {}),
            ...(message ? { message } : {}),
            ...(errorMessage ? { errorMessage } : {}),
            ...(finalLogList?.length ? { logList: finalLogList } : {}),
        }, headers);
    }
    ;
}
;
