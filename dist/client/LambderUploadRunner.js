import { checkUploadRule, } from "../shared/contracts/LambderUploadBucket.js";
import { LambderBackoffTimer } from "../shared/util/LambderBackoffTimer.js";
import { sha256Base64Of } from "../shared/util/LambderTextDigest.js";
/** How an upload failed: `reason` for a screen to word, the underlying error as `cause`. */
export class LambderUploadError extends Error {
    reason;
    constructor(reason, options = {}) {
        super(options.detail ? `${reason}: ${options.detail}` : reason, { cause: options.cause });
        this.name = "LambderUploadError";
        this.reason = reason;
    }
}
/**
 * How many times one upload asks for a new ticket because storage called the
 * last one expired. A new ticket is asked for at once and spends no attempt
 * at storage; the bound is for a clock so far off that every ticket arrives
 * expired.
 */
const TICKET_RENEWAL_LIMIT = 2;
/** S3's refusals that are the connection's or the service's fault rather than the file's, which its own SDK retries too. */
const TRANSIENT_STORAGE_CODES = new Set(["RequestTimeout", "SlowDown", "InternalError", "ServiceUnavailable"]);
export class LambderUploadRunner {
    options;
    attempts;
    /** The ladder one upload's waits climb; each upload() builds a timer of its own from it, so two uploads never share a count. */
    backoff;
    stallTimeoutMs;
    constructor(options) {
        this.options = options;
        this.attempts = Math.max(1, options.storageRetry?.attempts ?? 4);
        const baseDelayMs = options.storageRetry?.baseDelayMs ?? 1_000;
        const maxDelayMs = options.storageRetry?.maxDelayMs ?? 15_000;
        // A longest wait below the shortest is every wait at the shortest.
        this.backoff = { baseMs: baseDelayMs, maxMs: Math.max(baseDelayMs, maxDelayMs) };
        this.stallTimeoutMs = options.stallTimeoutMs ?? 60_000;
    }
    /** For a file input's `accept`, so the picker only offers what the rule takes. */
    get acceptedTypes() {
        return this.options.uploadRule.mimeTypes.join(",");
    }
    get maxBytes() {
        return this.options.uploadRule.maxBytes;
    }
    /** The rule's verdict on a file, or null when it may be uploaded. Costs nothing, so a screen can ask on drop. */
    checkFile(file) {
        return checkUploadRule(this.options.uploadRule, { mimeType: file.type, byteSize: file.size });
    }
    /**
     * Uploads one file and answers the app's receipt, or throws a
     * LambderUploadError. Aborting `signal` stops it wherever it is: the
     * runner's own steps at once, and the app's calls as far as they pass
     * the signal on.
     */
    async upload(file, { onProgress, signal } = {}) {
        const rejection = this.checkFile(file);
        if (rejection)
            throw new LambderUploadError(rejection);
        const report = (phase, sentBytes = 0) => onProgress?.({ phase, sentBytes, totalBytes: file.size });
        const stopIfCancelled = () => {
            if (signal?.aborted)
                throw new LambderUploadError("cancelled");
        };
        stopIfCancelled();
        report("hashing");
        const fileFacts = {
            fileName: file.name,
            mimeType: file.type,
            byteSize: file.size,
            // Read straight into the digest, never into a variable: the buffer
            // is the size of the file, and a local would keep it through
            // every await of the upload that follows.
            sha256Base64: await sha256Base64Of(new Uint8Array(await file.arrayBuffer().catch((cause) => {
                throw new LambderUploadError("fileUnreadable", { cause });
            }))),
        };
        stopIfCancelled();
        const requestTicket = async () => {
            report("requesting");
            try {
                return await this.options.requestTicket(fileFacts, { signal });
            }
            catch (cause) {
                throw new LambderUploadError(signal?.aborted ? "cancelled" : "ticketRefused", { cause });
            }
        };
        let issued = await requestTicket();
        const backoff = new LambderBackoffTimer(this.backoff);
        let failedAttempts = 0;
        let ticketRenewals = 0;
        for (;;) {
            stopIfCancelled();
            report("uploading");
            const outcome = await this.post(issued.ticket, file, signal, (sentBytes) => report("uploading", sentBytes));
            if (outcome.kind === "stored")
                break;
            if (outcome.kind === "cancelled")
                throw new LambderUploadError("cancelled");
            if (outcome.kind === "rejected") {
                // An expired ticket needs no wait and costs no attempt, only a
                // new ticket; any other refusal is the file's, and final.
                if (!outcome.ticketExpired || ++ticketRenewals > TICKET_RENEWAL_LIMIT)
                    throw new LambderUploadError("storageRejected", { detail: outcome.detail });
                issued = await requestTicket();
                continue;
            }
            // The ticket is kept through a network retry, so a flaky
            // connection does not leave the app a record per attempt.
            if (++failedAttempts >= this.attempts)
                throw new LambderUploadError("networkFailed");
            // The wait rejects only for the signal: nothing else cancels it.
            await backoff.wait(signal).catch((cause) => {
                throw new LambderUploadError("cancelled", { cause });
            });
        }
        report("confirming", file.size);
        try {
            return await this.options.confirmUpload(issued.reference, { signal });
        }
        catch (cause) {
            throw new LambderUploadError(signal?.aborted ? "cancelled" : "confirmRefused", { cause });
        }
    }
    /** Forgets a confirmed upload through the app's endpoint, when it declared one. */
    async discard(receipt) {
        await this.options.discardUpload?.(receipt);
    }
    /** One post of the file to storage. Never throws: every ending is an outcome. */
    post(ticket, file, signal, onSent) {
        if (signal?.aborted)
            return Promise.resolve({ kind: "cancelled" });
        const form = new FormData();
        for (const [name, value] of Object.entries(ticket.formFields))
            form.append(name, value);
        // Storage ignores every field that comes after the file.
        form.append("file", file);
        return typeof XMLHttpRequest === "function"
            ? postWithXhr(ticket.uploadUrl, form, file.size, this.stallTimeoutMs, signal, onSent)
            : postWithFetch(ticket.uploadUrl, form, file.size, signal, onSent);
    }
}
/** XMLHttpRequest rather than fetch where it exists: fetch cannot report how much of a request body has been sent. */
const postWithXhr = (url, form, fileBytes, stallTimeoutMs, signal, onSent) => new Promise((resolve) => {
    const request = new XMLHttpRequest();
    let stalled = false;
    let stallTimer;
    const watchForStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
            stalled = true;
            request.abort();
        }, stallTimeoutMs);
    };
    const cancel = () => request.abort();
    const settle = (outcome) => {
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
        if (request.status >= 200 && request.status < 300)
            return settle({ kind: "stored" });
        if (request.status >= 500)
            return settle({ kind: "unreachable" });
        settle(rejectedOutcome(request.status, request.responseText));
    };
    request.onerror = () => settle({ kind: "unreachable" });
    request.onabort = () => settle(stalled ? { kind: "unreachable" } : { kind: "cancelled" });
    signal?.addEventListener("abort", cancel, { once: true });
    watchForStall();
    try {
        request.open("POST", url);
        request.send(form);
    }
    catch {
        // A URL the browser will not open, or a request it will not send, answers nothing.
        settle({ kind: "unreachable" });
    }
});
const postWithFetch = async (url, form, fileBytes, signal, onSent) => {
    let response;
    try {
        response = await fetch(url, { method: "POST", body: form, signal });
    }
    catch {
        return signal?.aborted ? { kind: "cancelled" } : { kind: "unreachable" };
    }
    if (response.ok) {
        onSent(fileBytes);
        return { kind: "stored" };
    }
    if (response.status >= 500)
        return { kind: "unreachable" };
    return rejectedOutcome(response.status, await response.text().catch(() => ""));
};
const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
const xmlText = (text) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (entity, name) => {
    if (name[0] !== "#")
        return XML_ENTITIES[name] ?? entity;
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
const rejectedOutcome = (status, body) => {
    const code = xmlText(/<Code>([^<]*)<\/Code>/.exec(body)?.[1] ?? "") || `HTTP ${status}`;
    const message = xmlText(/<Message>([^<]*)<\/Message>/.exec(body)?.[1] ?? "");
    if (TRANSIENT_STORAGE_CODES.has(code))
        return { kind: "unreachable" };
    return {
        kind: "rejected",
        ticketExpired: code === "ExpiredToken" || (code === "AccessDenied" && /expired/i.test(message)),
        detail: message ? `${code}: ${message}` : code,
    };
};
