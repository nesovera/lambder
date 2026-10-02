import {
    checkUploadRule,
    type LambderUploadFileFacts,
    type LambderUploadRule,
    type LambderUploadRuleVerdict,
    type LambderUploadTicket,
} from "../shared/contracts/LambderUploadBucket.js";
import { LambderBackoffTimer, type LambderBackoffTimerOptions } from "../shared/util/LambderBackoffTimer.js";
import { sha256Base64Of } from "../shared/util/LambderTextDigest.js";
import type { LambderApiFailure, LambderApiFailureReason, LambderApiOutcome } from "../shared/wire/LambderApiOutcome.js";

/*
 * The browser half of a direct upload (the conversation, and the reasons for
 * it, are in shared/contracts/LambderUploadBucket.ts).
 *
 * An app builds one runner from its rule and its own endpoints, and from then
 * on uploading is `await runner.upload(file)`. Everything in between is the
 * runner's: checking the file against the rule, hashing it, asking for a
 * ticket, sending the bytes to storage with progress (a form post or a PUT,
 * as the ticket says), waiting out a dropped or stalled connection, at
 * storage or at the app's own endpoints, and trying again, asking for a new
 * ticket when storage says the old one ran out, stopping the moment the
 * caller aborts, and having the server confirm what arrived. It ends one of
 * two ways: the app's receipt, or a LambderUploadError whose reason a screen
 * can word for the person.
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
export class LambderUploadError extends Error {
    readonly reason: LambderUploadFailureReason;
    /** The ticket or confirm call's failure outcome, when the upload ended on one. */
    readonly callFailure?: LambderApiFailure;

    constructor(reason: LambderUploadFailureReason, options: { cause?: unknown; detail?: string; callFailure?: LambderApiFailure } = {}){
        super(options.detail ? `${reason}: ${options.detail}` : reason, { cause: options.cause });
        this.name = "LambderUploadError";
        this.reason = reason;
        if(options.callFailure) this.callFailure = options.callFailure;
    }
}

/**
 * What a runner is built from. The app's ticket and confirm calls answer with
 * the outcome a caller's `.outcome()` resolves to, so the runner can tell a
 * call that got no usable answer, which it tries again, from a refusal, which
 * it does not.
 */
export type LambderUploadRunnerOptions<TicketOutput extends { ticket: LambderUploadTicket }, Receipt> = {
    uploadRule: LambderUploadRule;
    /**
     * The app's ticket endpoint, as its outcome
     * (`caller.invoices.requestUpload.outcome(input, { signal })`). Its output
     * carries the `ticket` and whatever the confirm endpoint needs to find this
     * upload again (the id of the record it made), which the runner hands to
     * confirmUpload unread. `signal` is the upload's own, for the call to pass
     * on so an abort stops it too.
     */
    requestTicket: (fileFacts: LambderUploadFileFacts, call: { signal: AbortSignal | undefined }) => Promise<LambderApiOutcome<TicketOutput>>;
    /**
     * The app's confirm endpoint, as its outcome: handed the ticket
     * endpoint's output, the server checks the stored object and answers its
     * record of it, the receipt upload() resolves to.
     */
    confirmUpload: (ticketOutput: TicketOutput, call: { signal: AbortSignal | undefined }) => Promise<LambderApiOutcome<Receipt>>;
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
    storageRetry?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number };
    /**
     * How long an upload to storage may be open and move nothing before it
     * counts as dropped. Default: 60 seconds. Watched where XMLHttpRequest exists,
     * which reports a body's progress; a runtime with only fetch uploads
     * unwatched.
     */
    stallTimeoutMs?: number;
};

type StorageOutcome =
    | { kind: "stored" }
    | { kind: "aborted" }
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

/**
 * The ticket and confirm call failures that got no usable answer, so the same
 * call may well pass on another try: no answer at all, the call's own
 * timeout, a 5xx. Every other failure is the endpoint's answer (a refusal, a
 * rejected input, an expired session), and the same call would get it again.
 */
const RETRIED_CALL_REASONS: ReadonlySet<LambderApiFailureReason> = new Set<LambderApiFailureReason>(["network", "timeout", "server"]);

/** One line on what a failed call said, for the message of the upload error it ends in. */
const describeCallFailure = (failure: LambderApiFailure): string => {
    const said = failure.refusal !== undefined ? failure.refusal.content
        : "error" in failure ? failure.error.message
        : "";
    return said ? `${failure.reason}: ${said}` : failure.reason;
};

export class LambderUploadRunner<TicketOutput extends { ticket: LambderUploadTicket }, Receipt> {
    private readonly options: LambderUploadRunnerOptions<TicketOutput, Receipt>;
    /** How many times a step is tried again after its first try: the storageRetry option's attempts, less that first one. */
    private readonly retries: number;
    /** The ladder one upload's waits climb; each upload() builds a timer of its own from it, so two uploads never share a count. */
    private readonly backoff: LambderBackoffTimerOptions;
    private readonly stallTimeoutMs: number;

    constructor(options: LambderUploadRunnerOptions<TicketOutput, Receipt>){
        this.options = options;
        this.retries = Math.max(1, options.storageRetry?.attempts ?? 4) - 1;
        const baseDelayMs = options.storageRetry?.baseDelayMs ?? 1_000;
        const maxDelayMs = options.storageRetry?.maxDelayMs ?? 15_000;
        // A longest wait below the shortest is every wait at the shortest.
        this.backoff = { baseMs: baseDelayMs, maxMs: Math.max(baseDelayMs, maxDelayMs) };
        // Each upload climbs a timer of its own; one built here checks the
        // ladder where the runner is configured, so a storageRetry the timer
        // refuses (a baseDelayMs of 0) fails now rather than on the first upload.
        new LambderBackoffTimer(this.backoff);
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
        const stopIfAborted = () => {
            if(signal?.aborted) throw new LambderUploadError("aborted");
        };

        stopIfAborted();
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
        stopIfAborted();

        // One timer for the whole upload, the app's calls and storage alike.
        // A step that succeeds resets it, so each step has every attempt and
        // its first wait is the shortest again. Every retry so far waited on
        // the timer once, so its count is the retries the step has spent.
        const backoff = new LambderBackoffTimer(this.backoff);
        const waitToRetry = async (lastFailure: { cause?: unknown; detail?: string; callFailure?: LambderApiFailure }) => {
            if(backoff.retries >= this.retries) throw new LambderUploadError("networkFailed", lastFailure);
            // The wait rejects only for the signal: nothing else cancels it.
            await backoff.wait(signal).catch((cause: unknown) => {
                throw new LambderUploadError("aborted", { cause });
            });
        };

        /**
         * One of the app's calls through to its output. A failure with no
         * usable answer is tried again on the timer, the same request each
         * time (so a confirm asks about the ticket it was issued); any other
         * failure ends the upload as `refused`, and one after the upload's
         * signal aborted as the abort. A throw is the app's own code failing
         * rather than the call, which no retry cures.
         */
        const callApp = async <TOutput>(call: () => Promise<LambderApiOutcome<TOutput>>, refused: "ticketRefused" | "confirmRefused"): Promise<TOutput> => {
            for(;;){
                stopIfAborted();
                let outcome: LambderApiOutcome<TOutput>;
                try{
                    outcome = await call();
                }catch(cause){
                    throw new LambderUploadError(signal?.aborted ? "aborted" : refused, { cause });
                }
                if(outcome.ok){
                    backoff.reset();
                    return outcome.payload;
                }
                const ended = { callFailure: outcome, detail: describeCallFailure(outcome), ...("error" in outcome ? { cause: outcome.error } : {}) };
                if(outcome.reason === "aborted" || signal?.aborted) throw new LambderUploadError("aborted", ended);
                if(!RETRIED_CALL_REASONS.has(outcome.reason)) throw new LambderUploadError(refused, ended);
                await waitToRetry(ended);
            }
        };
        const requestTicket = () => {
            report("requesting");
            return callApp(() => this.options.requestTicket(fileFacts, { signal }), "ticketRefused");
        };

        let issued = await requestTicket();
        let ticketRenewals = 0;
        for(;;){
            stopIfAborted();
            report("uploading");
            const outcome = await this.send(issued.ticket, file, signal, (sentBytes) => report("uploading", sentBytes));
            if(outcome.kind === "stored") break;
            if(outcome.kind === "aborted") throw new LambderUploadError("aborted");
            if(outcome.kind === "rejected"){
                // An expired ticket needs no wait and costs no attempt, only a
                // new ticket; any other refusal is the file's, and final.
                if(!outcome.ticketExpired || ++ticketRenewals > TICKET_RENEWAL_LIMIT) throw new LambderUploadError("storageRejected", { detail: outcome.detail });
                issued = await requestTicket();
                continue;
            }
            // The ticket is kept through a network retry, so a flaky
            // connection does not leave the app a record per attempt.
            await waitToRetry({});
        }
        backoff.reset();

        report("confirming", file.size);
        return await callApp(() => this.options.confirmUpload(issued, { signal }), "confirmRefused");
    }

    /** Forgets a confirmed upload through the app's endpoint, when it declared one. */
    async discard(receipt: Receipt): Promise<void> {
        await this.options.discardUpload?.(receipt);
    }

    /** One upload of the file to storage, in the ticket's form. Never throws: every ending is an outcome. */
    private send(ticket: LambderUploadTicket, file: File, signal: AbortSignal | undefined, onSent: (sentBytes: number) => void): Promise<StorageOutcome> {
        if(signal?.aborted) return Promise.resolve({ kind: "aborted" });
        let request: StorageRequest;
        if(ticket.method === "PUT"){
            request = { method: "PUT", url: ticket.uploadUrl, body: file, headers: ticket.headers };
        }else{
            const form = new FormData();
            for(const [name, value] of Object.entries(ticket.formFields)) form.append(name, value);
            // Storage ignores every field that comes after the file.
            form.append("file", file);
            request = { method: "POST", url: ticket.uploadUrl, body: form, headers: {} };
        }
        return typeof XMLHttpRequest === "function"
            ? sendWithXhr(request, file.size, this.stallTimeoutMs, signal, onSent)
            : sendWithFetch(request, file.size, signal, onSent);
    }
}

/** What goes to storage: a form posted, or the file itself put, with the ticket's headers. */
type StorageRequest = { method: "POST" | "PUT"; url: string; body: FormData | File; headers: Record<string, string> };

/** XMLHttpRequest rather than fetch where it exists: fetch cannot report how much of a request body has been sent. */
const sendWithXhr = ({ method, url, body, headers }: StorageRequest, fileBytes: number, stallTimeoutMs: number, signal: AbortSignal | undefined, onSent: (sentBytes: number) => void) =>
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
            // A form's `loaded` counts its own framing too, a little over the file.
            onSent(Math.min(event.loaded, fileBytes));
        };
        request.onload = () => {
            if(request.status >= 200 && request.status < 300) return settle({ kind: "stored" });
            if(request.status >= 500) return settle({ kind: "unreachable" });
            settle(rejectedOutcome(request.status, request.responseText));
        };
        request.onerror = () => settle({ kind: "unreachable" });
        request.onabort = () => settle(stalled ? { kind: "unreachable" } : { kind: "aborted" });

        signal?.addEventListener("abort", cancel, { once: true });
        watchForStall();
        try{
            request.open(method, url);
            for(const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
            request.send(body);
        }catch{
            // A URL the browser will not open, or a request it will not send, answers nothing.
            settle({ kind: "unreachable" });
        }
    });

const sendWithFetch = async ({ method, url, body, headers }: StorageRequest, fileBytes: number, signal: AbortSignal | undefined, onSent: (sentBytes: number) => void): Promise<StorageOutcome> => {
    let response: Response;
    try{
        response = await fetch(url, { method, body, headers, signal });
    }catch{
        return signal?.aborted ? { kind: "aborted" } : { kind: "unreachable" };
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
