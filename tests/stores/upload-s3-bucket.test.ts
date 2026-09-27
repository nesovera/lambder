/**
 * LambderS3UploadBucket: the tickets it signs and the calls it makes.
 *
 * Signing is arithmetic over the credentials, so a client with made-up keys
 * signs real tickets and links without reaching anything. The calls that
 * would reach the bucket are answered by a stubbed `send`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { LambderS3UploadBucket } from '../../src/stores/LambderS3UploadBucket.js';
import { LAMBDER_REFUSAL_CODES, LambderApiRefusal } from '../../src/shared/wire/LambderApiRefusal.js';
import type { LambderUploadFileFacts, LambderUploadRule } from '../../src/shared/contracts/LambderUploadBucket.js';

const BUCKET = 'shop-invoices';
const OBJECT_KEY = 'stores/store-7/invoices/1042.pdf';
const NOW = 1_790_000_000_000;

const PDF_RULE: LambderUploadRule = { maxBytes: 25 * 1024 * 1024, mimeTypes: ['application/pdf'] };

const INVOICE_FACTS: LambderUploadFileFacts = {
    fileName: 'Invoice 1042.pdf',
    mimeType: 'application/pdf',
    byteSize: 1_482_113,
    sha256Base64: '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
};

const makeClient = () => new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIATESTTESTTESTTEST', secretAccessKey: 'test-secret' },
});

const makeBucket = () => {
    const client = makeClient();
    const send = vi.spyOn(client, 'send');
    return { bucket: new LambderS3UploadBucket({ bucket: BUCKET, client }), send };
};

/** The signed policy, decoded: what S3 will actually enforce. */
const readPolicy = (formFields: Record<string, string>) =>
    JSON.parse(Buffer.from(formFields.Policy ?? '', 'base64').toString('utf8')) as { expiration: string; conditions: unknown[] };

/** The refusal a rejected promise carried, for its code. */
const refusalOf = async (pending: Promise<unknown>) => {
    const refusal = await pending.then(() => null, (err: unknown) => err);
    expect(refusal).toBeInstanceOf(LambderApiRefusal);
    return refusal as LambderApiRefusal;
};

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('LambderS3UploadBucket.issueUploadTicket', () => {
    it('pins the key, the exact size, the type and the checksum in the signed policy', async () => {
        const { bucket, send } = makeBucket();
        const ticket = await bucket.issueUploadTicket({ objectKey: OBJECT_KEY, fileFacts: INVOICE_FACTS, uploadRule: PDF_RULE });

        const { conditions } = readPolicy(ticket.formFields);
        expect(conditions).toContainEqual({ key: OBJECT_KEY });
        expect(conditions).toContainEqual({ bucket: BUCKET });
        expect(conditions).toContainEqual(['content-length-range', INVOICE_FACTS.byteSize, INVOICE_FACTS.byteSize]);
        expect(conditions).toContainEqual({ 'Content-Type': 'application/pdf' });
        expect(conditions).toContainEqual({ 'x-amz-checksum-algorithm': 'SHA256' });
        expect(conditions).toContainEqual({ 'x-amz-checksum-sha256': INVOICE_FACTS.sha256Base64 });

        // The browser sends the same values the policy pins.
        expect(ticket.formFields).toMatchObject({ key: OBJECT_KEY, 'Content-Type': 'application/pdf', 'x-amz-checksum-sha256': INVOICE_FACTS.sha256Base64 });
        expect(ticket.uploadUrl).toContain(BUCKET);
        expect(send).not.toHaveBeenCalled();
    });

    it('expires the ticket and the policy together', async () => {
        vi.useFakeTimers({ now: NOW });
        const bucket = new LambderS3UploadBucket({ bucket: BUCKET, client: makeClient(), ticketLifetimeSeconds: 120 });
        const ticket = await bucket.issueUploadTicket({ objectKey: OBJECT_KEY, fileFacts: INVOICE_FACTS, uploadRule: PDF_RULE });

        expect(ticket.expiresAt).toBe(NOW + 120_000);
        expect(Date.parse(readPolicy(ticket.formFields).expiration)).toBe(NOW + 120_000);
    });

    it('refuses what the rule does not accept, with a code a client can translate, and accepts a file exactly at the limit', async () => {
        const { bucket } = makeBucket();
        const issue = (fileFacts: LambderUploadFileFacts) => bucket.issueUploadTicket({ objectKey: OBJECT_KEY, fileFacts, uploadRule: PDF_RULE });

        expect((await refusalOf(issue({ ...INVOICE_FACTS, mimeType: 'image/png' }))).errorMessage).toMatchObject({ code: LAMBDER_REFUSAL_CODES.uploadTypeRejected, content: 'This type of file is not accepted.' });
        expect((await refusalOf(issue({ ...INVOICE_FACTS, byteSize: PDF_RULE.maxBytes + 1 }))).errorMessage).toMatchObject({ code: LAMBDER_REFUSAL_CODES.uploadTooLarge });
        expect((await refusalOf(issue({ ...INVOICE_FACTS, byteSize: 0 }))).errorMessage).toMatchObject({ code: LAMBDER_REFUSAL_CODES.uploadEmpty });
        await expect(issue({ ...INVOICE_FACTS, byteSize: PDF_RULE.maxBytes })).resolves.toBeDefined();
    });

    it('pins what the stored object carries in the policy: tags, metadata, cache and disposition headers', async () => {
        const { bucket } = makeBucket();
        const ticket = await bucket.issueUploadTicket({
            objectKey: OBJECT_KEY, fileFacts: INVOICE_FACTS, uploadRule: PDF_RULE,
            object: {
                tags: { retention: '30d', store: 'store-7' },
                metadata: { Invoice: '1042' },
                cacheControl: 'private, max-age=3600',
                contentDisposition: { disposition: 'attachment', fileName: 'Invoice 1042.pdf' },
            },
        });

        const { conditions } = readPolicy(ticket.formFields);
        const tagging = '<Tagging><TagSet><Tag><Key>retention</Key><Value>30d</Value></Tag><Tag><Key>store</Key><Value>store-7</Value></Tag></TagSet></Tagging>';
        expect(conditions).toContainEqual({ tagging });
        expect(conditions).toContainEqual({ 'x-amz-meta-invoice': '1042' });
        expect(conditions).toContainEqual({ 'Cache-Control': 'private, max-age=3600' });
        expect(conditions).toContainEqual({ 'Content-Disposition': 'attachment; filename="Invoice 1042.pdf"; filename*=UTF-8\'\'Invoice%201042.pdf' });
        expect(ticket.formFields).toMatchObject({ tagging, 'x-amz-meta-invoice': '1042', 'Cache-Control': 'private, max-age=3600' });
    });

    it('signs a ticket for its own lifetime when given one, within S3\'s seven days', async () => {
        vi.useFakeTimers({ now: NOW });
        const { bucket } = makeBucket();
        const ticket = await bucket.issueUploadTicket({ objectKey: OBJECT_KEY, fileFacts: INVOICE_FACTS, uploadRule: PDF_RULE, lifetimeSeconds: 60 });

        expect(ticket.expiresAt).toBe(NOW + 60_000);
        expect(Date.parse(readPolicy(ticket.formFields).expiration)).toBe(NOW + 60_000);
        await expect(bucket.issueUploadTicket({ objectKey: OBJECT_KEY, fileFacts: INVOICE_FACTS, uploadRule: PDF_RULE, lifetimeSeconds: 8 * 24 * 3600 })).rejects.toThrow(RangeError);
        expect(() => new LambderS3UploadBucket({ bucket: BUCKET, ticketLifetimeSeconds: 0 })).toThrow(RangeError);
        expect(() => new LambderS3UploadBucket({ bucket: BUCKET, downloadLifetimeSeconds: 8 * 24 * 3600 })).toThrow(/seven days/);
    });

    it('refuses object options S3 would not keep, where the app wrote them', async () => {
        const { bucket } = makeBucket();
        const issue = (object: object) => bucket.issueUploadTicket({ objectKey: OBJECT_KEY, fileFacts: INVOICE_FACTS, uploadRule: PDF_RULE, object });

        await expect(issue({ tags: Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`tag${index}`, 'x'])) })).rejects.toThrow(/at most 10 tags/);
        await expect(issue({ metadata: { 'no spaces': 'x' } })).rejects.toThrow(/metadata name/);
        await expect(issue({ metadata: { note: 'café' } })).rejects.toThrow(/printable ASCII/);
    });

    it('will not sign a key holding ${filename}, which S3 would fill with the uploaded file\'s own name', async () => {
        const { bucket } = makeBucket();

        await expect(bucket.issueUploadTicket({ objectKey: 'stores/store-7/invoices/${filename}', fileFacts: INVOICE_FACTS, uploadRule: PDF_RULE })).rejects.toThrow(/may not hold \$\{filename\}/);
    });
});

describe('LambderS3UploadBucket.verifyUploadedObject', () => {
    it('verifies an object whose size and checksum match, asking the bucket for the checksum', async () => {
        const { bucket, send } = makeBucket();
        send.mockResolvedValue({ ContentLength: INVOICE_FACTS.byteSize, ChecksumSHA256: INVOICE_FACTS.sha256Base64 } as never);

        await expect(bucket.verifyUploadedObject({ objectKey: OBJECT_KEY, fileFacts: INVOICE_FACTS })).resolves.toEqual({ verified: true });

        const command = send.mock.calls[0]?.[0] as HeadObjectCommand;
        expect(command).toBeInstanceOf(HeadObjectCommand);
        expect(command.input).toEqual({ Bucket: BUCKET, Key: OBJECT_KEY, ChecksumMode: 'ENABLED' });
    });

    it('says objectMissing when nothing was posted', async () => {
        const { bucket, send } = makeBucket();
        send.mockRejectedValue(Object.assign(new Error('NotFound'), { name: 'NotFound' }) as never);

        await expect(bucket.verifyUploadedObject({ objectKey: OBJECT_KEY, fileFacts: INVOICE_FACTS })).resolves.toEqual({ verified: false, reason: 'objectMissing' });
    });

    it('says factsMismatch when something else sits under the key', async () => {
        const { bucket, send } = makeBucket();
        send.mockResolvedValue({ ContentLength: INVOICE_FACTS.byteSize, ChecksumSHA256: 'b3RoZXIgYnl0ZXMgZW50aXJlbHksIHNhbWUgbGVuZ3RoIQ=' } as never);

        await expect(bucket.verifyUploadedObject({ objectKey: OBJECT_KEY, fileFacts: INVOICE_FACTS })).resolves.toEqual({ verified: false, reason: 'factsMismatch' });
    });

    it('lets a storage failure through instead of calling it a missing object', async () => {
        const { bucket, send } = makeBucket();
        send.mockRejectedValue(Object.assign(new Error('Slow down'), { name: 'SlowDown' }) as never);

        await expect(bucket.verifyUploadedObject({ objectKey: OBJECT_KEY, fileFacts: INVOICE_FACTS })).rejects.toThrow('Slow down');
    });
});

describe('LambderS3UploadBucket links, reads, writes, copies and deletes', () => {
    it('signs a download link for the key with the asked lifetime, without reaching the bucket', async () => {
        const { bucket, send } = makeBucket();
        const url = new URL(await bucket.issueDownloadUrl({ objectKey: OBJECT_KEY, lifetimeSeconds: 90 }));

        expect(url.hostname).toContain(BUCKET);
        expect(url.pathname).toBe(`/${OBJECT_KEY}`);
        expect(url.searchParams.get('X-Amz-Expires')).toBe('90');
        expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
        expect(send).not.toHaveBeenCalled();
    });

    it('signs links for the bucket\'s link lifetime, and with the disposition a link asks for', async () => {
        const bucket = new LambderS3UploadBucket({ bucket: BUCKET, client: makeClient(), downloadLifetimeSeconds: 900 });
        const url = new URL(await bucket.issueDownloadUrl({ objectKey: OBJECT_KEY, contentDisposition: { disposition: 'attachment', fileName: 'Faktúra "1042".pdf' } }));

        expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
        expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="Fakt_ra _1042_.pdf"; filename*=UTF-8\'\'Fakt%C3%BAra%20%221042%22.pdf');
        await expect(bucket.issueDownloadUrl({ objectKey: OBJECT_KEY, lifetimeSeconds: 8 * 24 * 3600 })).rejects.toThrow(RangeError);
    });

    it('reads an object\'s bytes', async () => {
        const { bucket, send } = makeBucket();
        const bytes = new Uint8Array([37, 80, 68, 70]);
        send.mockResolvedValue({ Body: { transformToByteArray: async () => bytes } } as never);

        await expect(bucket.readObject(OBJECT_KEY)).resolves.toEqual(bytes);
        const command = send.mock.calls[0]?.[0] as GetObjectCommand;
        expect(command).toBeInstanceOf(GetObjectCommand);
        expect(command.input).toEqual({ Bucket: BUCKET, Key: OBJECT_KEY });
    });

    it('writes server-made bytes with the checksum given, so S3 refuses a damaged body', async () => {
        const { bucket, send } = makeBucket();
        send.mockResolvedValue({} as never);
        const body = new Uint8Array([37, 80, 68, 70]);

        await bucket.writeObject({ objectKey: OBJECT_KEY, body, mimeType: 'application/pdf', sha256Base64: INVOICE_FACTS.sha256Base64 });

        const command = send.mock.calls[0]?.[0] as PutObjectCommand;
        expect(command).toBeInstanceOf(PutObjectCommand);
        expect(command.input).toEqual({ Bucket: BUCKET, Key: OBJECT_KEY, Body: body, ContentType: 'application/pdf', ChecksumSHA256: INVOICE_FACTS.sha256Base64 });
    });

    it('writes what the object carries: tags as a query string, metadata lowercased, and the two headers', async () => {
        const { bucket, send } = makeBucket();
        send.mockResolvedValue({} as never);
        const body = new Uint8Array([37, 80, 68, 70]);

        await bucket.writeObject({
            objectKey: OBJECT_KEY, body, mimeType: 'application/pdf', sha256Base64: INVOICE_FACTS.sha256Base64,
            object: { tags: { retention: '30d', note: 'a&b' }, metadata: { Invoice: '1042' }, cacheControl: 'no-store', contentDisposition: { disposition: 'inline' } },
        });

        expect((send.mock.calls[0]?.[0] as PutObjectCommand).input).toMatchObject({
            Tagging: 'retention=30d&note=a%26b',
            Metadata: { invoice: '1042' },
            CacheControl: 'no-store',
            ContentDisposition: 'inline',
        });
    });

    it('has the SDK compute the checksum when none is given, so every object carries one to verify against', async () => {
        const { bucket, send } = makeBucket();
        send.mockResolvedValue({} as never);
        const body = new Uint8Array([37, 80, 68, 70]);

        await bucket.writeObject({ objectKey: OBJECT_KEY, body, mimeType: 'application/pdf' });

        expect((send.mock.calls[0]?.[0] as PutObjectCommand).input).toEqual({ Bucket: BUCKET, Key: OBJECT_KEY, Body: body, ContentType: 'application/pdf', ChecksumAlgorithm: 'SHA256' });
    });

    it('copies an object inside the bucket, naming the source as an escaped path', async () => {
        const { bucket, send } = makeBucket();
        send.mockResolvedValue({} as never);

        await bucket.copyObject({ fromObjectKey: 'stores/store-7/drafts/invoice 1042.pdf', toObjectKey: OBJECT_KEY });

        const command = send.mock.calls[0]?.[0] as CopyObjectCommand;
        expect(command).toBeInstanceOf(CopyObjectCommand);
        expect(command.input).toEqual({ Bucket: BUCKET, CopySource: `${BUCKET}/stores/store-7/drafts/invoice%201042.pdf`, Key: OBJECT_KEY });
    });

    it('deletes the object under the key', async () => {
        const { bucket, send } = makeBucket();
        send.mockResolvedValue({} as never);

        await bucket.deleteObject(OBJECT_KEY);

        const command = send.mock.calls[0]?.[0] as DeleteObjectCommand;
        expect(command).toBeInstanceOf(DeleteObjectCommand);
        expect(command.input).toEqual({ Bucket: BUCKET, Key: OBJECT_KEY });
    });

    it('creates its own client from clientConfig on first use when given none', async () => {
        const bucket = new LambderS3UploadBucket({ bucket: BUCKET, clientConfig: { region: 'us-east-1', credentials: { accessKeyId: 'AKIATESTTESTTESTTEST', secretAccessKey: 'test-secret' } } });
        const url = new URL(await bucket.issueDownloadUrl({ objectKey: OBJECT_KEY }));

        expect(url.hostname).toBe(`${BUCKET}.s3.us-east-1.amazonaws.com`);
        expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    });
});
