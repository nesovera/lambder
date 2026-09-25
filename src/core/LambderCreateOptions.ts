import type { z } from "zod";
import type { LambderApiSignatureMap } from "../shared/wire/LambderApiSignature.js";

import type { Context, APIGatewayProxyHandler, APIGatewayProxyHandlerV2 } from "aws-lambda";
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
import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";

/*
 * What an instance is configured with, and the shapes of what an app
 * registers on it.
 *
 * Everything create() takes lives here, beside the rule for which keys it
 * accepts (LambderNoExtraKeys and the nested checks under it) and the checks
 * that refuse a value, so an option is looked up in one place.
 */

export type LambderRouteHandler = (ctx: LambderRenderContext, resolver: LambderResolver) => MaybePromise<LambderResponse>;
export type LambderSessionRouteHandler<SessionData = any> = (
    ctx: LambderSessionRenderContext<any, SessionData>,
    resolver: LambderResolver,
) => MaybePromise<LambderResponse>;

// ---------------------------------------------------------------------------
// Hooks
// The "created" hook is declared beside the class in Lambder.ts instead: its
// parameter is the instance, and an options module that names the class
// cannot be read without it.
// ---------------------------------------------------------------------------
export type LambderHookEvent = "created" | "beforeRender" | "afterRender" | "fallback";
/** Return the (possibly replaced) ctx to continue, a LambderResponse to short-circuit, or an Error to fail. */
export type LambderBeforeRenderHook = (ctx: LambderRenderContext, resolver: LambderResolver) => MaybePromise<LambderRenderContext | LambderResponse | Error>;
export type LambderAfterRenderHook = (ctx: LambderRenderContext, resolver: LambderResolver, response: LambderResponse) => MaybePromise<LambderResponse | Error>;
export type LambderFallbackHook = (ctx: LambderRenderContext, resolver: LambderResolver) => void | Promise<void>;

export type LambderGlobalErrorHandler = (
    err: Error,
    ctx: LambderRenderContext | null,
    response: LambderResponseBuilder,
) => MaybePromise<LambderResponse>;

// ---------------------------------------------------------------------------
// Crashes: what the instance tells the app about a thrown error, wherever it
// was thrown, and who may read one in the answer.
// ---------------------------------------------------------------------------
/**
 * Where a crash happened.
 *
 * - `api`: an API call, from its hooks, guards or handler.
 * - `route`: any other HTTP request (a route, a served file or page, a
 *   fallback). `ctx` is null when the request could not be read at all.
 * - `event`: a non-HTTP invocation (a schedule, SNS, SQS) whose action threw,
 *   or that no action matched. The error is rethrown to Lambda after the
 *   report, so retries and dead-letter queues keep working.
 * - `startup`: a `created` hook failed before the invocation could start.
 */
export type LambderCrashSite =
    | { kind: "api"; ctx: LambderRenderContext; lambdaContext: Context }
    | { kind: "route"; ctx: LambderRenderContext | null; lambdaContext: Context }
    | { kind: "event"; event: unknown; lambdaContext: Context }
    | { kind: "startup"; lambdaContext: Context };

/**
 * Told every crash, awaited before the answer goes out (a Lambda may be
 * frozen the moment it answers, so a report left running might never land),
 * for up to `reportTimeoutMs`. A refusal is never a crash and never reaches
 * it. Anything it throws is logged and swallowed, so a broken reporter
 * cannot turn one failure into two, and a stalled one cannot turn every
 * crash into a function timeout.
 *
 * `site.ctx` is the request's context, the one a beforeRender hook handed
 * back when one did, secrets included (the session cookie, a login's
 * password in the body, the session record): forward the fields a crash
 * needs rather than the whole context to an error tracker.
 */
export type LambderCrashReporter = (error: Error, site: LambderCrashSite) => MaybePromise<void>;

/** The `crashes` option of create(). */
export type LambderCrashOptions = {
    /** Told every crash on every path; see LambderCrashReporter. Default: none, and the framework's own 500 logs the crash to the console instead. */
    report?: LambderCrashReporter;
    /**
     * How long a crash's answer waits for the reporter, in milliseconds. A
     * report still running then is logged, with the crash, as unfinished,
     * and the request is answered. Default: 3000.
     */
    reportTimeoutMs?: number;
    /**
     * Whether the caller behind this request may read the crash: when true,
     * the framework's 500 carries it in full (describeCrash on an API call's
     * `crash` field, beside the call's logList; the stack as text on a
     * route). For a developer's own browser or a trusted invoker. It governs
     * the framework's answer only: an app that sets a global error handler
     * writes its own answer, and describeCrash is there for it. A reveal
     * that throws counts as no. Default: nobody.
     */
    reveal?: (ctx: LambderRenderContext) => MaybePromise<boolean>;
};
export type LambderFallbackHandler = (ctx: LambderRenderContext, resolver: LambderResolver) => MaybePromise<LambderResponse>;
export type LambderInputValidationHandler = (ctx: LambderRenderContext, resolver: LambderResolver, zodError: z.ZodError) => MaybePromise<LambderResponse>;


// ---------------------------------------------------------------------------
// Actions: one handler list entry that can match on the raw Lambda event
// (non-HTTP triggers) or on the HTTP context.
// ---------------------------------------------------------------------------
/**
 * Second argument of an addAction handler. Discriminated on `ctx`: HTTP
 * invocations get the full context and a resolver, non-HTTP invocations get
 * null for both.
 */
export type LambderActionTools =
    | { ctx: LambderRenderContext; res: LambderResolver; lambdaContext: Context }
    | { ctx: null; res: null; lambdaContext: Context };

export type LambderActionFilter = (event: unknown, ctx: LambderRenderContext | null) => boolean;
export type LambderActionHandler<TEvent = unknown> = (event: TEvent, tools: LambderActionTools) => MaybePromise<unknown>;

/** Overloaded handler type returned by getHandler(): HTTP events get a typed response, others dispatch to actions. */
export type LambderHandler = {
    (event: LambderHttpEvent, context: Context): Promise<LambderHttpResponse>;
    (event: unknown, context: Context): Promise<unknown>;
};

// Compile-time guarantees: getHandler() output is a valid official AWS handler.
type AssertAssignable<T extends true> = T;
type _AssertHandlerV1 = AssertAssignable<LambderHandler extends APIGatewayProxyHandler ? true : false>;
type _AssertHandlerV2 = AssertAssignable<LambderHandler extends APIGatewayProxyHandlerV2 ? true : false>;

/** Session configuration (the `session` option of create/new): where sessions rest, and how their cookies are scoped. */
export type LambderSessionOptions<TSessionData = any> = {
    /**
     * Where sessions rest: a LambderDdbSessionStore over your table, a
     * LambderMemorySessionStore in tests, or your own LambderSessionStore.
     *
     * Deliberately typed over `any`, not TSessionData. The session data type
     * is the app's declaration (initLambder<SessionData>()), and a store holds
     * whatever the app puts in it; naming TSessionData here would make
     * `new Lambder({ session: { store } })` INFER the session data type from
     * the store, so ctx.session.data would be typed by the table.
     */
    store: LambderSessionStore<any>;
    /** The HMAC key that turns a sessionKey into the store's partition key, so a table read does not reveal whose sessions it holds. Treat as a secret. */
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
 * serving options plus the type-affecting policy layer (rate limits, guards,
 * idempotency) and session/CORS config. The instance is born fully
 * configured and fully typed (via initLambder), so there are no ordering
 * rules and no partially-configured instance type.
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
    /**
     * Stamped on every API answer's envelope as `apiVersion`, so a client can
     * tell which build answered. Staleness is decided per endpoint by the
     * signature a client sends (see Lambder.apiSignatures()); only
     * `minApiVersion` reads this string. Dotted numbers ("1.2.10"), as the
     * floor compares them, so a commit sha or a build date is refused rather
     * than read as zero.
     */
    apiVersion?: string;
    /**
     * The oldest client build still served: a call naming a `version` below
     * it answers `versionExpired` whatever its signature says. The lever for
     * a change the signatures cannot see (a security fix, a field whose
     * meaning changed under the same shape). Dotted numbers ("1.2.10"),
     * compared segment by segment; a call naming no version is not judged. A
     * floor above `apiVersion` is taken as `apiVersion`, with a warning, so a
     * mistaken floor cannot refuse this build's own clients. Default: none.
     */
    minApiVersion?: string;
    /**
     * The generated signature map (Lambder.apiSignatures()), the same file
     * the frontend ships with. Enables the signature gate: a call carrying a
     * signature that is not this map's entry for its endpoint answers
     * `versionExpired`. Generated once, at build time, and handed to both
     * sides, so nothing is digested at request time and the two sides cannot
     * disagree on a digest. Default: none, and no gate.
     */
    apiSignatures?: LambderApiSignatureMap;
    /**
     * Automatic compression for compressible responses. `true` is
     * `{ minBytes: 860, encodings: ["br", "gzip"], quality: 5 }`, the default
     * behind an HTTP API or a Function URL; behind a REST API it is off unless
     * named here, since a REST API decodes base64 only for its
     * binaryMediaTypes. `false` disables it. `encodings` is a preference order, so `["gzip"]` opts out
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
     * Only list a header something in front of this app always overwrites:
     * `per: "ip"` rate limits key off ctx.ip, and an address the caller picks
     * per request is not a limit. API Gateway APPENDS to x-forwarded-for, so
     * behind API Gateway alone the leftmost entry is the client's own claim
     * and the header should be left out. A direct invoke reads none of these:
     * its ctx.ip is the invoker's `clientIp`.
     */
    trustedClientIpHeaders?: readonly string[];
    /**
     * Headers that may name the host the viewer asked for, in order of
     * preference, e.g. ["x-forwarded-host"] for a Function URL behind
     * CloudFront, which sends the origin its own lambda-url Host. Default:
     * none, so ctx.host is the Host the gateway received.
     *
     * The same rule as trustedClientIpHeaders: ctx.host decides cookie
     * domains and host-matched routes, and a host a client picks is a tenant
     * a client picks. A direct invoke reads none of these: its ctx.host is the
     * invoker's `host`.
     */
    trustedHostHeaders?: readonly string[];
    /** CORS: true allows any origin; or pass a LambderCorsConfig. Default: off. */
    cors?: boolean | LambderCorsConfig;
    /** Sessions over a store of your choosing; required for addSessionApi/addSessionRoute. */
    session?: LambderSessionOptions<TSessionData>;
    /** Declarative per-API rate limiting: your limiter plus named policies APIs reference (typed) via the `rateLimit` option. */
    rateLimits?: LambderApiRateLimitsConfig<Record<string, LambderApiRateLimitPolicyConfig<LambderRenderContext>>>;
    /**
     * Named guards APIs reference (typed) via the `guards` option; build each
     * with `initLambder<SessionData>().guard()`, whose handlers see the app's
     * session type, or lambderGuard(). Pinned to the render contexts, so a
     * guard built for another adapter, or for another session type, is
     * rejected here rather than reading fields that are not on its context.
     */
    guards?: Record<string, LambderApiGuard<any, any, any, LambderRenderContext<any, Record<string, string>, {}, TSessionData>, LambderSessionRenderContext<any, TSessionData>>>;
    /**
     * Make an authorization declaration part of registering a session API:
     * every addSessionApi must declare `guards`, at the type level (a missing
     * `guards` is a compile error) and at registration (a plain-JS caller
     * throws). An API whose session is the whole authorization (the
     * signed-in user's own account) declares a named no-op session guard, so
     * every opt-out is explicit and one grep lists them all. Needs a guards
     * map to pick from. Default: false.
     */
    requireSessionApiGuards?: boolean;
    /**
     * The same for public APIs: every addApi must declare `guards`, at the
     * type level and at registration.
     *
     * Public APIs are open by default, which is the right default, so this is
     * off unless an app decides otherwise. Turned on, a public endpoint's
     * openness becomes a written decision rather than an omission: the ones
     * anybody may call declare a named no-op guard carrying the reason, and
     * the ones that authorize their caller some other way (a signature, a
     * device secret, a one-shot token) name where that happens. One grep over
     * the guard names then lists every public door and why it is open. Needs
     * a guards map to pick from. Default: false.
     */
    requirePublicApiGuards?: boolean;
    /** Declarative idempotency: your store plus replay defaults; APIs opt in via `idempotency: true | { ttlSeconds }`. */
    idempotency?: LambderApiIdempotencyConfig;
    /** Crash reporting on every path, and who may read a crash in the answer. See LambderCrashOptions. */
    crashes?: LambderCrashOptions;
};

/**
 * What the `guards` field asks for when an API on a require*ApiGuards
 * instance declares none. With nothing to infer from, the inference parameter
 * defaults to `never`, and "Property 'guards' is missing ... but required in
 * type { guards: never }" would read as though nothing could be written
 * there; the property name says what is wanted.
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
export type LambderRequirableGuardsField<TRequired extends boolean, TGuardsOpt> = TRequired extends true
    ? {
        /** Named guards, run in declared order before input validation (after it for a guard declared runAt: "afterInputValidation"): a name, a non-empty list of names, or a non-empty { name: param } map for parameterized guards. Required on this instance: an API that needs no authorization declares a named no-op guard, so every opt-out is explicit and one grep lists them all. Their input requirements merge into this API's contract input; their return values land typed on ctx.guardData. */
        guards: [TGuardsOpt] extends [never] ? LambderGuardsDeclarationRequired : TGuardsOpt;
    }
    : {
        /** Named guards, run in declared order before input validation (after it for a guard declared runAt: "afterInputValidation"): a name, a non-empty list of names, or a non-empty { name: param } map for parameterized guards. Their input requirements merge into this API's contract input; their return values land typed on ctx.guardData. */
        guards?: TGuardsOpt;
    };


/**
 * Rejects a key the options type does not have, which `const TOptions` would
 * otherwise wave through: inferring a generic from an object literal switches
 * excess-property checking off for the whole literal, so
 * `requireSessionApiGuard` (no trailing "s") or `maxResponseByte` would
 * compile, be dropped in silence, and leave the app on the default. That is
 * worst for the two require*ApiGuards flags, which exist to make a missing
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
type LambderOptionShape<TSessionData, TKey extends keyof LambderCreateOptions<TSessionData>> =
    NonNullable<LambderCreateOptions<TSessionData>[TKey]>;

/**
 * The surplus-key rule one level down, over the option objects a typo is
 * worst on. Excess-property checking is off for the WHOLE literal under
 * `const TOptions`, nested objects included, and the top-level rule does not
 * reach inside them. Unchecked, `idempotency: { failOpn: false }` would leave
 * the engine failing open, `callerIdentitiy` would leave every public replay
 * key a bearer token, `session: { tokenCookieKe }` would leave the session
 * cookie under its default name, and `guards: { g: { sesion: true } }` would
 * leave a guard reading a context with no session. Each nested object is
 * checked against its own option's shape, so the error lands on the
 * misspelled key.
 */
export type LambderNestedOptionChecks<TSessionData, TOptions extends LambderCreateOptions<TSessionData>> = {
    session?: LambderNoExtraKeys<NonNullable<TOptions["session"]>, LambderOptionShape<TSessionData, "session">> & {
        cookie?: LambderNoExtraKeys<NonNullable<NonNullable<TOptions["session"]>["cookie"]>, LambderSessionCookieOptions>;
    };
    idempotency?: LambderNoExtraKeys<NonNullable<TOptions["idempotency"]>, LambderOptionShape<TSessionData, "idempotency">>;
    crashes?: LambderNoExtraKeys<NonNullable<TOptions["crashes"]>, LambderOptionShape<TSessionData, "crashes">>;
    rateLimits?: LambderNoExtraKeys<NonNullable<TOptions["rateLimits"]>, LambderOptionShape<TSessionData, "rateLimits">> & {
        policies?: {
            [TPolicy in keyof NonNullable<TOptions["rateLimits"]>["policies"]]:
                LambderNoExtraKeys<NonNullable<TOptions["rateLimits"]>["policies"][TPolicy], LambderApiRateLimitPolicyConfig<LambderRenderContext>>;
        };
    };
    guards?: {
        [TGuard in keyof NonNullable<TOptions["guards"]>]:
            LambderNoExtraKeys<NonNullable<TOptions["guards"]>[TGuard], LambderOptionShape<TSessionData, "guards">[string]>;
    };
    // The object form of `files` (`{ source, memoryCache }`); a bare source
    // is a class instance and has nothing to misspell.
    files?: TOptions["files"] extends { source: unknown }
        ? LambderNoExtraKeys<TOptions["files"], Extract<LambderFilesOption, { source: unknown }>>
        : unknown;
    // `cors` and `compression` are `boolean | object`, so the check applies
    // only to the object form. cors matters most: a typo beside a valid key
    // (`{ origns: [...] }`) would leave the config with no allowlist, which
    // allowedCorsOriginOf reads as `"*"`, every origin allowed.
    cors?: TOptions["cors"] extends object
        ? LambderNoExtraKeys<TOptions["cors"], LambderCorsConfig>
        : unknown;
    compression?: TOptions["compression"] extends object
        ? LambderNoExtraKeys<TOptions["compression"], LambderResponseCompressionSettings>
        : unknown;
};


/**
 * Everything create() refuses before an instance exists, in one place: a
 * value that cannot work is a startup error naming the option, not a 404 on
 * every API call (an apiPath with no leading slash) or a 500 on every
 * response (maxResponseBytes: 0) that an app discovers in production.
 */
export const assertCreateOptions = (options: LambderCreateOptions<any>): void => {
    // The path is compared to ctx.path, which always starts with a slash, so
    // apiPath: "api" would make every API call a 404 with no reason given.
    if(options.apiPath !== undefined && (options.apiPath === "" || !options.apiPath.startsWith("/"))){
        throw new Error(`Lambder: apiPath must be a path starting with "/", got ${JSON.stringify(options.apiPath)}.`);
    }
    // 0 or a negative ceiling would turn every response into the size guard's own 500.
    if(options.maxResponseBytes !== undefined) assertPositiveInteger(options.maxResponseBytes, "maxResponseBytes");
    // 0 or a negative bound would give up on every report before it started.
    if(options.crashes?.reportTimeoutMs !== undefined) assertPositiveInteger(options.crashes.reportTimeoutMs, "crashes.reportTimeoutMs");

    // Credentials with every origin allowed would echo whatever Origin asked,
    // so any website could read a signed-in user's session routes. The usual
    // reason to turn credentials on (SameSite=None cookies) is exactly the
    // setting in which that is reachable.
    const cors = options.cors;
    if(typeof cors === "object" && cors.credentials && (cors.origins === undefined || cors.origins === "*")){
        throw new Error('Lambder: cors.credentials needs cors.origins to be an allowlist or a predicate. With every origin allowed, any website could make credentialed calls and read the answers.');
    }

    if((options.requireSessionApiGuards || options.requirePublicApiGuards) && !options.guards){
        const requireFlag = options.requireSessionApiGuards ? "requireSessionApiGuards" : "requirePublicApiGuards";
        throw new Error(`Lambder: ${requireFlag} needs a guards map at creation for APIs to declare from.`);
    }
};
