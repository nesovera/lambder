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
     * starts. The pipeline rewrites the payload as the call goes (restoring a
     * compressed one, replacing it with the parsed value under an input
     * schema); a copy taken up front would hold the wire fields and log every
     * compressed payload as `undefined`.
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
 * touches. `subscribe` and `calls` are one-line delegations on the app,
 * because they are the surface a dev panel reads.
 *
 * `settle` ends a call in one place: classification, redaction, the event and
 * the log row. A record built separately at each of the three exits would
 * drift between them, which is exactly what a log is read to rule out.
 *
 * `calls` hands out deep copies, so a reader that sorts guardsRun or deletes
 * a header does not edit what the next reader sees. The Error is passed by
 * reference: a clone would lose the class a test asserts on, and an Error
 * carries nothing worth protecting.
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
     * so the two cannot disagree about the call. Each carries its own copies,
     * so a listener editing its event does not edit the logged row.
     */
    settle(facts: LambderMockCallFacts, ending: LambderMockCallEnding): void;
    private push;
    /** Empties the log and its numbering, and unmutes listeners; the subscriptions themselves survive. */
    reset(): void;
}
export {};
