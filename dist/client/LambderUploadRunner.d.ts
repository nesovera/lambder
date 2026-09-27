import { type LambderUploadFileFacts, type LambderUploadRule, type LambderUploadRuleVerdict, type LambderUploadTicket } from "../shared/contracts/LambderUploadBucket.js";
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
/** The app's ticket endpoint would not issue a ticket. */
 | "ticketRefused"
/** Storage answered and said no, for a reason a retry cannot cure. */
 | "storageRejected"
/** Storage could not be reached, or kept stalling, through every attempt. */
 | "networkFailed"
/** The bytes are stored, and the app's confirm endpoint would not confirm them. */
 | "confirmRefused" | "cancelled";
/** How an upload failed: `reason` for a screen to word, the underlying error as `cause`. */
export declare class LambderUploadError extends Error {
    readonly reason: LambderUploadFailureReason;
    constructor(reason: LambderUploadFailureReason, options?: {
        cause?: unknown;
        detail?: string;
    });
}
export type LambderUploadRunnerOptions<Reference, Receipt> = {
    uploadRule: LambderUploadRule;
    /**
     * The app's ticket endpoint. `reference` is whatever its confirm endpoint
     * needs to find this upload again (the id of the record it made), and
     * means nothing to the runner. `signal` is the upload's own, for the call
     * to pass on so a cancel stops it too.
     */
    requestTicket: (fileFacts: LambderUploadFileFacts, call: {
        signal: AbortSignal | undefined;
    }) => Promise<{
        ticket: LambderUploadTicket;
        reference: Reference;
    }>;
    /** The app's confirm endpoint: the server checks the stored object and answers its record of it. */
    confirmUpload: (reference: Reference, call: {
        signal: AbortSignal | undefined;
    }) => Promise<Receipt>;
    /** The app's way of forgetting a confirmed upload the person removed again. Without one, discard() does nothing. */
    discardUpload?: (receipt: Receipt) => Promise<void>;
    /**
     * How storage is tried again when it cannot be reached, stalls, or answers
     * a failure a retry can cure (a 5xx, RequestTimeout, SlowDown). Each wait
     * is `baseDelayMs` plus a random share of a ceiling that starts at
     * `baseDelayMs` and doubles with every failed attempt, the whole never
     * past `maxDelayMs` (the ladder of LambderBackoffTimer), so many browsers
     * dropped together do not come back in step, not even the first time.
     * Default: 4 attempts, waits from one second to 15.
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
export declare class LambderUploadRunner<Reference, Receipt> {
    private readonly options;
    private readonly attempts;
    /** The ladder one upload's waits climb; each upload() builds a timer of its own from it, so two uploads never share a count. */
    private readonly backoff;
    private readonly stallTimeoutMs;
    constructor(options: LambderUploadRunnerOptions<Reference, Receipt>);
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
