import { LambderApiRefusal, type LambderUncheckedRefusalMessage } from "../shared/wire/LambderApiRefusal.js";
import { crashAnswer, refusalAnswer, sessionExpiredAnswer, versionExpiredAnswer } from "../api/LambderApiEnvelope.js";
import { rateLimitRefusal } from "../api/LambderApiRateLimits.js";
import { checkedRefusal, type LambderEndpointRefusals } from "../api/LambderApiRefusals.js";
import type { LambderApiAnswer } from "../api/LambderApiAnswer.js";
import type { LambderApiRequest } from "../api/LambderApiRequest.js";
import type { LambderMockFailure, LambderMockFailureReason, LambderMockLatency } from "./LambderMockTypes.js";

/** An injected refusal's message, from a string, a full message, or the reason's own wording. */
const toRefusalMessage = (message: LambderUncheckedRefusalMessage | string | undefined, fallback: string): LambderUncheckedRefusalMessage =>
    typeof message === "string" ? { type: "warning", content: message }
    : message ?? { type: "warning", content: fallback };

/** What an injected failure answers, and whether that answer ends the session the call carries. */
type LambderMockInjectionResult = { answer: LambderApiAnswer; endsSession: boolean };

/**
 * A failure the transport reports rather than an answer the caller reads:
 * an injected network failure or timeout. The caller maps a rejected
 * transport to `network`, or to `timeout` or `aborted` when the call's own
 * timeout or signal had aborted it.
 */
export class LambderMockTransportError extends Error {
    readonly reason: "network" | "timeout" | "offline";
    constructor(reason: "network" | "timeout" | "offline"){
        super(`LambderMockApp: ${reason === "offline" ? "the mock is offline" : `injected ${reason} failure`}`);
        this.name = "LambderMockTransportError";
        this.reason = reason;
    }
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
export class LambderMockFailureInjector {
    private readonly failuresNext = new Map<string, LambderMockFailure[]>();
    private readonly failuresSet = new Map<string, LambderMockFailure>();
    private offlineFlag = false;
    private latency: LambderMockLatency;
    /** What latency was configured at creation, so reset() can put it back. */
    private readonly initialLatency: LambderMockLatency;
    private readonly apiVersion: string | null;

    constructor(options: { apiVersion: string | null; latency: LambderMockLatency }){
        this.apiVersion = options.apiVersion;
        this.latency = options.latency;
        this.initialLatency = options.latency;
    }

    /** True while every call should reject at the transport, as with no network at all. */
    get offline(): boolean { return this.offlineFlag; }

    /** The next call to the endpoint fails this way; several calls queue in order. */
    failNext(apiName: string, failure: LambderMockFailure | LambderMockFailureReason): void {
        const queue = this.failuresNext.get(apiName) ?? [];
        queue.push(typeof failure === "string" ? { reason: failure } as LambderMockFailure : failure);
        this.failuresNext.set(apiName, queue);
    }

    /** Every call to the endpoint fails this way until cleared with null. */
    setFailure(apiName: string, failure: LambderMockFailure | LambderMockFailureReason | null): void {
        if(failure === null) this.failuresSet.delete(apiName);
        else this.failuresSet.set(apiName, typeof failure === "string" ? { reason: failure } as LambderMockFailure : failure);
    }

    setOffline(offline: boolean): void { this.offlineFlag = offline; }

    setLatency(latency: LambderMockLatency): void { this.latency = latency; }

    /** The failure this call should take, queued one first; null when the call should run. */
    take(apiName: string): LambderMockFailure | null {
        const queue = this.failuresNext.get(apiName);
        if(queue?.length){
            const next = queue.shift()!;
            if(!queue.length) this.failuresNext.delete(apiName);
            return next;
        }
        return this.failuresSet.get(apiName) ?? null;
    }

    /** Milliseconds this call should take before it is answered. */
    latencyFor(apiName: string): number {
        const latency = this.latency;
        if(typeof latency === "number") return latency;
        if(typeof latency === "function") return latency(apiName);
        return latency.min + Math.random() * Math.max(0, latency.max - latency.min);
    }

    /** Waits the configured latency, cancelled by the caller's abort. */
    wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
        if(ms <= 0) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
            const onAbort = () => { clearTimeout(timer); reject(new LambderMockTransportError("network")); };
            if(signal?.aborted){ clearTimeout(timer); reject(new LambderMockTransportError("network")); return; }
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }

    /** Waits for the caller's own abort, which is what a timeout is; a call with no signal waits for ever. */
    waitForAbort(signal: AbortSignal | undefined): Promise<never> {
        return new Promise((_resolve, reject) => {
            if(!signal) return;
            if(signal.aborted){ reject(new LambderMockTransportError("timeout")); return; }
            signal.addEventListener("abort", () => reject(new LambderMockTransportError("timeout")), { once: true });
        });
    }

    /**
     * The answer an injected failure produces, or a throw for the ones that
     * never reach the caller as answers. An injected refusal is checked
     * against the endpoint's declared codes (`endpoint`), as the pipeline
     * checks a real one, so a test cannot inject what the server could never
     * send. `endsSession` says the answer tells the caller its session is
     * over (sessionExpired, or a refusal whose code is declared so), which
     * the runtime then makes true.
     */
    async answerFor(failure: LambderMockFailure, request: LambderApiRequest, endpoint: LambderEndpointRefusals | undefined): Promise<LambderMockInjectionResult> {
        switch(failure.reason){
            case "network": throw new LambderMockTransportError("network");
            case "timeout": return await this.waitForAbort(request.signal);
            case "server": return { answer: crashAnswer(this.apiVersion), endsSession: false };
            case "refusal": {
                const message = toRefusalMessage(failure.message, "Injected refusal.");
                const checked = checkedRefusal(request.apiName, endpoint, new LambderApiRefusal(message.content, { refusal: message, statusCode: failure.statusCode }));
                return { answer: refusalAnswer(checked, this.apiVersion), endsSession: checked.sessionExpired === true };
            }
            case "notAuthorized": {
                const message = toRefusalMessage(failure.message, "Injected authorization refusal.");
                // A declared code's flag is its declaration's: the refusal is
                // built without one and the declaration has to supply it.
                const declared = message.code !== undefined && endpoint?.codes.has(message.code) === true;
                const checked = checkedRefusal(request.apiName, endpoint, new LambderApiRefusal(message.content, { refusal: message, ...(declared ? {} : { notAuthorized: true }) }));
                if(!checked.notAuthorized){
                    throw new Error(`LambderMockApp: the injected notAuthorized failure names the code "${String(message.code)}", which is not declared notAuthorized. Inject it as a refusal, or declare the flag on the code.`);
                }
                return { answer: refusalAnswer(checked, this.apiVersion), endsSession: checked.sessionExpired === true };
            }
            case "sessionExpired": return { answer: sessionExpiredAnswer(this.apiVersion), endsSession: true };
            case "versionExpired": return { answer: versionExpiredAnswer(this.apiVersion), endsSession: false };
            case "rateLimited": return { answer: refusalAnswer(rateLimitRefusal("Injected rate limit.", { policy: failure.policy ?? "injected", retryAfterSeconds: failure.retryAfterSeconds ?? 30 }, failure.message), this.apiVersion), endsSession: false };
        }
    }

    /** Clears every injected failure and puts the configured latency back. */
    reset(): void {
        this.failuresNext.clear();
        this.failuresSet.clear();
        this.offlineFlag = false;
        this.latency = this.initialLatency;
    }
}
