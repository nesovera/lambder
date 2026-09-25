import type { z } from "zod";
import type { LambderRenderContext } from "./LambderContext.js";
import { type LambderCookieOptions, type LambderClearCookieOptions } from "../shared/wire/LambderCookie.js";
import type { LambderFiles } from "./LambderFiles.js";
import { LambderResponse, type LambderHeadersInput } from "./LambderResponse.js";
import type { LambderHttpStatusCode } from "../shared/wire/LambderHttpStatus.js";
import { LambderSafeHtml } from "../shared/LambderHtml.js";
import type { LambderTemplateData } from "./LambderTemplatingEngine.js";
import type { LambderApiResponseConfig, LambderApiNullAnswerConfig } from "../shared/wire/LambderApiContract.js";
export type { LambderApiEnvelopeBody, LambderApiResponseConfig } from "../shared/wire/LambderApiContract.js";
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
/**
 * The two shapes of an API answer: the output the contract declares, or
 * `null` beside a config that says why (a refusal flag, an `errorMessage`, a
 * `message`). A bare `res.api(null)` compiles only when the output type
 * itself allows null, so a success payload is always the declared output,
 * which lets a typed caller (LambderInvokeCaller.api) promise it. Untyped
 * resolvers (`TOutput = any`) accept anything. This is the resolver's method
 * type; the core's answer type is LambderApiAnswer.
 */
export type LambderResolverApiMethod<TOutput, TResult> = {
    (payload: TOutput, config?: LambderApiResponseConfig, options?: LambderResponseOptions): TResult;
    (payload: null, config: LambderApiNullAnswerConfig, options?: LambderResponseOptions): TResult;
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
export default class LambderResponseBuilder<TResponse = any> {
    protected files: LambderFiles | null;
    protected apiVersion: string | null;
    protected ctx?: LambderRenderContext;
    /** The output schema of the API this builder answers, which every success payload is parsed through; null outside an API handler. */
    protected apiOutput: z.ZodType | null;
    constructor({ files, apiVersion, ctx, apiOutput }: {
        files?: LambderFiles | null;
        apiVersion?: string | null;
        ctx?: LambderRenderContext;
        apiOutput?: z.ZodType;
    });
    private buildResponse;
    /** The instance's file reader, which res.file and res.templateFile need. */
    private requireFiles;
    /** Appends a response header; applied onto the response once the handler has one, in call order. */
    addHeader(key: string, value: string): void;
    /** Replaces a response header; applied onto the response once the handler has one, in call order. */
    setHeader(key: string, value: string | string[]): void;
    /**
     * Adds a Set-Cookie header. A function-form `domain` is resolved against
     * the request hostname. Defaults: Path=/, SameSite=Lax, Secure, not
     * HttpOnly, browser-session lifetime.
     */
    setCookie(name: string, value: string, options?: LambderCookieOptions): void;
    /**
     * Adds a Set-Cookie header that deletes the cookie. Pass the same
     * `domain` and `path` the cookie was set with: a cookie's identity is
     * (name, domain, path), and a deletion under a different scope targets a
     * different cookie and deletes nothing.
     */
    clearCookie(name: string, options?: LambderClearCookieOptions): void;
    logToApiResponse(input: unknown): void;
    raw(init: LambderRawResponseInit): LambderResponse;
    json(data: Record<string, any>, options?: LambderResponseOptions): LambderResponse;
    text(data: string, options?: LambderResponseOptions): LambderResponse;
    xml(data: string | LambderSafeHtml, options?: LambderResponseOptions): LambderResponse;
    html(data: string | LambderSafeHtml, options?: LambderResponseOptions): LambderResponse;
    status(statusCode: LambderHttpStatusCode, body?: string, options?: LambderResponseOptions): LambderResponse;
    status404(data: string, options?: LambderResponseOptions): LambderResponse;
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
     * server-side configuration error, not a client 404). Set
     * htmlVirtualSlots to expose "title"/"head" slots on marker-less files.
     */
    templateFile(filePath: string, data?: LambderTemplateData, options?: LambderResponseOptions & {
        htmlVirtualSlots?: boolean;
    }): Promise<LambderResponse>;
    api(payload: TResponse, config?: LambderApiResponseConfig, options?: LambderResponseOptions): LambderResponse;
    api(payload: null, config: LambderApiNullAnswerConfig, options?: LambderResponseOptions): LambderResponse;
    /**
     * A payload as the API's output schema declares it. The type system
     * accepts a value that carries more than the schema (a row read straight
     * from a table is assignable to a narrower object type), and without this
     * the extra fields, a password hash included, would reach the client.
     * zod strips what the schema does not declare, fills its defaults and
     * applies its transforms, so the wire and the idempotency store only see
     * the declared shape. A refusal's payload beside an errorMessage or a
     * flag is parsed the same way; only null passes as it is. Only an API
     * handler's own resolver holds the schema: a hook, a validation handler
     * or an error handler answers in shapes of its own, a cached answer in
     * its wire form, and is sent as given.
     *
     * The payload is the schema's input form (what a handler writes before
     * the transforms), so a transform runs exactly once. A payload the schema
     * rejects is a handler breaking its contract, answered as a crash rather
     * than sent (LambderApiOutputValidationError, which an idempotency key
     * records as its answer, since the handler has already run).
     *
     * The parse is synchronous, so an output schema cannot be async: zod
     * throws from a synchronous parse that meets an async refinement or
     * transform, and a transform may throw of its own accord. Either throw
     * becomes the same LambderApiOutputValidationError, carrying what was
     * thrown as its cause. Left to escape as it is, it would read as the
     * handler crashing before its answer: the idempotency engine would
     * release the key's claim and every retry would run the operation again.
     */
    private declaredPayload;
    /** Same as api() but forces compression of the response body. */
    apiBinary(payload: TResponse, config?: LambderApiResponseConfig, options?: LambderResponseOptions): LambderResponse;
    apiBinary(payload: null, config: LambderApiNullAnswerConfig, options?: LambderResponseOptions): LambderResponse;
}
