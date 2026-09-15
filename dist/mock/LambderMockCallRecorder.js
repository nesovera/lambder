import { LAMBDER_REFUSAL_CODES } from "../shared/wire/LambderApiRefusal.js";
/**
 * Set-Cookie values are redacted in the log: the name stays so a reader can
 * see that a session cookie was written, the value goes, because a live
 * session token in a panel a developer renders and a test snapshots is no
 * place to keep it.
 */
const loggedHeaders = (headers) => {
    const copy = {};
    for (const [key, values] of Object.entries(headers)) {
        copy[key] = key.toLowerCase() === "set-cookie"
            ? values.map((header) => header.replace(/^([^=;]+)=[^;]*/, "$1=[redacted]"))
            : [...values];
    }
    return copy;
};
/**
 * A logged value copied, so a reader that reaches into a record cannot edit
 * what the next reader sees. structuredClone is the platform's deep copy and
 * everything logged arrived as JSON; a value it refuses (a function on the
 * payload of a hand-built request) is handed over as it is rather than
 * failing the read.
 */
const cloneLoggedValue = (value) => {
    if (value === null || typeof value !== "object")
        return value;
    try {
        return structuredClone(value);
    }
    catch {
        return value;
    }
};
/** The envelope an answer carries, when it carries one. */
const envelopeOf = (answer) => {
    if (answer.isBodyBase64)
        return null;
    try {
        const parsed = JSON.parse(answer.body);
        return parsed !== null && typeof parsed === "object" ? parsed : null;
    }
    catch {
        return null;
    }
};
/** How an answer reads, in the runtime's vocabulary. */
const classifyAnswer = (answer, envelope) => {
    if (answer.statusCode >= 500)
        return "crash";
    if (answer.statusCode === 422)
        return "validation";
    if (!envelope)
        return "ok";
    if (envelope.versionExpired)
        return "versionExpired";
    if (envelope.sessionExpired)
        return "sessionExpired";
    if (envelope.notAuthorized)
        return "notAuthorized";
    const code = envelope.errorMessage?.code;
    if (code === LAMBDER_REFUSAL_CODES.rateLimited)
        return "rateLimited";
    if (code === LAMBDER_REFUSAL_CODES.notMocked)
        return "notMocked";
    if (code === LAMBDER_REFUSAL_CODES.apiNotFound)
        return "unknownApi";
    if (envelope.errorMessage)
        return "refusal";
    return "ok";
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
export class LambderMockCallRecorder {
    listeners = new Map();
    /** Listeners that threw, skipped until they subscribe again or the runtime resets. */
    mutedListeners = new Set();
    callLog = [];
    callLogSize;
    callSequence = 0;
    constructor(options) {
        this.callLogSize = options.callLogSize;
    }
    /** The id of the next call, which numbers its request and response events alike. */
    nextCallId() { return ++this.callSequence; }
    subscribe(key, listener) {
        this.listeners.set(key, listener);
        // Subscribing again is how a muted listener comes back: a hot reload
        // replaces the broken panel with the fixed one under the same key.
        this.mutedListeners.delete(key);
        return () => { if (this.listeners.get(key) === listener)
            this.listeners.delete(key); };
    }
    /** The completed calls, oldest first, bounded by callLogSize. */
    get calls() {
        return this.callLog.map((record) => ({
            ...record,
            headers: cloneLoggedValue(record.headers),
            guardsRun: [...record.guardsRun],
            envelope: cloneLoggedValue(record.envelope),
            payload: cloneLoggedValue(record.payload),
            guardInputs: cloneLoggedValue(record.guardInputs),
        }));
    }
    emit(event) {
        for (const [key, listener] of this.listeners) {
            if (this.mutedListeners.has(key))
                continue;
            try {
                listener(event);
            }
            catch (err) {
                // Muted, not merely reported once: a listener that throws on
                // one event throws on the next, so leaving it in the loop
                // costs every remaining call a thrown error and a swallowed
                // one, for a listener that is already known to be broken.
                this.mutedListeners.add(key);
                console.error(`[lambder mock] listener "${key}" threw and is muted until it subscribes again or the mock is reset`, err);
            }
        }
    }
    /**
     * Ends one call: reads how it went, redacts what a log has no business
     * keeping, and emits the response event and the log row from one object,
     * so the two cannot say different things about the same call.
     *
     * The event and the row carry copies of their own, so a listener that
     * edits the event it was handed is not editing the row the log keeps; the
     * row is copied again on the way in and on the way out.
     */
    settle(facts, ending) {
        const answer = ending.answer;
        const envelope = answer ? envelopeOf(answer) : null;
        const settledAt = Date.now();
        const event = {
            phase: "response",
            id: facts.id, apiName: facts.apiName, mode: facts.mode,
            durationMs: settledAt - facts.startedAt,
            statusCode: answer?.statusCode ?? null,
            headers: answer ? loggedHeaders(answer.headers) : {},
            envelope,
            outcome: ending.outcome ?? (answer ? classifyAnswer(answer, envelope) : "crash"),
            guardsRun: [...ending.guardsRun],
            ...(ending.error ? { error: ending.error } : {}),
            at: settledAt,
        };
        this.emit(event);
        this.push({ ...event, guardsRun: [...ending.guardsRun], payload: facts.request.payload, guardInputs: facts.request.guardInputs });
    }
    push(record) {
        this.callLog.push({
            ...record,
            headers: cloneLoggedValue(record.headers),
            envelope: cloneLoggedValue(record.envelope),
            guardsRun: [...record.guardsRun],
        });
        if (this.callLog.length > this.callLogSize)
            this.callLog.splice(0, this.callLog.length - this.callLogSize);
    }
    /** Empties the log and its numbering, and unmutes listeners; the subscriptions themselves survive. */
    reset() {
        this.callLog.length = 0;
        this.callSequence = 0;
        this.mutedListeners.clear();
    }
}
