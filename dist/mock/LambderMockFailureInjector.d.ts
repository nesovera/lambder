import type { LambderApiAnswer } from "../api/LambderApiAnswer.js";
import type { LambderApiRequest } from "../api/LambderApiRequest.js";
import type { LambderMockFailure, LambderMockFailureReason, LambderMockLatency } from "./LambderMockTypes.js";
/**
 * A failure the transport reports rather than an answer the caller reads:
 * an injected network failure or timeout. The caller maps a rejected
 * transport to `network`, or `timeout` when its own abort fired.
 */
export declare class LambderMockTransportError extends Error {
    readonly reason: "network" | "timeout" | "offline";
    constructor(reason: "network" | "timeout" | "offline");
}
/**
 * What a call fails with and how long it takes to do it: the queued and
 * standing failures per endpoint, the offline switch, and the configured
 * latency. State nothing else in LambderMockApp touches, so it is its own
 * object; the app's failNext, setFailure, setOffline and setLatency delegate
 * here.
 *
 * Injected refusals are rendered through the real envelope helpers, never
 * hand-written: an injected 429 and an earned one have to be the same bytes,
 * or a test written against the injected shape passes while the real one
 * would fail.
 */
export declare class LambderMockFailureInjector {
    private readonly failuresNext;
    private readonly failuresSet;
    private offlineFlag;
    private latency;
    /** What latency was configured at creation, so reset() can put it back. */
    private readonly initialLatency;
    private readonly apiVersion;
    constructor(options: {
        apiVersion: string | null;
        latency: LambderMockLatency;
    });
    /** True while every call should reject at the transport, as with no network at all. */
    get offline(): boolean;
    /** The next call to the endpoint fails this way; several calls queue in order. */
    failNext(apiName: string, failure: LambderMockFailure | LambderMockFailureReason): void;
    /** Every call to the endpoint fails this way until cleared with null. */
    setFailure(apiName: string, failure: LambderMockFailure | LambderMockFailureReason | null): void;
    setOffline(offline: boolean): void;
    setLatency(latency: LambderMockLatency): void;
    /** The failure this call should take, queued one first; null when the call should run. */
    take(apiName: string): LambderMockFailure | null;
    /** Milliseconds this call should take before it is answered. */
    latencyFor(apiName: string): number;
    /** Waits the configured latency, cancelled by the caller's abort. */
    wait(ms: number, signal: AbortSignal | undefined): Promise<void>;
    /** Waits for the caller's own abort, which is what a timeout is; a call with no signal waits for ever. */
    waitForAbort(signal: AbortSignal | undefined): Promise<never>;
    /** The answer an injected failure produces, or a throw for the ones that never reach the caller as answers. */
    answerFor(failure: LambderMockFailure, request: LambderApiRequest): Promise<LambderApiAnswer>;
    /** Clears every injected failure and puts the configured latency back. */
    reset(): void;
}
