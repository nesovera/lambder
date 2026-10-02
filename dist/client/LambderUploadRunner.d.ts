import { type LambderUploadFileFacts, type LambderUploadRule, type LambderUploadRuleVerdict, type LambderUploadTicket } from "../shared/contracts/LambderUploadBucket.js";
import type { LambderApiFailure, LambderApiOutcome } from "../shared/wire/LambderApiOutcome.js";
/** Where an upload is, in order. `sentBytes` only moves during `uploading`. */
export type LambderUploadPhase = "hashing" | "requesting" | "uploading" | "confirming";
export type LambderUploadProgress = {
    phase: LambderUploadPhase;
    sentBytes: number;
    totalBytes: number;
};
export type LambderUploadFailureReason = LambderUploadRuleVerdict
/** The browser could not read the file (moved, deleted, or a cloud placeholder that never downloaded). */
 | "fileUnreadable"
/** The app's ticket endpoint would not issue a ticket: it refused, or its call failed in a way a retry cannot cure. */
 | "ticketRefused"
/** Storage answered and said no, for a reason a retry cannot cure. */
 | "storageRejected"
/** Storage, or the app's ticket or confirm endpoint, could not be reached, or kept stalling or failing, through every attempt. */
 | "networkFailed"
/** The bytes are stored, and the app's confirm endpoint would not confirm them: it refused, or its call failed in a way a retry cannot cure. */
 | "confirmRefused"
/** The upload's signal aborted it. */
 | "aborted";
/**
 * How an upload failed: `reason` for a screen to word, the underlying error
 * as `cause`, and the failed outcome of the app's own call as `callFailure`
 * when that call is what ended the upload, so a screen words a refusal by its
 * code (`callFailure.refusal.code`) as it would on the call itself.
 */
export declare class LambderUploadError extends Error {
    readonly reason: LambderUploadFailureReason;
    /** The ticket or confirm call's failure outcome, when the upload ended on one. */
    readonly callFailure?: LambderApiFailure;
    constructor(reason: LambderUploadFailureReason, options?: {
        cause?: unknown;
        detail?: string;
        callFailure?: LambderApiFailure;
    });
}
/**
 * What a runner is built from. The app's ticket and confirm calls answer with
 * the outcome a caller's `.outcome()` resolves to, so the runner can tell a
 * call that got no usable answer, which it tries again, from a refusal, which
 * it does not.
 */
export type LambderUploadRunnerOptions<TicketOutput extends {
    ticket: LambderUploadTicket;
}, Receipt> = {
    uploadRule: LambderUploadRule;
    /**
     * The app's ticket endpoint, as its outcome
     * (`caller.invoices.requestUpload.outcome(input, { signal })`). Its output
     * carries the `ticket` and whatever the confirm endpoint needs to find this
     * upload again (the id of the record it made), which the runner hands to
     * confirmUpload unread. `signal` is the upload's own, for the call to pass
     * on so an abort stops it too.
     */
    requestTicket: (fileFacts: LambderUploadFileFacts, call: {
        signal: AbortSignal | undefined;
    }) => Promise<LambderApiOutcome<TicketOutput>>;
    /**
     * The app's confirm endpoint, as its outcome: handed the ticket
     * endpoint's output, the server checks the stored object and answers its
     * record of it, the receipt upload() resolves to.
     */
    confirmUpload: (ticketOutput: TicketOutput, call: {
        signal: AbortSignal | undefined;
    }) => Promise<LambderApiOutcome<Receipt>>;
    /** The app's way of forgetting a confirmed upload the person removed again. Without one, discard() does nothing. */
    discardUpload?: (receipt: Receipt) => Promise<void>;
    /**
     * How a step is tried again when it got no usable answer: storage that
     * cannot be reached, stalls, or answers a failure a retry can cure (a 5xx,
     * RequestTimeout, SlowDown), and a ticket or confirm call that failed as
     * `network`, `timeout` or `server`. Each wait is `baseDelayMs` plus a
     * random share of a ceiling that starts at `baseDelayMs` and doubles with
     * every failed attempt, the whole never past `maxDelayMs` (the ladder of
     * LambderBackoffTimer), so many browsers dropped together do not come
     * back in step, not even the first time. The attempts are per step: the
     * ladder starts again after each step that succeeds. Default: 4
     * attempts, waits from one second to 15.
     */
    storageRetry?: {
        attempts?: number;
        baseDelayMs?: number;
        maxDelayMs?: number;
    };
    /**
     * How long an upload to storage may be open and move nothing before it
     * counts as dropped. Default: 60 seconds. Watched where XMLHttpRequest exists,
     * which reports a body's progress; a runtime with only fetch uploads
     * unwatched.
     */
    stallTimeoutMs?: number;
};
export declare class LambderUploadRunner<TicketOutput extends {
    ticket: LambderUploadTicket;
}, Receipt> {
    private readonly options;
    /** How many times a step is tried again after its first try: the storageRetry option's attempts, less that first one. */
    private readonly retries;
    /** The ladder one upload's waits climb; each upload() builds a timer of its own from it, so two uploads never share a count. */
    private readonly backoff;
    private readonly stallTimeoutMs;
    constructor(options: LambderUploadRunnerOptions<TicketOutput, Receipt>);
    /** For a file input's `accept`, so the picker only offers what the rule takes. */
    get acceptedTypes(): string;
    get maxBytes(): number;
    /** The rule's verdict on a file, or null when it may be uploaded. Costs nothing, so a screen can ask on drop. */
    checkFile(file: Blob): LambderUploadRuleVerdict | null;
    /**
     * Uploads one file and answers the app's receipt, or throws a
     * LambderUploadError. Aborting `signal` stops it wherever it is: the
     * runner's own steps at once, and the app's calls as far as they pass
     * the signal on.
     */
    upload(file: File, { onProgress, signal }?: {
        onProgress?: (progress: LambderUploadProgress) => void;
        signal?: AbortSignal;
    }): Promise<Receipt>;
    /** Forgets a confirmed upload through the app's endpoint, when it declared one. */
    discard(receipt: Receipt): Promise<void>;
    /** One upload of the file to storage, in the ticket's form. Never throws: every ending is an outcome. */
    private send;
}
