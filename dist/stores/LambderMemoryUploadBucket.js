import { assertObjectOptions, assertPinnedObjectKey, assertSignatureLifetime, } from "../shared/contracts/LambderUploadBucket.js";
import { contentDispositionHeader } from "../shared/util/LambderContentDisposition.js";
import { escapeXmlText } from "../shared/util/escapeXmlText.js";
import { uploadObjectFormFields } from "../shared/wire/LambderUploadObjectFields.js";
import { refuseUnacceptedUpload } from "../shared/wire/LambderUploadRefusal.js";
import { sha256Base64Of } from "../shared/util/LambderTextDigest.js";
/** The form field that names the ticket a post was signed with: the memory bucket's stand-in for S3's signed policy. */
const TICKET_FIELD = "x-lambder-upload-ticket";
/** The query parameter that names the link a download was issued with: the stand-in for S3's presigned query string. */
const LINK_PARAMETER = "x-lambder-download-link";
/**
 * An upload bucket in memory (see LambderUploadBucket), for tests and the
 * mock runtime.
 *
 * It holds a post to the rules S3 holds a presigned POST to: every field the
 * ticket carries, each with the ticket's value, and no other, all ahead of
 * the file (as S3 does, anything after the file is ignored); a ticket it
 * issued and not yet expired; a body of exactly the size described; and bytes
 * whose SHA-256 is the one described. It refuses otherwise with the status
 * and the XML error S3 answers with (AccessDenied for a policy, and "Policy
 * expired" for a late one, EntityTooSmall, EntityTooLarge, BadDigest), so any
 * client, a LambderUploadRunner or another, takes the same path against it as
 * against S3: an expired ticket is asked for again, a wrong file is refused.
 * A download link reads the object until it expires.
 *
 * Storage requests reach it through handleStorageRequest(), which answers a
 * fetch Request with a Response: lambderMockUploadMswHandler plugs that into
 * MSW, and a test can route a stubbed fetch to it directly. Everything it
 * uses is a web API (fetch's Request and Response, FormData, WebCrypto), so it
 * runs in a browser, a service worker and Node alike.
 */
export class LambderMemoryUploadBucket {
    /** Where tickets and download links point, always ending in a slash. */
    baseUrl;
    ticketLifetimeSeconds;
    downloadLifetimeSeconds;
    now;
    objects = new Map();
    tickets = new Map();
    links = new Map();
    constructor({ baseUrl, ticketLifetimeSeconds = 600, downloadLifetimeSeconds = 300, now = Date.now } = {}) {
        assertSignatureLifetime(ticketLifetimeSeconds, "ticketLifetimeSeconds");
        assertSignatureLifetime(downloadLifetimeSeconds, "downloadLifetimeSeconds");
        const url = new URL(baseUrl ?? `https://upload-bucket-${crypto.randomUUID()}.invalid/`);
        url.search = "";
        url.hash = "";
        this.baseUrl = url.href.endsWith("/") ? url.href : `${url.href}/`;
        this.ticketLifetimeSeconds = ticketLifetimeSeconds;
        this.downloadLifetimeSeconds = downloadLifetimeSeconds;
        this.now = now;
    }
    async issueUploadTicket({ objectKey, fileFacts, uploadRule, lifetimeSeconds = this.ticketLifetimeSeconds, object = {} }) {
        assertPinnedObjectKey(objectKey);
        assertSignatureLifetime(lifetimeSeconds, "lifetimeSeconds");
        assertObjectOptions(object);
        refuseUnacceptedUpload(uploadRule, fileFacts);
        const ticketId = crypto.randomUUID();
        const expiresAt = this.now() + lifetimeSeconds * 1000;
        // The fields S3's ticket carries, so a client posts the same form to either.
        const formFields = {
            key: objectKey,
            "Content-Type": fileFacts.mimeType,
            "x-amz-checksum-algorithm": "SHA256",
            "x-amz-checksum-sha256": fileFacts.sha256Base64,
            ...uploadObjectFormFields(object),
            [TICKET_FIELD]: ticketId,
        };
        this.tickets.set(ticketId, { objectKey, mimeType: fileFacts.mimeType, byteSize: fileFacts.byteSize, sha256Base64: fileFacts.sha256Base64, expiresAt, formFields, object });
        return { uploadUrl: this.baseUrl, formFields, expiresAt };
    }
    async verifyUploadedObject({ objectKey, fileFacts }) {
        const object = this.objects.get(objectKey);
        if (!object)
            return { verified: false, reason: "objectMissing" };
        const matches = object.body.byteLength === fileFacts.byteSize && object.sha256Base64 === fileFacts.sha256Base64;
        return matches ? { verified: true } : { verified: false, reason: "factsMismatch" };
    }
    async issueDownloadUrl({ objectKey, lifetimeSeconds = this.downloadLifetimeSeconds, contentDisposition }) {
        assertSignatureLifetime(lifetimeSeconds, "lifetimeSeconds");
        const linkId = crypto.randomUUID();
        this.links.set(linkId, { objectKey, expiresAt: this.now() + lifetimeSeconds * 1000, contentDisposition });
        // Appended rather than resolved against the base, so a key that starts
        // with a slash stays under it.
        const url = new URL(`${this.baseUrl}${encodeObjectKey(objectKey)}`);
        url.searchParams.set(LINK_PARAMETER, linkId);
        return url.href;
    }
    async readObject(objectKey) {
        const object = this.objects.get(objectKey);
        if (!object)
            throw new Error(`LambderMemoryUploadBucket.readObject: nothing is stored under ${objectKey}`);
        return object.body.slice();
    }
    async writeObject({ objectKey, body, mimeType, sha256Base64, object = {} }) {
        assertObjectOptions(object);
        const computed = await sha256Base64Of(body);
        // S3 refuses a body whose checksum is not the one sent (BadDigest), and so does this.
        if (sha256Base64 !== undefined && sha256Base64 !== computed) {
            throw new Error(`LambderMemoryUploadBucket.writeObject: the SHA-256 given for ${objectKey} is not the body's`);
        }
        this.objects.set(objectKey, { body: body.slice(), mimeType, sha256Base64: computed, object });
    }
    async copyObject({ fromObjectKey, toObjectKey }) {
        const object = this.objects.get(fromObjectKey);
        if (!object)
            throw new Error(`LambderMemoryUploadBucket.copyObject: nothing is stored under ${fromObjectKey}`);
        this.objects.set(toObjectKey, { ...object, body: object.body.slice() });
    }
    async deleteObject(objectKey) {
        this.objects.delete(objectKey);
    }
    /** The keys that hold an object, sorted, for a test to assert on. */
    listObjectKeys() {
        return [...this.objects.keys()].sort();
    }
    /** What is held under a key (its facts, tags, metadata and headers), for a test to assert on; null when nothing is. */
    inspectObject(objectKey) {
        const stored = this.objects.get(objectKey);
        return stored ? { byteSize: stored.body.byteLength, mimeType: stored.mimeType, sha256Base64: stored.sha256Base64, ...stored.object } : null;
    }
    /** Forgets every object, ticket and link. */
    reset() {
        this.objects.clear();
        this.tickets.clear();
        this.links.clear();
    }
    /**
     * Answers a request to storage the way S3 answers it: a post under a
     * ticket stores its file, a GET or HEAD through a download link reads an
     * object. A request outside baseUrl answers null, for the caller to hand
     * on.
     */
    async handleStorageRequest(request) {
        const url = new URL(request.url);
        if (!`${url.origin}${url.pathname}`.startsWith(this.baseUrl))
            return null;
        let objectKey;
        try {
            objectKey = decodeObjectKey(url.pathname.slice(new URL(this.baseUrl).pathname.length));
        }
        catch {
            return storageError(400, "InvalidURI", "Couldn't parse the specified URI.");
        }
        if (request.method === "POST" && objectKey === "")
            return this.acceptUpload(request);
        if (request.method === "GET" || request.method === "HEAD")
            return this.serveDownload(objectKey, url.searchParams.get(LINK_PARAMETER), request.method === "HEAD");
        return storageError(405, "MethodNotAllowed", "The specified method is not allowed against this resource.");
    }
    async acceptUpload(request) {
        let form;
        try {
            form = await request.formData();
        }
        catch {
            return storageError(400, "MalformedPOSTRequest", "The body of your POST request is not well-formed multipart/form-data.");
        }
        // S3 reads the form up to the file and ignores everything after it.
        const fields = new Map();
        let file;
        for (const [name, value] of form.entries()) {
            if (typeof value !== "string") {
                if (name === "file") {
                    file = value;
                    break;
                }
                continue;
            }
            fields.set(name, value);
        }
        if (!file)
            return storageError(400, "InvalidArgument", "POST requires exactly one file upload per request.");
        const ticketId = fields.get(TICKET_FIELD);
        const ticket = ticketId === undefined ? undefined : this.tickets.get(ticketId);
        if (!ticket)
            return storageError(403, "AccessDenied", "Invalid according to Policy: Policy Condition failed");
        if (this.now() >= ticket.expiresAt)
            return storageError(403, "AccessDenied", "Invalid according to Policy: Policy expired.");
        const extra = [...fields.keys()].filter((name) => !(name in ticket.formFields));
        if (extra.length)
            return storageError(403, "AccessDenied", `Invalid according to Policy: Extra input fields: ${extra.join(", ")}`);
        const pinned = Object.entries(ticket.formFields).every(([name, value]) => fields.get(name) === value);
        if (!pinned)
            return storageError(403, "AccessDenied", "Invalid according to Policy: Policy Condition failed");
        const body = new Uint8Array(await file.arrayBuffer());
        if (body.byteLength < ticket.byteSize)
            return storageError(400, "EntityTooSmall", "Your proposed upload is smaller than the minimum allowed size");
        if (body.byteLength > ticket.byteSize)
            return storageError(400, "EntityTooLarge", "Your proposed upload exceeds the maximum allowed size");
        const sha256Base64 = await sha256Base64Of(body);
        if (sha256Base64 !== ticket.sha256Base64)
            return storageError(400, "BadDigest", "The SHA256 you specified did not match the calculated checksum.");
        this.objects.set(ticket.objectKey, { body, mimeType: ticket.mimeType, sha256Base64, object: ticket.object });
        return new Response(null, { status: 204 });
    }
    serveDownload(objectKey, linkId, headOnly) {
        const link = linkId === null ? undefined : this.links.get(linkId);
        if (!link || link.objectKey !== objectKey)
            return storageError(403, "AccessDenied", "Access Denied");
        if (this.now() >= link.expiresAt)
            return storageError(403, "AccessDenied", "Request has expired");
        const stored = this.objects.get(objectKey);
        if (!stored)
            return storageError(404, "NoSuchKey", "The specified key does not exist.");
        const headers = { "content-type": stored.mimeType, "content-length": String(stored.body.byteLength) };
        if (stored.object.cacheControl !== undefined)
            headers["cache-control"] = stored.object.cacheControl;
        // The link's own disposition over the object's, as S3 answers a presigned read.
        const disposition = link.contentDisposition ?? stored.object.contentDisposition;
        if (disposition)
            headers["content-disposition"] = contentDispositionHeader(disposition);
        return new Response(headOnly ? null : new Blob([stored.body]), { status: 200, headers });
    }
}
/** A key as a URL path: each segment escaped, the slashes kept, as S3 addresses an object. */
const encodeObjectKey = (objectKey) => objectKey.split("/").map(encodeURIComponent).join("/");
const decodeObjectKey = (path) => path.split("/").map(decodeURIComponent).join("/");
/** An error the way S3 writes one: the status, and `<Error><Code/><Message/></Error>` as XML. */
const storageError = (status, code, message) => new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${escapeXmlText(code)}</Code><Message>${escapeXmlText(message)}</Message></Error>`, { status, headers: { "content-type": "application/xml" } });
