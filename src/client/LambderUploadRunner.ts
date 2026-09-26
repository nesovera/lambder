import {
    checkUploadRule,
    type LambderUploadFileFacts,
    type LambderUploadRule,
    type LambderUploadRuleVerdict,
    type LambderUploadTicket,
} from "../shared/contracts/LambderUploadBucket.js";
import { sha256Base64Of } from "../shared/util/LambderTextDigest.js";

/*
 * The browser half of a direct upload (the conversation, and the reasons for
 * it, are in shared/contracts/LambderUploadBucket.ts).
 *
 * An app builds one runner from its rule and its own endpoints, and from then
 * on uploading is `await runner.upload(file)`. Everything in between is the
 * runner's: checking the file against the rule, hashing it, asking for a
 * ticket, posting the bytes to storage with progress, waiting out a dropped
 * or stalled connection and trying again, asking for a new ticket when
 * storage says the old one ran out, stopping the moment the caller cancels,
 * and having the server confirm what arrived. It ends one of two ways: the
 * app's receipt, or a LambderUploadError whose reason a screen can word for
 * the person.
 */

/** Where an upload is, in order. `sentBytes` only moves during `uploading`. */
export type LambderUploadPhase = "hashing" | "requesting" | "uploading" | "confirming";

export type LambderUploadProgress = {
    phase: LambderUploadPhase;
    sentBytes: number;
    totalBytes: number;
};

export type LambderUploadFailureReason =
    | LambderUploadRuleVerdict
    /** The browser could not read the file (moved, deleted, or a cloud placeholder that never downloaded). */
    | "fileUnreadable"
    /** The app's ticket endpoint would not issue a ticket. */
    | "ticketRefused"
    /** Storage answered and said no, for a reason a retry cannot cure. */
    | "storageRejected"
    /** Storage could not be reached, or kept stalling, through every attempt. */
    | "networkFailed"
    /** The bytes are stored, and the app's confirm endpoint would not confirm them. */
    | "confirmRefused"
    | "cancelled";

/** How an upload failed: `reason` for a screen to word, the underlying error as `cause`. */
export class LambderUploadError extends Error {
    readonly reason: LambderUploadFailureReason;

    constructor(reason: LambderUploadFailureReason, options: { cause?: unknown; detail?: string } = {}){
        super(options.detail ? `${reason}: ${options.detail}` : reason, { cause: options.cause });
        this.name = "LambderUploadError";
        this.reason = reason;
    }
}

export type LambderUploadRunnerOptions<Reference, Receipt> = {
    uploadRule: LambderUploadRule;
    /**
     * The app's ticket endpoint. `reference` is whatever its confirm endpoint
     * needs to find this upload again (the id of the record it made), and
     * means nothing to the runner. `signal` is the upload's own, for the call
     * to pass on so a cancel stops it too.
     */
    requestTicket: (fileFacts: LambderUploadFileFacts, call: { signal: AbortSignal | undefined }) => Promise<{ ticket: LambderUploadTicket; reference: Reference }>;
    /** The app's confirm endpoint: the server checks the stored object and answers its record of it. */
    confirmUpload: (reference: Reference, call: { signal: AbortSignal | undefined }) => Promise<Receipt>;
    /** The app's way of forgetting a confirmed upload the person removed again. Without one, discard() does nothing. */
    discardUpload?: (receipt: Receipt) => Promise<void>;
    /**
     * How storage is tried again when it cannot be reached, stalls, or answers
     * a failure a retry can cure (a 5xx, RequestTimeout, SlowDown). Each wait
     * is a random time between `baseDelayMs` and a ceiling of twice that,
     * doubling with every failed attempt and never past `maxDelayMs`, so many
     * browsers dropped together do not come back in step, not even the first
     * time. Default: 4 attempts, waits from one second to 15.
     */
    storageRetry?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number };
    /**
     * How long a post may be open and move nothing before it counts as
     * dropped. Default: 60 seconds. Watched where XMLHttpRequest exists,
     * which reports a body's progress; a runtime with only fetch posts
     * unwatched.
     */
    stallTimeoutMs?: number;
};

type StorageOutcome =
    | { kind: "stored" }
    | { kind: "cancelled" }
    /** No answer, a 5xx, a stall, or a refusal a retry can cure: all worth another try. */
    | { kind: "unreachable" }
    | { kind: "rejected"; ticketExpired: boolean; detail: string };

/**
 * How many times one upload asks for a new ticket because storage called the
 * last one expired. A new ticket is asked for at once and spends no attempt
 * at storage; the bound is for a clock so far off that every ticket arrives
 * expired.
 */
const TICKET_RENEWAL_LIMIT = 2;

/** S3's refusals that are the connection's or the service's fault rather than the file's, which its own SDK retries too. */
const TRANSIENT_STORAGE_CODES = new Set(["RequestTimeout", "SlowDown", "InternalError", "ServiceUnavailable"]);

export class LambderUploadRunner<Reference, Receipt> {
    private readonly options: LambderUploadRunnerOptions<Reference, Receipt>;
    private readonly attempts: number;
    private readonly baseDelayMs: number;
    private readonly maxDelayMs: number;
    private readonly stallTimeoutMs: number;

    constructor(options: LambderUploadRunnerOptions<Reference, Receipt>){
        this.options = options;
        this.attempts = Math.max(1, options.storageRetry?.attempts ?? 4);
        this.baseDelayMs = options.storageRetry?.baseDelayMs ?? 1_000;
        this.maxDelayMs = options.storageRetry?.maxDelayMs ?? 15_000;
        this.stallTimeoutMs = options.stallTimeoutMs ?? 60_000;
    }

    /** For a file input's `accept`, so the picker only offers what the rule takes. */
    get acceptedTypes(): string {
        return this.options.uploadRule.mimeTypes.join(",");
    }

    get maxBytes(): number {
        return this.options.uploadRule.maxBytes;
    }

    /** The rule's verdict on a file, or null when it may be uploaded. Costs nothing, so a screen can ask on drop. */
    checkFile(file: Blob): LambderUploadRuleVerdict | null {
        return checkUploadRule(this.options.uploadRule, { mimeType: file.type, byteSize: file.size });
    }

    /**
     * Uploads one file and answers the app's receipt, or throws a
     * LambderUploadError. Aborting `signal` stops it wherever it is: the
     * runner's own steps at once, and the app's calls as far as they pass
     * the signal on.
     */
    async upload(file: File, { onProgress, signal }: { onProgress?: (progress: LambderUploadProgress) => void; signal?: AbortSignal } = {}): Promise<Receipt> {
        const rejection = this.checkFile(file);
        if(rejection) throw new LambderUploadError(rejection);

        const report = (phase: LambderUploadPhase, sentBytes = 0) => onProgress?.({ phase, sentBytes, totalBytes: file.size });
        const stopIfCancelled = () => {
            if(signal?.aborted) throw new LambderUploadError("cancelled");
        };

        stopIfCancelled();
        report("hashing");
        const fileFacts: LambderUploadFileFacts = {
            fileName: file.name,
            mimeType: file.type,
            byteSize: file.size,
            // Read straight into the digest, never into a variable: the buffer
            // is the size of the file, and a local would keep it through
            // every await of the upload that follows.
            sha256Base64: await sha256Base64Of(new Uint8Array(await file.arrayBuffer().catch((cause: unknown) => {
                throw new LambderUploadError("fileUnreadable", { cause });
            }))),
        };
        stopIfCancelled();

        const requestTicket = async () => {
            report("requesting");
            try{
                return await this.options.requestTicket(fileFacts, { signal });
            }catch(cause){
                throw new LambderUploadError(signal?.aborted ? "cancelled" : "ticketRefused", { cause });
            }
        };

        let issued = await requestTicket();
        let failedAttempts = 0;
        let ticketRenewals = 0;
        for(;;){
            stopIfCancelled();
            report("uploading");
            const outcome = await this.post(issued.ticket, file, signal, (sentBytes) => report("uploading", sentBytes));
            if(outcome.kind === "stored") break;
            if(outcome.kind === "cancelled") throw new LambderUploadError("cancelled");
            if(outcome.kind === "rejected"){
                // An expired ticket needs no wait and costs no attempt, only a
                // new ticket; any other refusal is the file's, and final.
                if(!outcome.ticketExpired || ++ticketRenewals > TICKET_RENEWAL_LIMIT) throw new LambderUploadError("storageRejected", { detail: outcome.detail });
                issued = await requestTicket();
                continue;
            }
            // The ticket is kept through a network retry, so a flaky
            // connection does not leave the app a record per attempt.
            if(++failedAttempts >= this.attempts) throw new LambderUploadError("networkFailed");
            await this.waitBeforeRetry(failedAttempts, signal);
        }

        report("confirming", file.size);
        try{
            return await this.options.confirmUpload(issued.reference, { signal });
        }catch(cause){
            throw new LambderUploadError(signal?.aborted ? "cancelled" : "confirmRefused", { cause });
        }
    }

    /** Forgets a confirmed upload through the app's endpoint, when it declared one. */
    async discard(receipt: Receipt): Promise<void> {
        await this.options.discardUpload?.(receipt);
    }

    private waitBeforeRetry(failedAttempts: number, signal: AbortSignal | undefined): Promise<void> {
        const ceiling = Math.max(this.baseDelayMs, Math.min(this.baseDelayMs * 2 ** failedAttempts, this.maxDelayMs));
        return new Promise<void>((resolve, reject) => {
            if(signal?.aborted) return reject(new LambderUploadError("cancelled"));
            const cancel = () => {
                clearTimeout(timer);
                reject(new LambderUploadError("cancelled"));
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", cancel);
                resolve();
            }, this.baseDelayMs + Math.random() * (ceiling - this.baseDelayMs));
            signal?.addEventListener("abort", cancel, { once: true });
        });
    }

    /** One post of the file to storage. Never throws: every ending is an outcome. */
    private post(ticket: LambderUploadTicket, file: File, signal: AbortSignal | undefined, onSent: (sentBytes: number) => void): Promise<StorageOutcome> {
        if(signal?.aborted) return Promise.resolve({ kind: "cancelled" });
        const form = new FormData();
        for(const [name, value] of Object.entries(ticket.formFields)) form.append(name, value);
        // Storage ignores every field that comes after the file.
        form.append("file", file);
        return typeof XMLHttpRequest === "function"
            ? postWithXhr(ticket.uploadUrl, form, file.size, this.stallTimeoutMs, signal, onSent)
            : postWithFetch(ticket.uploadUrl, form, file.size, signal, onSent);
    }
}

/** XMLHttpRequest rather than fetch where it exists: fetch cannot report how much of a request body has been sent. */
const postWithXhr = (url: string, form: FormData, fileBytes: number, stallTimeoutMs: number, signal: AbortSignal | undefined, onSent: (sentBytes: number) => void) =>
    new Promise<StorageOutcome>((resolve) => {
        const request = new XMLHttpRequest();
        let stalled = false;
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        const watchForStall = () => {
            clearTimeout(stallTimer);
            stallTimer = setTimeout(() => {
                stalled = true;
                request.abort();
            }, stallTimeoutMs);
        };
        const cancel = () => request.abort();
        const settle = (outcome: StorageOutcome) => {
            clearTimeout(stallTimer);
            signal?.removeEventListener("abort", cancel);
            resolve(outcome);
        };

        request.upload.onprogress = (event) => {
            watchForStall();
            // `loaded` counts the form's own framing too, a little over the file.
            onSent(Math.min(event.loaded, fileBytes));
        };
        request.onload = () => {
            if(request.status >= 200 && request.status < 300) return settle({ kind: "stored" });
            if(request.status >= 500) return settle({ kind: "unreachable" });
            settle(rejectedOutcome(request.status, request.responseText));
        };
        request.onerror = () => settle({ kind: "unreachable" });
        request.onabort = () => settle(stalled ? { kind: "unreachable" } : { kind: "cancelled" });

        signal?.addEventListener("abort", cancel, { once: true });
        watchForStall();
        try{
            request.open("POST", url);
            request.send(form);
        }catch{
            // A URL the browser will not open, or a request it will not send, answers nothing.
            settle({ kind: "unreachable" });
        }
    });

const postWithFetch = async (url: string, form: FormData, fileBytes: number, signal: AbortSignal | undefined, onSent: (sentBytes: number) => void): Promise<StorageOutcome> => {
    let response: Response;
    try{
        response = await fetch(url, { method: "POST", body: form, signal });
    }catch{
        return signal?.aborted ? { kind: "cancelled" } : { kind: "unreachable" };
    }
    if(response.ok){
        onSent(fileBytes);
        return { kind: "stored" };
    }
    if(response.status >= 500) return { kind: "unreachable" };
    return rejectedOutcome(response.status, await response.text().catch(() => ""));
};

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const xmlText = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (entity, name: string) => {
    if(name[0] !== "#") return XML_ENTITIES[name] ?? entity;
    const codePoint = Number(name[1]?.toLowerCase() === "x" ? `0${name.slice(1)}` : name.slice(1));
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
});

/**
 * Storage explains a refusal in XML, `<Error><Code/><Message/></Error>`,
 * read here without a DOM so the runner works wherever fetch does. A
 * transient code is tried again like a dropped connection. An expired ticket
 * is the one refusal a new ticket cures, and so is ExpiredToken: the
 * temporary credentials that signed the ticket ran out before it did, and
 * the next one is signed with fresh ones.
 */
const rejectedOutcome = (status: number, body: string): StorageOutcome => {
    const code = xmlText(/<Code>([^<]*)<\/Code>/.exec(body)?.[1] ?? "") || `HTTP ${status}`;
    const message = xmlText(/<Message>([^<]*)<\/Message>/.exec(body)?.[1] ?? "");
    if(TRANSIENT_STORAGE_CODES.has(code)) return { kind: "unreachable" };
    return {
        kind: "rejected",
        ticketExpired: code === "ExpiredToken" || (code === "AccessDenied" && /expired/i.test(message)),
        detail: message ? `${code}: ${message}` : code,
    };
};
