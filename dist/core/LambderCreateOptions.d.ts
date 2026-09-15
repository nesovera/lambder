import type { z } from "zod";
import type { Context } from "aws-lambda";
import type LambderResolver from "./LambderResolver.js";
import type LambderResponseBuilder from "./LambderResponseBuilder.js";
import type { LambderResponse, LambderHttpResponse, LambderResponseCompressionOption, LambderResponseCompressionSettings } from "./LambderResponse.js";
import type { LambderRenderContext, LambderSessionRenderContext, LambderHttpEvent } from "./LambderContext.js";
import type { LambderFilesOption } from "./LambderFiles.js";
import type { LambderCorsConfig } from "./LambderCors.js";
import type { LambderSessionDataRefreshConfig } from "../session/LambderSessionManager.js";
import type { LambderSessionStore } from "../shared/contracts/LambderSessionStore.js";
import type { LambderSessionCookieOptions } from "../session/LambderSessionController.js";
import type { LambderSessionCrypto } from "../session/LambderSessionCrypto.js";
import type { LambderApiGuard } from "../api/LambderApiGuards.js";
import type { LambderApiRateLimitPolicyConfig, LambderApiRateLimitsConfig } from "../api/LambderApiRateLimits.js";
import type { LambderApiIdempotencyConfig } from "../api/LambderApiIdempotency.js";
import type { MaybePromise } from "../shared/util/LambderTypeUtilities.js";
export type LambderRouteHandler = (ctx: LambderRenderContext, resolver: LambderResolver) => MaybePromise<LambderResponse>;
export type LambderSessionRouteHandler<SessionData = any> = (ctx: LambderSessionRenderContext<any, SessionData>, resolver: LambderResolver) => MaybePromise<LambderResponse>;
export type LambderHookEvent = "created" | "beforeRender" | "afterRender" | "fallback";
/** Return the (possibly replaced) ctx to continue, a LambderResponse to short-circuit, or an Error to fail. */
export type LambderBeforeRenderHook = (ctx: LambderRenderContext, resolver: LambderResolver) => MaybePromise<LambderRenderContext | LambderResponse | Error>;
export type LambderAfterRenderHook = (ctx: LambderRenderContext, resolver: LambderResolver, response: LambderResponse) => MaybePromise<LambderResponse | Error>;
export type LambderFallbackHook = (ctx: LambderRenderContext, resolver: LambderResolver) => void | Promise<void>;
export type LambderGlobalErrorHandler = (err: Error, ctx: LambderRenderContext | null, response: LambderResponseBuilder) => MaybePromise<LambderResponse>;
export type LambderFallbackHandler = (ctx: LambderRenderContext, resolver: LambderResolver) => MaybePromise<LambderResponse>;
export type LambderInputValidationHandler = (ctx: LambderRenderContext, resolver: LambderResolver, zodError: z.ZodError) => MaybePromise<LambderResponse>;
/**
 * Second argument of an addAction handler. Discriminated on `ctx`: HTTP
 * invocations get the full context and a resolver, non-HTTP invocations get
 * null for both.
 */
export type LambderActionTools = {
    ctx: LambderRenderContext;
    res: LambderResolver;
    lambdaContext: Context;
} | {
    ctx: null;
    res: null;
    lambdaContext: Context;
};
export type LambderActionFilter = (event: unknown, ctx: LambderRenderContext | null) => boolean;
export type LambderActionHandler<TEvent = unknown> = (event: TEvent, tools: LambderActionTools) => MaybePromise<unknown>;
/** Overloaded handler type returned by getHandler(): HTTP events get a typed response, others dispatch to actions. */
export type LambderHandler = {
    (event: LambderHttpEvent, context: Context): Promise<LambderHttpResponse>;
    (event: unknown, context: Context): Promise<unknown>;
};
/** Session configuration (the `session` option of create/new): where sessions rest, and how their cookies are scoped. */
export type LambderSessionOptions<TSessionData = any> = {
    /**
     * Where sessions rest: a LambderDdbSessionStore over your table, a
     * LambderMemorySessionStore in tests, or your own LambderSessionStore.
     *
     * Typed over `any` rather than over TSessionData deliberately. The session
     * data type is the app's declaration (initLambder<SessionData>()), and a
     * store is a storage backend that holds whatever the app puts in it;
     * naming TSessionData here would make `new Lambder({ session: { store } })`
     * INFER the session data type from the store instead, so an app that never
     * said otherwise would find ctx.session.data typed by its table.
     */
    store: LambderSessionStore<any>;
    /** Salts the sessionKey hash that partitions the store. */
    sessionSalt: string;
    enableSlidingExpiration?: boolean;
    /** Min seconds between sliding-expiration writes. Default: max(60, 5% of TTL). */
    slidingWriteIntervalSeconds?: number;
    /** Session cookie attributes, e.g. { domain: ".example.com" } for cross-subdomain sessions. `domain` may be a (hostname) => string function for multi-domain deployments. */
    cookie?: LambderSessionCookieOptions;
    /** Session cookie names. Defaults: LMDRSESSIONTKID / LMDRSESSIONCSTK. */
    tokenCookieKey?: string;
    csrfCookieKey?: string;
    /**
     * Opt-in freshness for session.data derived from external state (roles,
     * permissions, feature flags...). Every session read renews data past
     * its ttlSeconds via your refresh callback, persisting in place on the
     * same record: same tokens, same cookies. Return null from refresh to
     * end the session. See LambderSessionDataRefreshConfig for the exact
     * semantics.
     */
    dataRefresh?: LambderSessionDataRefreshConfig<TSessionData>;
    /** Hashing and randomness for the session tokens. Default: WebCrypto. */
    crypto?: LambderSessionCrypto;
};
/**
 * Everything an instance is configured with, in ONE declaration: base
 * serving options plus the type-affecting policy layer (rate limits,
 * guards, idempotency) and session/CORS config. There are no enable/define
 * chain methods; the instance is born fully configured and fully typed
 * (via initLambder), so no ordering rules exist and no partially-configured
 * instance type ever needs a name.
 */
export type LambderCreateOptions<TSessionData = any> = {
    /**
     * Where the app's files come from, for servePublicFiles, serveIndexHtml,
     * res.file and res.templateFile: a LambderLocalFileSource over a folder
     * (the build output bundled with the deployment), a LambderS3FileSource
     * (S3, R2), or any LambderFileSource; or `{ source, memoryCache }` to
     * tune or disable the in-memory file cache. Required by those features.
     */
    files?: LambderFilesOption;
    apiPath?: string;
    apiVersion?: string;
    /**
     * Automatic compression for compressible responses. `true` (the default)
     * is `{ minBytes: 860, encodings: ["br", "gzip"], quality: 5 }`; `false`
     * disables it. `encodings` is a preference order, so `["gzip"]` opts out
     * of Brotli for a client or CDN that mishandles it, and `quality` is the
     * Brotli quality, the same field the at-rest stores take.
     */
    compression?: LambderResponseCompressionOption;
    /** Automatic ETag + If-None-Match 304 on GET/HEAD 200 responses. Default: true. */
    etag?: boolean;
    /** Guard threshold for Lambda's ~6MB response cap. Default: 5,500,000. */
    maxResponseBytes?: number;
    /**
     * Ceiling on what a gzipped request payload may restore to (Lambda's
     * ~6MB invoke cap already bounds the compressed bytes). Default:
     * 20,000,000. Requests over it are refused rather than decompressed.
     * The restored JSON is parsed in full before any policy or session
     * check, so size it to the function's memory.
     */
    maxRequestPayloadBytes?: number;
    /**
     * Headers that may name the caller's own address, in order of preference,
     * e.g. ["cf-connecting-ip"] behind Cloudflare or ["x-forwarded-for"]
     * behind a proxy that rewrites it. Default: none, so ctx.ip is the address
     * the gateway observed.
     *
     * Only list a header something in front of this app always overwrites. A
     * header a client can set is a value a client can choose, and `per: "ip"`
     * rate limits key off ctx.ip: one that a caller picks per request is not a
     * limit. Note that API Gateway APPENDS to x-forwarded-for rather than
     * replacing it, so behind API Gateway alone the leftmost entry is the
     * client's own claim and the header should be left out.
     */
    trustedClientIpHeaders?: readonly string[];
    /** CORS: true allows any origin; or pass a LambderCorsConfig. Default: off. */
    cors?: boolean | LambderCorsConfig;
    /** Sessions over a store of your choosing; required for addSessionApi/addSessionRoute. */
    session?: LambderSessionOptions<TSessionData>;
    /** Declarative per-API rate limiting: your limiter plus named policies APIs reference (typed) via the `rateLimit` option. */
    rateLimits?: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig<LambderRenderContext>>>;
    /** Named guards APIs reference (typed) via the `guards` option; build each with lambderGuard(). Pinned to the render contexts, so a guard built for another adapter is rejected here rather than reading fields that are not on its context. */
    guards?: Record<string, LambderApiGuard<any, any, any, LambderRenderContext, LambderSessionRenderContext<any, any>>>;
    /**
     * Make an authorization declaration part of registering a session API:
     * every addSessionApi must declare `guards`, at the type level (a
     * missing `guards` is a compile error) and at registration (a plain-JS
     * caller throws). An API that legitimately needs none, because the
     * session itself is the whole authorization (the signed-in user's own
     * account), declares a named no-op session guard, so every opt-out is
     * explicit and one grep lists them all. Needs a guards map to pick
     * from. Default: false.
     */
    requireSessionApiGuards?: boolean;
    /**
     * The same for public APIs: every addApi must declare `guards`, at the
     * type level and at registration.
     *
     * Public APIs are open by default and that is the right default, so this
     * is off unless an app decides otherwise. What it buys an app that turns
     * it on is that a public endpoint's openness becomes a written decision
     * rather than an omission: the ones anybody may call declare a named no-op
     * guard carrying the reason, and the ones that authorize their caller some
     * other way (a signature, a device secret, a one-shot token) name where
     * that happens. One grep over the guard names then lists every public
     * door and why it is open, which is the review question a growing public
     * surface makes expensive to answer any other way. Needs a guards map to
     * pick from. Default: false.
     */
    requirePublicApiGuards?: boolean;
    /** Declarative idempotency: your store plus replay defaults; APIs opt in via `idempotency: true | { ttlSeconds }`. */
    idempotency?: LambderApiIdempotencyConfig;
};
/**
 * What the `guards` field asks for when an API on a require*ApiGuards
 * instance declares none. The inference parameter defaults to `never` with
 * nothing to infer from, and the resulting "Property 'guards' is missing ...
 * but required in type { guards: never }" read as though nothing could ever
 * be written there; the property name says what is actually wanted.
 */
type LambderGuardsDeclarationRequired = {
    readonly "lambder: this instance requires every API of this kind to declare guards. Name the guard that authorizes this API, or the named no-op guard that records why anyone may call it.": never;
};
/**
 * What addSessionApi and addSessionRoute need of the instance they are called
 * on. Nothing satisfies it without the session option, so registering a
 * session API on an instance that has no sessions is a compile error rather
 * than only the registration-time throw.
 */
type LambderSessionOptionRequired = {
    readonly "lambder: sessions are not configured on this instance. Pass the session option to create() before registering a session API or a session route.": never;
};
/**
 * Intersected into what addSessionApi and addSessionRoute take, so an
 * instance created without the session option refuses the registration at
 * the call site. `unknown` once sessions are configured, which intersects
 * away to nothing.
 */
export type LambderSessionEnabledInstance<TSessionsEnabled extends boolean> = TSessionsEnabled extends true ? unknown : LambderSessionOptionRequired;
/**
 * The `guards` field of an API's options: optional by default, required once
 * create() received the require*ApiGuards flag for that kind of API, so that
 * an authorization declaration cannot be forgotten at the type level.
 *
 * One type for both kinds: the requirement is the same shape either way, and
 * only which flag switches it on differs.
 */
export type LambderRequirableGuardsField<TRequired extends boolean, TGuardsOpt> = TRequired extends true ? {
    /** Named guards, run in declared order before input validation: a name, a non-empty list of names, or a non-empty { name: param } map for parameterized guards. Required on this instance: an API that needs no authorization declares a named no-op guard, so every opt-out is explicit and one grep lists them all. Their input requirements merge into this API's contract input; their return values land typed on ctx.guardData. */
    guards: [TGuardsOpt] extends [never] ? LambderGuardsDeclarationRequired : TGuardsOpt;
} : {
    /** Named guards, run in declared order before input validation: a name, a non-empty list of names, or a non-empty { name: param } map for parameterized guards. Their input requirements merge into this API's contract input; their return values land typed on ctx.guardData. */
    guards?: TGuardsOpt;
};
/**
 * Rejects a key the options type does not have, which `const TOptions` would
 * otherwise wave through: inferring a generic from an object literal switches
 * excess-property checking off for the whole literal, so `requireSessionApiGuard`
 * (no trailing "s") or `maxResponseByte` would compile, be dropped in silence,
 * and leave the app running with the default. That matters most for exactly
 * the two flags a typo is worst on, since both exist to make a missing
 * authorization declaration a compile error. Mapping every surplus key to
 * `never` puts the error back on the key itself.
 */
export type LambderNoExtraKeys<TOptions, TShape> = TOptions & Record<Exclude<keyof TOptions, keyof TShape>, never>;
/**
 * What create() was actually given for one option, or undefined when the
 * literal does not carry the key at all.
 *
 * `TOptions[TKey]` on its own answers with the CONSTRAINT's type for a key
 * the literal omits, so a flag nobody passed reads as `boolean | undefined`,
 * which is "somebody might have set it" rather than "nobody did".
 */
export type LambderGivenOption<TOptions, TKey extends PropertyKey> = TKey extends keyof TOptions ? TOptions[TKey] : undefined;
/**
 * One option's declared shape, read back off LambderCreateOptions rather than
 * named a second time, so the nested checks below cannot drift from the
 * option they check.
 */
type LambderOptionShape<TSessionData, TKey extends keyof LambderCreateOptions<TSessionData>> = NonNullable<LambderCreateOptions<TSessionData>[TKey]>;
/**
 * The surplus-key rule one level down, over the option objects a typo is
 * worst on.
 *
 * Excess-property checking is off for the WHOLE literal under `const
 * TOptions`, nested objects included, so the top-level rule caught nothing
 * where it mattered most: `idempotency: { failOpn: false }` left the engine
 * failing open, `callerIdentitiy` left every public replay key a bearer
 * token, `session: { tokenCookieKe }` left the session cookie under its
 * default name, and `guards: { g: { sesion: true } }` left a guard reading a
 * context with no session. Each nested object is checked against the shape
 * its own option declares, so the error lands on the misspelled key.
 */
export type LambderNestedOptionChecks<TSessionData, TOptions extends LambderCreateOptions<TSessionData>> = {
    session?: LambderNoExtraKeys<NonNullable<TOptions["session"]>, LambderOptionShape<TSessionData, "session">> & {
        cookie?: LambderNoExtraKeys<NonNullable<NonNullable<TOptions["session"]>["cookie"]>, LambderSessionCookieOptions>;
    };
    idempotency?: LambderNoExtraKeys<NonNullable<TOptions["idempotency"]>, LambderOptionShape<TSessionData, "idempotency">>;
    rateLimits?: LambderNoExtraKeys<NonNullable<TOptions["rateLimits"]>, LambderOptionShape<TSessionData, "rateLimits">> & {
        policies?: {
            [TPolicy in keyof NonNullable<TOptions["rateLimits"]>["policies"]]: LambderNoExtraKeys<NonNullable<TOptions["rateLimits"]>["policies"][TPolicy], LambderApiRateLimitPolicyConfig<LambderRenderContext>>;
        };
    };
    guards?: {
        [TGuard in keyof NonNullable<TOptions["guards"]>]: LambderNoExtraKeys<NonNullable<TOptions["guards"]>[TGuard], LambderOptionShape<TSessionData, "guards">[string]>;
    };
    files?: TOptions["files"] extends {
        source: unknown;
    } ? LambderNoExtraKeys<TOptions["files"], Extract<LambderFilesOption, {
        source: unknown;
    }>> : unknown;
    cors?: TOptions["cors"] extends object ? LambderNoExtraKeys<TOptions["cors"], LambderCorsConfig> : unknown;
    compression?: TOptions["compression"] extends object ? LambderNoExtraKeys<TOptions["compression"], LambderResponseCompressionSettings> : unknown;
};
/**
 * Everything create() refuses before an instance exists.
 *
 * One place rather than five checks spread through the constructor's wiring:
 * a value that cannot work is a startup error naming the option, not a 404 on
 * every API call (an apiPath with no leading slash) or a 500 on every response
 * (maxResponseBytes: 0) that an app discovers in production.
 */
export declare const assertCreateOptions: (options: LambderCreateOptions<any>) => void;
export {};
