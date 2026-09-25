import { LambderApiRefusal } from "../shared/wire/LambderApiRefusal.js";
import { crashAnswer, refusalAnswer, sessionExpiredAnswer, versionExpiredAnswer } from "../api/LambderApiEnvelope.js";
import { rateLimitRefusal } from "../api/LambderApiRateLimits.js";
/** An injected refusal's message, from a string, a full message, or the reason's own wording. */
const toRefusalMessage = (message, fallback) => typeof message === "string" ? { type: "warning", content: message }
    : message ?? { type: "warning", content: fallback };
/**
 * A failure the transport reports rather than an answer the caller reads:
 * an injected network failure or timeout. The caller maps a rejected
 * transport to `network`, or `timeout` when its own abort fired.
 */
export class LambderMockTransportError extends Error {
    reason;
    constructor(reason) {
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
    failuresNext = new Map();
    failuresSet = new Map();
    offlineFlag = false;
    latency;
    /** What latency was configured at creation, so reset() can put it back. */
    initialLatency;
    apiVersion;
    constructor(options) {
        this.apiVersion = options.apiVersion;
        this.latency = options.latency;
        this.initialLatency = options.latency;
    }
    /** True while every call should reject at the transport, as with no network at all. */
    get offline() { return this.offlineFlag; }
    /** The next call to the endpoint fails this way; several calls queue in order. */
    failNext(apiName, failure) {
        const queue = this.failuresNext.get(apiName) ?? [];
        queue.push(typeof failure === "string" ? { reason: failure } : failure);
        this.failuresNext.set(apiName, queue);
    }
    /** Every call to the endpoint fails this way until cleared with null. */
    setFailure(apiName, failure) {
        if (failure === null)
            this.failuresSet.delete(apiName);
        else
            this.failuresSet.set(apiName, typeof failure === "string" ? { reason: failure } : failure);
    }
    setOffline(offline) { this.offlineFlag = offline; }
    setLatency(latency) { this.latency = latency; }
    /** The failure this call should take, queued one first; null when the call should run. */
    take(apiName) {
        const queue = this.failuresNext.get(apiName);
        if (queue?.length) {
            const next = queue.shift();
            if (!queue.length)
                this.failuresNext.delete(apiName);
            return next;
        }
        return this.failuresSet.get(apiName) ?? null;
    }
    /** Milliseconds this call should take before it is answered. */
    latencyFor(apiName) {
        const latency = this.latency;
        if (typeof latency === "number")
            return latency;
        if (typeof latency === "function")
            return latency(apiName);
        return latency.min + Math.random() * Math.max(0, latency.max - latency.min);
    }
    /** Waits the configured latency, cancelled by the caller's abort. */
    wait(ms, signal) {
        if (ms <= 0)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
            const onAbort = () => { clearTimeout(timer); reject(new LambderMockTransportError("network")); };
            if (signal?.aborted) {
                clearTimeout(timer);
                reject(new LambderMockTransportError("network"));
                return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }
    /** Waits for the caller's own abort, which is what a timeout is; a call with no signal waits for ever. */
    waitForAbort(signal) {
        return new Promise((_resolve, reject) => {
            if (!signal)
                return;
            if (signal.aborted) {
                reject(new LambderMockTransportError("timeout"));
                return;
            }
            signal.addEventListener("abort", () => reject(new LambderMockTransportError("timeout")), { once: true });
        });
    }
    /** The answer an injected failure produces, or a throw for the ones that never reach the caller as answers. */
    async answerFor(failure, request) {
        switch (failure.reason) {
            case "network": throw new LambderMockTransportError("network");
            case "timeout": return await this.waitForAbort(request.signal);
            case "server": return crashAnswer(this.apiVersion);
            case "refusal": {
                const message = toRefusalMessage(failure.message, "Injected refusal.");
                return refusalAnswer(new LambderApiRefusal(message.content, { errorMessage: message, statusCode: failure.statusCode }), this.apiVersion);
            }
            case "notAuthorized": {
                const message = toRefusalMessage(failure.message, "Injected authorization refusal.");
                return refusalAnswer(new LambderApiRefusal(message.content, { errorMessage: message, notAuthorized: true }), this.apiVersion);
            }
            case "sessionExpired": return sessionExpiredAnswer(this.apiVersion);
            case "versionExpired": return versionExpiredAnswer(this.apiVersion);
            case "rateLimited": return refusalAnswer(rateLimitRefusal("Injected rate limit.", failure.retryAfterSeconds ?? 30, failure.message), this.apiVersion);
        }
    }
    /** Clears every injected failure and puts the configured latency back. */
    reset() {
        this.failuresNext.clear();
        this.failuresSet.clear();
        this.offlineFlag = false;
        this.latency = this.initialLatency;
    }
}
