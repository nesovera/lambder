import type { LambderApiAnswer } from "../api/LambderApiAnswer.js";
import type { LambderApiMode } from "../shared/wire/LambderApiContract.js";
import type { LambderMockCallEvent, LambderMockCallRecord, LambderMockListener, LambderMockOutcome } from "./LambderMockTypes.js";
/** What every record of one call repeats: who called what, and when it started. */
export type LambderMockCallFacts = {
    id: number;
    apiName: string;
    /** The endpoint's mode from the registry; null for a name the registry does not know. */
    mode: LambderApiMode | null;
    /** When the call started, which is what its duration is measured from. */
    startedAt: number;
    /**
     * The call's request, read when the call settles rather than copied when it
     * starts. The pipeline rewrites the payload as the call goes: a compressed
     * one is restored before anything reads it, and an endpoint with an input
     * schema replaces it with the parsed value. Copied up front, the log kept
     * the wire fields, so the compressed calls a developer opens a panel for
     * were the ones logged as `undefined`.
     */
    request: {
        payload: unknown;
        guardInputs: Record<string, unknown> | undefined;
    };
};
/** How a call ended, as the runtime saw it happen. */
type LambderMockCallEnding = {
    /** The answer the caller receives; null when there is none: a rejected transport, or a passthrough. */
    answer: LambderApiAnswer | null;
    /** The outcome where the runtime already knows it (injected, replayed, passthrough); read off the answer otherwise, and required when there is no answer to read. */
    outcome?: LambderMockOutcome;
    guardsRun: readonly string[];
    /** The crash, or the transport failure. */
    error?: Error;
};
/**
 * What the runtime lets someone watch: the keyed subscriptions every call is
 * emitted to, and the bounded log of completed calls.
 *
 * One of the four pieces of state LambderMockApp holds that nothing else
 * touches.
 * `subscribe` and `calls` stay on the app as one-line delegations, because
 * they are the surface a dev panel reads.
 *
 * Ending a call is `settle`, one call for the whole of it: classification,
 * redaction, the event and the log row. A record literal built at each of the
 * three exits instead would drift between them, which is exactly what a log
 * is read to rule out.
 *
 * `calls` hands out copies down to the values, so a reader that sorts
 * guardsRun or deletes a header is not editing what the next reader sees, and
 * the caller is free to edit what it got. The Error is the exception, passed
 * by reference: a clone of it would no longer be the class a test asserts on,
 * and an Error carries nothing worth protecting.
 */
export declare class LambderMockCallRecorder {
    private readonly listeners;
    /** Listeners that threw, skipped until they subscribe again or the runtime resets. */
    private readonly mutedListeners;
    private readonly callLog;
    private readonly callLogSize;
    private callSequence;
    constructor(options: {
        callLogSize: number;
    });
    /** The id of the next call, which numbers its request and response events alike. */
    nextCallId(): number;
    subscribe(key: string, listener: LambderMockListener): () => void;
    /** The completed calls, oldest first, bounded by callLogSize. */
    get calls(): readonly LambderMockCallRecord[];
    emit(event: LambderMockCallEvent): void;
    /**
     * Ends one call: reads how it went, redacts what a log has no business
     * keeping, and emits the response event and the log row from one object,
     * so the two cannot say different things about the same call.
     *
     * The event and the row carry copies of their own, so a listener that
     * edits the event it was handed is not editing the row the log keeps; the
     * row is copied again on the way in and on the way out.
     */
    settle(facts: LambderMockCallFacts, ending: LambderMockCallEnding): void;
    private push;
    /** Empties the log and its numbering, and unmutes listeners; the subscriptions themselves survive. */
    reset(): void;
}
export {};
