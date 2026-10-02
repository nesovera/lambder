import type { LambderRenderContext } from "./LambderContext.js";
import type { LambderFiles } from "./LambderFiles.js";
import { LambderResponse, type LambderHeadersInput } from "./LambderResponse.js";
import type { LambderHttpStatusCode } from "../shared/wire/LambderHttpStatus.js";
import { LambderSafeHtml } from "../shared/LambderHtml.js";
import type { LambderTemplateData } from "./LambderTemplatingEngine.js";
import type { LambderApiRefusalConfig } from "../shared/wire/LambderApiContract.js";
export type { LambderApiEnvelopeBody, LambderApiRefusalConfig } from "../shared/wire/LambderApiContract.js";
export type LambderResponseOptions = {
    statusCode?: LambderHttpStatusCode;
    headers?: LambderHeadersInput;
    /** Shorthand for the Cache-Control header. */
    cacheControl?: string;
    /** "auto" (default): gzip when compressible/large enough. true: force. false: never. */
    compress?: boolean | "auto";
    /** "auto" (default): ETag on GET/HEAD 200 when globally enabled. true: force. false: never. */
    etag?: boolean | "auto";
};
/** res.templateFile's options: a response's, and how the file is compiled. */
export type LambderTemplateFileOptions = LambderResponseOptions & {
    /** Expose the <title> content as slot "title" and the point before </head> as slot "head" (see LambderTemplatingEngineOptions). */
    htmlVirtualSlots?: boolean;
};
export type LambderRawResponseInit = {
    statusCode: LambderHttpStatusCode;
    headers?: LambderHeadersInput;
    body: string | Buffer | null;
    /** True when body is already a base64-encoded string. */
    isBase64Encoded?: boolean;
    compress?: boolean | "auto";
    etag?: boolean | "auto";
};
/**
 * Builds the responses of routes, hooks and error handlers. An API handler
 * never holds one: it returns its output or refuses, and writes headers and
 * cookies through its context (LambderResponseTools).
 */
export default class LambderResponseBuilder {
    protected files: LambderFiles | null;
    protected apiVersion: string | null;
    protected ctx?: LambderRenderContext;
    constructor({ files, apiVersion, ctx }: {
        files?: LambderFiles | null;
        apiVersion?: string | null;
        ctx?: LambderRenderContext;
    });
    private buildResponse;
    /** The instance's file reader, which res.file and res.templateFile need. */
    private requireFiles;
    raw(init: LambderRawResponseInit): LambderResponse;
    json(data: Record<string, any>, options?: LambderResponseOptions): LambderResponse;
    /** A plain-text body, sent as text: the place for a message, whatever status it goes out with (`{ statusCode }`). */
    text(data: string, options?: LambderResponseOptions): LambderResponse;
    /** An XML document (a sitemap, a feed, SVG) built with xml`...` or marked safe with raw(). */
    xml(data: LambderSafeHtml, options?: LambderResponseOptions): LambderResponse;
    /** An HTML page built with html`...` or marked safe with raw(). */
    html(data: LambderSafeHtml, options?: LambderResponseOptions): LambderResponse;
    /** An HTML response with any status code, its body built like res.html's; no body sends an empty one. */
    status(statusCode: LambderHttpStatusCode, body?: LambderSafeHtml, options?: LambderResponseOptions): LambderResponse;
    /** An HTML 404, its body built like res.html's. */
    status404(data: LambderSafeHtml, options?: LambderResponseOptions): LambderResponse;
    /**
     * A redirect to `url`, which may be a path or a whole URL. A path stays on
     * this origin: a leading run of slashes and backslashes collapses to one
     * slash, since `//evil.example` is a protocol-relative URL and a browser
     * reads `/\evil.example` as the same thing, so a path built from a
     * decoded ctx.path cannot send the visitor to another host. Another host
     * is named with its scheme. What a URL may not carry as it is (control
     * characters, a space, a backslash, anything outside ASCII) is
     * percent-encoded for every caller: a browser drops a TAB or line break
     * inside a Location, so `/<TAB>/evil.example` would otherwise be that
     * host, and a line break would end the header. `%` is left alone, so an
     * encoded URL stays as it was written.
     */
    redirect(url: string, statusCode?: LambderHttpStatusCode, options?: LambderResponseOptions): LambderResponse;
    versionExpired(options?: LambderResponseOptions): LambderResponse;
    fileBase64(fileBase64: string, mimeType: string, options?: LambderResponseOptions): LambderResponse;
    /** A file from the files source as a response; 404 when there is none. */
    file(filePath: string, options?: LambderResponseOptions): Promise<LambderResponse>;
    /**
     * Render an HTML file from the files source through
     * LambderTemplatingEngine (comment-based slots/conditionals) and return
     * it as an HTML response. The compiled template is cached on the
     * instance across warm invocations; a missing file throws (it is a
     * server-side configuration error, not a client 404), and so does a data
     * key the file has no slot or condition for, naming the file. TNames, when
     * given, is the file's slot and condition names, so a misspelled key is a
     * compile error. Set htmlVirtualSlots to expose "title"/"head" slots on
     * marker-less files.
     */
    templateFile<TNames extends string = string>(filePath: string, data?: LambderTemplateData<TNames>, options?: LambderTemplateFileOptions): Promise<LambderResponse>;
    /**
     * An API call answered from outside its handler: what a hook, a fallback,
     * the input validation handler or the global error handler answers with.
     * It is always a refusal (a refusal message, or one of the versionExpired,
     * sessionExpired and notAuthorized flags) with a null payload, so a
     * caller's success is only ever the handler's parsed output. Its message
     * carries a framework code or none, and no data, since it answers outside
     * any one endpoint's declared refusals. The logList channel is what the
     * request accumulated unless the config names its own.
     */
    apiRefusal(config: LambderApiRefusalConfig, options?: LambderResponseOptions): LambderResponse;
}
