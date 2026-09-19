import type { LambderApiSignatureMap } from "../shared/wire/LambderApiSignature.js";
import type { LambderContractGuardNames, LambderContractIdempotencyOf, LambderContractKeysWithMode, LambderContractRateLimitNames, LambderContractRateLimitOf } from "../shared/wire/LambderApiContract.js";
import type { LambderApiGuard } from "../api/LambderApiGuards.js";
import type { LambderApiRateLimitPolicyConfig } from "../api/LambderApiRateLimits.js";
import type { LambderApiRequest } from "../api/LambderApiRequest.js";
import type { LambderApiTransport } from "../shared/transport/LambderApiTransport.js";
import type { LambderCookieJar } from "../shared/transport/LambderCookieJar.js";
import type { LambderIdempotencyStore } from "../shared/contracts/LambderIdempotencyStore.js";
import type { LambderRateLimiter, LambderRateLimitWindow } from "../shared/contracts/LambderRateLimiter.js";
import type { LambderSessionStore } from "../shared/contracts/LambderSessionStore.js";
import type { LambderSessionDataRefreshConfig } from "../session/LambderSessionManager.js";
import type { LambderSessionCookieOptions } from "../session/LambderSessionController.js";
import type { LambderSessionCrypto } from "../session/LambderSessionCrypto.js";
import type { LambderMockCallContext, LambderMockGuards, LambderMockLatency, LambderMockRateLimitPolicies, LambderMockSessionCallContext, LambderMockSurplusKeys } from "./LambderMockTypes.js";
export type LambderMockSessionsOptions<S> = {
    /** Where the mock's sessions rest. Default: a fresh LambderMemorySessionStore. */
    store?: LambderSessionStore<S>;
    /** Default: "lambder-mock". */
    sessionSalt?: string;
    /** TTL of sessions signIn() creates, in seconds. Default: 30 days. */
    ttlSeconds?: number;
    /** Hashing and randomness. Default: WebCrypto where the runtime offers it, the plain stand-in over a memory-only store otherwise. */
    crypto?: LambderSessionCrypto;
    dataRefresh?: LambderSessionDataRefreshConfig<S>;
    enableSlidingExpiration?: boolean;
    slidingWriteIntervalSeconds?: number;
    tokenCookieKey?: string;
    csrfCookieKey?: string;
    cookieOptions?: LambderSessionCookieOptions;
};
/**
 * Idempotency in the mock: the same engine the server runs, over a memory
 * store unless one is given, and carrying every knob the server's own option
 * carries.
 *
 * `callerIdentity` and `defaultPendingTtlSeconds` are here because a mock
 * that cannot express them answers differently from the server on exactly the
 * calls idempotency exists for: without an identity a public endpoint's stored
 * answer replays to whoever presents the key, so a mock replayed where the
 * server, configured with one, misses.
 */
export type LambderMockIdempotencyOptions<S = any> = {
    /** Seconds a stored answer replays for. Default: 86400 (24h). Per-endpoint override: `idempotency: { ttlSeconds }`. */
    defaultTtlSeconds?: number;
    /** Seconds a claim stays pending before a retry may take the scope. Default: 300. Per-endpoint override: `idempotency: { pendingTtlSeconds }`. */
    defaultPendingTtlSeconds?: number;
    /** Run the handler when the store errors, instead of failing the call. Default: true. */
    failOpen?: boolean;
    /** Where replay records rest. Default: a fresh LambderMemoryIdempotencyStore. */
    store?: LambderIdempotencyStore;
    /**
     * Who a call is acting as, for scoping a PUBLIC endpoint's stored answer;
     * session endpoints already scope per session. The server's option word
     * for word (see LambderApiIdempotencyConfig), bound to the mock's own call
     * context, because that is the context the engine hands it here.
     *
     * Without the session, as on the server: this runs on public endpoints
     * alone, where the session is always null, so offering it would be
     * offering a field that answers nothing.
     */
    callerIdentity?: (ctx: Omit<LambderMockCallContext<S>, "session">, request: LambderApiRequest) => string | null | Promise<string | null>;
};
/** Policy names whose windows some endpoint of the contract overrides, in the map form of its rateLimit option. */
type LambderContractWindowOverrideNames<C> = {
    [K in keyof C]: LambderWindowOverrideNamesIn<LambderContractRateLimitOf<C, K>>;
}[keyof C] & string;
type LambderWindowOverrideNamesIn<R> = R extends string | readonly string[] ? never : {
    [N in keyof R]: R[N] extends object ? ([Extract<keyof R[N], LambderRateLimitWindow>] extends [never] ? never : N) : never;
}[keyof R];
/** Endpoint names whose idempotency option asks for a store (`false` is an opt-out and asks for none). */
type LambderContractIdempotentKeys<C> = {
    [K in keyof C]: [LambderContractIdempotencyOf<C, K>] extends [never] ? never : LambderContractIdempotencyOf<C, K> extends false ? never : K;
}[keyof C];
/**
 * The rate limits option: the policies endpoints may restate, the limiter
 * they are counted on, and what happens when that limiter throws.
 *
 * The policies are held to what the server's own policies were held to when
 * it registered the same endpoints, because an entry the mock's copy does not
 * fit cannot be registered, and this makes that an error at the option rather
 * than a throw when the registry loads. So the map names every policy the
 * contract references, a policy a public endpoint names is not keyed per
 * session, and a policy whose windows an endpoint overrides keeps a per-API
 * budget. Policies the contract does not reference may be added freely.
 *
 * `failOpen` is the server's own option (see LambderApiRateLimitsConfig) and
 * is here for the reason the idempotency option's twin is: with a limiter of
 * the app's own that fails, a mock that cannot express it always lets the
 * call through, so it answers 200 where a server configured to refuse answers
 * 429.
 */
type LambderMockRateLimitsOptions<C, S, P extends LambderMockRateLimitPolicies<S>> = {
    policies: P & {
        [N in keyof P]: LambderMockSurplusKeys<P[N], LambderApiRateLimitPolicyConfig<LambderMockCallContext<S>>>;
    } & {
        [N in LambderContractRateLimitNames<C>]: LambderApiRateLimitPolicyConfig<LambderMockCallContext<S>>;
    } & {
        [N in keyof P & LambderContractRateLimitNames<C, "public">]: P[N] extends {
            per: "session";
        } ? {
            per: never;
        } : unknown;
    } & {
        [N in keyof P & LambderContractWindowOverrideNames<C>]: P[N] extends {
            budget: "perPolicy";
        } ? {
            budget: never;
        } : unknown;
    };
    /** Where attempts are counted. Default: a fresh LambderMemoryRateLimiter. */
    limiter?: LambderRateLimiter;
    /** Let a call through when the limiter throws, instead of refusing it. Default: true. */
    failOpen?: boolean;
};
/**
 * The guards option: required whenever the contract declares any guard name,
 * omittable only for a contract that declares none.
 *
 * The same reasoning the entry's own guards field carries: a guard the mock
 * does not declare cannot run, and a call the server answers notAuthorized
 * then answers 200 here. Optional, it was the droppable half of exactly the
 * check it exists for.
 */
type LambderMockGuardsOption<C, S, G> = [
    LambderContractGuardNames<C>
] extends [never] ? {
    guards?: G & LambderMockGuards<C, S> & LambderMockGuardShapes<S, G>;
} : {
    guards: G & LambderMockGuards<C, S> & LambderMockGuardShapes<S, G>;
};
/**
 * The sessions, idempotency and rateLimits options: each required whenever
 * the contract has an endpoint that needs it, for the guards option's reason.
 * An entry that needs one the mock was created without cannot be registered,
 * so leaving it out is an error here rather than a throw when the registry
 * loads.
 */
type LambderMockSessionsOption<C, S> = [
    LambderContractKeysWithMode<C, "session">
] extends [never] ? {
    /** Sessions over the memory store: `true` for the defaults, or the options. Off by default. */
    sessions?: boolean | LambderMockSessionsOptions<S>;
} : {
    /** Sessions over the memory store: `true` for the defaults, or the options. Required: the contract has session endpoints. */
    sessions: true | LambderMockSessionsOptions<S>;
};
type LambderMockIdempotencyOption<C, S, I> = [
    LambderContractIdempotentKeys<C>
] extends [never] ? {
    /** Idempotency over a memory store: `true` for the defaults, or the options. Off by default. */
    idempotency?: I & LambderMockSurplusKeys<I, LambderMockIdempotencyOptions<S>>;
} : {
    /** Idempotency over a memory store: `true` for the defaults, or the options. Required: the contract has idempotent endpoints. */
    idempotency: I & ([I] extends [false] ? never : unknown) & LambderMockSurplusKeys<I, LambderMockIdempotencyOptions<S>>;
};
type LambderMockRateLimitsOption<C, S, P extends LambderMockRateLimitPolicies<S>> = [
    LambderContractRateLimitNames<C>
] extends [never] ? {
    /** The rate-limit policies endpoints may restate, over a memory limiter unless one is given. Off by default. */
    rateLimits?: LambderMockRateLimitsOptions<C, S, P>;
} : {
    /** The rate-limit policies endpoints may restate, over a memory limiter unless one is given. Required: the contract references policies. */
    rateLimits: LambderMockRateLimitsOptions<C, S, P>;
};
/** Each guard checked for surplus keys, so `sesion: true` on an inline guard is an error at the key rather than a guard that silently runs as public. */
type LambderMockGuardShapes<S, G> = {
    [N in keyof G]: LambderMockSurplusKeys<G[N], LambderApiGuard<any, any, any, LambderMockCallContext<S>, LambderMockSessionCallContext<S>>>;
};
export type LambderMockAppOptions<C, S, G, P extends LambderMockRateLimitPolicies<S> = LambderMockRateLimitPolicies<S>, I extends boolean | LambderMockIdempotencyOptions<S> = boolean | LambderMockIdempotencyOptions<S>> = LambderMockGuardsOption<C, S, G> & LambderMockSessionsOption<C, S> & LambderMockIdempotencyOption<C, S, I> & LambderMockRateLimitsOption<C, S, P> & {
    /** Stamped on every answer's envelope as apiVersion, as the server's option is. */
    apiVersion?: string;
    /** The version floor, as on the server: a call naming a lower `version` answers versionExpired whatever its signature says. */
    minApiVersion?: string;
    /** The generated signature map, as the server's option is: a call whose signature is not the map's entry for its endpoint answers versionExpired. Without it every signature passes. */
    apiSignatures?: LambderApiSignatureMap;
    /** Artificial latency per call; off by default. */
    latency?: LambderMockLatency;
    /**
     * The host the runtime's cookies belong to: what signIn plants them
     * under, what the direct transport's jar scopes them by, what the MSW
     * adapter's jar scopes them by, and what a transport request naming no
     * siteHost is read as arriving at. Default: the page's own host, or
     * "localhost" outside a browser.
     *
     * One host per app, because a jar checks a cookie's scope the way a
     * browser does: planted at "localhost" and read back on
     * "transit.localhost:5173", the session cookie is simply not sent, and
     * every session call in a browser served from anything but plain
     * localhost answered sessionExpired.
     */
    cookieHost?: string;
    /** Ceiling on what a compressed request payload may restore to. Default: 20,000,000. */
    maxRequestPayloadBytes?: number;
    /**
     * The client IP a transport request carrying none is read as. Default:
     * the loopback address. A transport may name its own, which is how a test
     * drives a `per: "ip"` rate limit from two clients.
     */
    defaultClientIp?: string;
    /** How many completed calls `calls` keeps. Default: 200. */
    callLogSize?: number;
    /**
     * Answer a handler that threw with the message it threw, rather than the
     * server's "Internal server error." Default: true, because a mock runtime
     * is a development tool and the thrown message is the thing worth seeing.
     * Set false to get the production shape.
     */
    revealHandlerErrors?: boolean;
    /** Called at the end of reset(), so the app can rewind its own data. */
    onReset?: () => void;
};
/** How the mock transport carries cookies: a fresh memory jar (default), a jar of yours, the memory jar mirrored into document.cookie, or none. */
export type LambderMockTransportOptions = {
    cookies?: LambderCookieJar | "memory" | "document" | false;
    /** The client IP its calls arrive from; defaults to the app's defaultClientIp. One transport is one client. */
    clientIp?: string;
};
/**
 * The mock's transport with the jar it carries hanging off it: an ordinary
 * LambderApiTransport wherever one is expected, and reachable where a test
 * needs the jar transport() built for itself (to read a cookie, or to clear
 * it). Null when the transport carries no cookies.
 */
export type LambderMockTransport = LambderApiTransport & {
    readonly cookieJar: LambderCookieJar | null;
};
export {};
