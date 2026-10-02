/**
 * A direct upload end to end, as a mock app runs it: LambderUploadRunner in
 * front, a LambderMemoryUploadBucket as the storage, and
 * lambderMockUploadMswHandler between them, so the runner's uploads and a
 * download link's GET travel over fetch through MSW to the bucket. Node has
 * no XMLHttpRequest, so the runner uploads over fetch here; the bucket answers
 * them the way the store answers the XHR ones. One bucket signs POST tickets,
 * as S3 does, and one PUT tickets, as a store without POST policies does.
 */

import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as msw from 'msw';
import { setupServer } from 'msw/node';
import { z } from 'zod';
import { LambderMemoryUploadBucket } from '../../src/stores/LambderMemoryUploadBucket.js';
import { lambderMockUploadMswHandler } from '../../src/mock/lambderMockUploadMswHandler.js';
import { LambderUploadError, LambderUploadRunner, type LambderUploadProgress, type LambderUploadRunnerOptions } from '../../src/client/LambderUploadRunner.js';
import { LambderUploadFileFactsSchema, LambderUploadTicketSchema } from '../../src/shared/wire/LambderUploadSchemas.js';
import { sha256Base64Of } from '../../src/shared/util/LambderTextDigest.js';
import type { LambderApiOutcome } from '../../src/shared/wire/LambderApiOutcome.js';
import type { LambderUploadFileFacts, LambderUploadRule, LambderUploadTicket } from '../../src/shared/contracts/LambderUploadBucket.js';
import LambderCaller from '../../src/client/LambderCaller.js';
import { initLambder } from '../../src/core/Lambder.js';
import { refuse } from '../../src/shared/wire/LambderApiRefusal.js';
import { lambderHandlerTransport } from '../../src/invoke/lambderHandlerTransport.js';

let clock = 1_790_000_000_000;
const bucket = new LambderMemoryUploadBucket({ now: () => clock });
const putBucket = new LambderMemoryUploadBucket({ now: () => clock, uploadMethod: 'PUT' });
const server = setupServer(lambderMockUploadMswHandler(bucket, { msw }), lambderMockUploadMswHandler(putBucket, { msw }));

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
    server.resetHandlers();
    bucket.reset();
    putBucket.reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
afterAll(() => server.close());

const PDF_RULE: LambderUploadRule = { maxBytes: 1024, mimeTypes: ['application/pdf'] };
const invoice = (text = '%PDF-1.4 invoice 1042') => new File([new TextEncoder().encode(text)], 'Invoice 1042.pdf', { type: 'application/pdf' });

/** What the ticket endpoints below answer: the ticket, and the key the confirm endpoint finds the upload by. */
type IssuedTicket = { ticket: LambderUploadTicket; objectKey: string };

/** An endpoint's output as the success outcome a caller's `.outcome()` resolves to. */
const answered = <T,>(payload: T): LambderApiOutcome<T> => ({ ok: true, payload, response: { apiVersion: '1', payload } });

/** An endpoint's refusal, as a caller's outcome carries it. */
const refusedWith = (content: string, code?: string): LambderApiOutcome<never> => {
    const refusal = { type: 'error' as const, content, ...(code !== undefined ? { code } : {}) };
    return { ok: false, reason: 'refusal', status: 200, refusal, response: { apiVersion: '1', payload: null, refusal } };
};

/** A call that got no usable answer, or that its signal aborted, as a caller reports it. */
const unanswered = (reason: 'network' | 'timeout' | 'server' | 'aborted'): LambderApiOutcome<never> =>
    ({ ok: false, reason, ...(reason === 'server' ? { status: 503 } : {}), error: new Error(`the call failed as ${reason}`) });

type Options = LambderUploadRunnerOptions<IssuedTicket, { objectKey: string }>;

/**
 * An app's ticket and confirm endpoints over the memory bucket, as a mock's
 * handlers write them, counting the calls that reach them. `issueFor` lets a
 * case sign a ticket for other facts than the runner sent.
 */
const bucketEndpoints = (issueFor?: (facts: LambderUploadFileFacts) => LambderUploadFileFacts) => {
    const factsByKey = new Map<string, LambderUploadFileFacts>();
    const calls = { requestTicket: 0, confirmUpload: 0 };
    const requestTicket: Options['requestTicket'] = async (fileFacts) => {
        calls.requestTicket++;
        // What an app's endpoint declares its input and output with.
        const facts = LambderUploadFileFactsSchema.parse(issueFor?.(fileFacts) ?? fileFacts);
        const objectKey = `stores/store-7/invoices/${calls.requestTicket}.pdf`;
        factsByKey.set(objectKey, facts);
        const ticket = LambderUploadTicketSchema.parse(await bucket.issueUploadTicket({ objectKey, fileFacts: facts, uploadRule: PDF_RULE }));
        return answered({ ticket, objectKey });
    };
    const confirmUpload: Options['confirmUpload'] = async ({ objectKey }) => {
        calls.confirmUpload++;
        const verdict = await bucket.verifyUploadedObject({ objectKey, fileFacts: factsByKey.get(objectKey)! });
        if(!verdict.verified) return refusedWith(verdict.reason);
        return answered({ objectKey });
    };
    return { calls, requestTicket, confirmUpload };
};

/** A runner over the memory bucket's endpoints, a case's own taking their place where it names them. */
const runnerFor = (overrides: Partial<Options> & { issueFor?: (facts: LambderUploadFileFacts) => LambderUploadFileFacts; endpoints?: ReturnType<typeof bucketEndpoints> } = {}) => {
    const { issueFor, endpoints = bucketEndpoints(issueFor), ...options } = overrides;
    const runner = new LambderUploadRunner<IssuedTicket, { objectKey: string }>({
        uploadRule: PDF_RULE,
        requestTicket: endpoints.requestTicket,
        confirmUpload: endpoints.confirmUpload,
        storageRetry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
        ...options,
    });
    return { runner, calls: endpoints.calls };
};

/** A POST ticket's form fields, for a case that posts by hand. */
const formFieldsOf = (ticket: LambderUploadTicket) => {
    if(ticket.method !== 'POST') throw new Error(`expected a POST ticket, got ${ticket.method}`);
    return ticket.formFields;
};

/** A PUT ticket's headers, for a case that puts by hand. */
const headersOf = (ticket: LambderUploadTicket) => {
    if(ticket.method !== 'PUT') throw new Error(`expected a PUT ticket, got ${ticket.method}`);
    return ticket.headers;
};

/** The facts a runner would send for a file. */
const factsOf = async (file: File): Promise<LambderUploadFileFacts> => ({
    fileName: file.name, mimeType: file.type, byteSize: file.size, sha256Base64: await sha256Base64Of(new Uint8Array(await file.arrayBuffer())),
});

const failureOf = async (pending: Promise<unknown>) => {
    const error = await pending.then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(LambderUploadError);
    return error as LambderUploadError;
};

describe('LambderUploadRunner over a memory bucket', () => {
    it('hashes, asks for a ticket, posts the bytes to storage and has the server confirm them', async () => {
        const { runner } = runnerFor();
        const phases: LambderUploadProgress['phase'][] = [];

        const receipt = await runner.upload(invoice(), { onProgress: ({ phase }) => { if(phases.at(-1) !== phase) phases.push(phase); } });

        expect(receipt).toEqual({ objectKey: 'stores/store-7/invoices/1.pdf' });
        expect(phases).toEqual(['hashing', 'requesting', 'uploading', 'confirming']);
        expect(bucket.listObjectKeys()).toEqual(['stores/store-7/invoices/1.pdf']);
        expect(new TextDecoder().decode(await bucket.readObject(receipt.objectKey))).toBe('%PDF-1.4 invoice 1042');
    });

    it('refuses what the rule does not accept before hashing or asking for anything', async () => {
        const { runner, calls } = runnerFor();

        expect((await failureOf(runner.upload(new File(['x'], 'photo.png', { type: 'image/png' })))).reason).toBe('fileTypeRejected');
        expect((await failureOf(runner.upload(new File([new Uint8Array(1025)], 'big.pdf', { type: 'application/pdf' })))).reason).toBe('fileTooLarge');
        expect((await failureOf(runner.upload(new File([], 'empty.pdf', { type: 'application/pdf' })))).reason).toBe('fileEmpty');
        expect(calls.requestTicket).toBe(0);
        expect(runner.acceptedTypes).toBe('application/pdf');
    });

    it('is refused by storage when the bytes are not the ones the ticket was signed for', async () => {
        const other = await sha256Base64Of(new TextEncoder().encode('another file'));
        const { runner } = runnerFor({ issueFor: (facts) => ({ ...facts, sha256Base64: other }) });

        const failure = await failureOf(runner.upload(invoice()));

        expect(failure.reason).toBe('storageRejected');
        expect(failure.message).toBe('storageRejected: BadDigest: The SHA256 you specified did not match the calculated checksum.');
        expect(bucket.listObjectKeys()).toEqual([]);
    });

    it('asks for a new ticket when storage says the first one expired, and keeps going', async () => {
        let issued = 0;
        const runner = new LambderUploadRunner<IssuedTicket, string>({
            uploadRule: PDF_RULE,
            requestTicket: async (fileFacts) => {
                issued++;
                const objectKey = `stores/store-7/invoices/${issued}.pdf`;
                const ticket = await bucket.issueUploadTicket({ objectKey, fileFacts, uploadRule: PDF_RULE });
                // The first ticket runs out before its post arrives.
                if(issued === 1) clock += 601_000;
                return answered({ ticket, objectKey });
            },
            confirmUpload: async ({ objectKey }) => answered(objectKey),
        });

        expect(await runner.upload(invoice())).toBe('stores/store-7/invoices/2.pdf');
        expect(issued).toBe(2);
        expect(bucket.listObjectKeys()).toEqual(['stores/store-7/invoices/2.pdf']);
    });

    it('tries storage again after a dropped connection or a 5xx, keeping the same ticket', async () => {
        const { runner, calls } = runnerFor();
        server.use(
            msw.http.post(bucket.baseUrl, () => msw.HttpResponse.error(), { once: true }),
            msw.http.post(bucket.baseUrl, () => new msw.HttpResponse(null, { status: 503 }), { once: true }),
        );

        expect(await runner.upload(invoice())).toEqual({ objectKey: 'stores/store-7/invoices/1.pdf' });
        expect(calls.requestTicket).toBe(1);
    });

    it('gives up as networkFailed once every attempt at storage has failed', async () => {
        const { runner, calls } = runnerFor();
        let posts = 0;
        server.use(msw.http.post(bucket.baseUrl, () => {
            posts++;
            return msw.HttpResponse.error();
        }));

        expect((await failureOf(runner.upload(invoice()))).reason).toBe('networkFailed');
        expect(posts).toBe(3);
        expect(calls.confirmUpload).toBe(0);
    });

    it('stops when the caller aborts, before the ticket or between it and the post', async () => {
        const abortedEarly = new AbortController();
        abortedEarly.abort();
        const { runner, calls } = runnerFor();
        expect((await failureOf(runner.upload(invoice(), { signal: abortedEarly.signal }))).reason).toBe('aborted');
        expect(calls.requestTicket).toBe(0);

        const abortedWhileAsking = new AbortController();
        const { runner: second } = runnerFor({
            requestTicket: async (fileFacts) => {
                const ticket = await bucket.issueUploadTicket({ objectKey: 'stores/store-7/invoices/late.pdf', fileFacts, uploadRule: PDF_RULE });
                abortedWhileAsking.abort();
                return answered({ ticket, objectKey: 'stores/store-7/invoices/late.pdf' });
            },
        });
        expect((await failureOf(second.upload(invoice(), { signal: abortedWhileAsking.signal }))).reason).toBe('aborted');
        expect(bucket.listObjectKeys()).toEqual([]);
    });

    it('stops during the wait before another try at storage', async () => {
        const controller = new AbortController();
        const { runner } = runnerFor({ storageRetry: { attempts: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 } });
        server.use(msw.http.post(bucket.baseUrl, () => {
            // The first post fails, and the caller gives up while the runner waits to try again.
            setTimeout(() => controller.abort(), 10);
            return msw.HttpResponse.error();
        }));

        expect((await failureOf(runner.upload(invoice(), { signal: controller.signal }))).reason).toBe('aborted');
    });

    it('tries storage again after S3 says the connection timed out, as its own SDK does', async () => {
        const { runner, calls } = runnerFor();
        server.use(msw.http.post(bucket.baseUrl, () => new msw.HttpResponse(
            '<Error><Code>RequestTimeout</Code><Message>Your socket connection to the server was not read from or written to within the timeout period.</Message></Error>',
            { status: 400, headers: { 'content-type': 'application/xml' } },
        ), { once: true }));

        expect(await runner.upload(invoice())).toEqual({ objectKey: 'stores/store-7/invoices/1.pdf' });
        expect(calls.requestTicket).toBe(1);
    });

    it('renews an expired ticket without spending an attempt at storage, and gives up after two renewals', async () => {
        let issued = 0;
        const expiring = (expireEvery: boolean) => new LambderUploadRunner<IssuedTicket, string>({
            uploadRule: PDF_RULE,
            requestTicket: async (fileFacts) => {
                issued++;
                const objectKey = `stores/store-7/invoices/${issued}.pdf`;
                const ticket = await bucket.issueUploadTicket({ objectKey, fileFacts, uploadRule: PDF_RULE });
                if(expireEvery || issued === 1) clock += 601_000;
                return answered({ ticket, objectKey });
            },
            confirmUpload: async ({ objectKey }) => answered(objectKey),
            // One attempt at storage: a renewal must not use it up.
            storageRetry: { attempts: 1 },
        });

        expect(await expiring(false).upload(invoice())).toBe('stores/store-7/invoices/2.pdf');

        issued = 0;
        const failure = await failureOf(expiring(true).upload(invoice()));
        expect(failure.reason).toBe('storageRejected');
        expect(failure.message).toContain('Policy expired');
        expect(issued).toBe(3);
    });

    it('renews a ticket whose signing credentials ran out first, as S3 says with ExpiredToken', async () => {
        const { runner, calls } = runnerFor({ storageRetry: { attempts: 1 } });
        server.use(msw.http.post(bucket.baseUrl, () => new msw.HttpResponse(
            '<Error><Code>ExpiredToken</Code><Message>The provided token has expired.</Message></Error>',
            { status: 400, headers: { 'content-type': 'application/xml' } },
        ), { once: true }));

        expect(await runner.upload(invoice())).toEqual({ objectKey: 'stores/store-7/invoices/2.pdf' });
        expect(calls.requestTicket).toBe(2);
    });

    it('refuses a storageRetry whose waits would be no pause at all where the runner is built, not on the first upload', () => {
        expect(() => runnerFor({ storageRetry: { attempts: 3, baseDelayMs: 0, maxDelayMs: 0 } })).toThrow(/baseMs must be a number above 0/);
    });

    it('waits a random time before every try at storage, the first included, under a ceiling that doubles', async () => {
        vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
        const waits: number[] = [];
        const realSetTimeout = globalThis.setTimeout;
        vi.stubGlobal('setTimeout', (callback: () => void, delay: number) => {
            waits.push(delay);
            return realSetTimeout(callback, 0);
        });
        vi.spyOn(Math, 'random').mockReturnValue(0.999999);
        const { runner } = runnerFor({ storageRetry: { attempts: 4, baseDelayMs: 100, maxDelayMs: 300 } });

        expect((await failureOf(runner.upload(invoice()))).reason).toBe('networkFailed');
        // At the top of each ceiling: twice the base, then doubled, held to maxDelayMs.
        expect(waits.map(Math.round)).toEqual([200, 300, 300]);
    });

    it('says fileUnreadable when the browser cannot read the file, before asking for a ticket', async () => {
        const { runner, calls } = runnerFor();
        const file = invoice();
        file.arrayBuffer = async () => { throw new DOMException('The requested file could not be read.', 'NotReadableError'); };

        const failure = await failureOf(runner.upload(file));
        expect(failure.reason).toBe('fileUnreadable');
        expect((failure.cause as DOMException).name).toBe('NotReadableError');
        expect(calls.requestTicket).toBe(0);
    });

    it('hands the upload\'s signal to the app\'s calls, and reads their failure after an abort as the abort', async () => {
        const controller = new AbortController();
        const seen: (AbortSignal | undefined)[] = [];
        const { runner } = runnerFor({
            confirmUpload: async (_issued, { signal }) => {
                seen.push(signal);
                controller.abort();
                return unanswered('aborted');
            },
        });

        const failure = await failureOf(runner.upload(invoice(), { signal: controller.signal }));
        expect(failure.reason).toBe('aborted');
        expect(failure.callFailure).toMatchObject({ reason: 'aborted' });
        expect(seen).toEqual([controller.signal]);

        // A call that throws once the upload is aborted is read as the abort too.
        const thrownAfterAbort = new AbortController();
        const { runner: throwing } = runnerFor({
            confirmUpload: async () => {
                thrownAfterAbort.abort();
                throw new DOMException('The operation was aborted.', 'AbortError');
            },
        });
        expect((await failureOf(throwing.upload(invoice(), { signal: thrownAfterAbort.signal }))).reason).toBe('aborted');
    });

    it('names the endpoint that said no, the ticket or the confirmation, and carries what it said', async () => {
        let ticketCalls = 0;
        const { runner: noTicket } = runnerFor({ requestTicket: async () => { ticketCalls++; return refusedWith('Uploads are closed for this store.', 'uploads-closed'); } });
        const refused = await failureOf(noTicket.upload(invoice()));
        expect(refused.reason).toBe('ticketRefused');
        expect(refused.message).toBe('ticketRefused: refusal: Uploads are closed for this store.');
        expect(refused.callFailure?.refusal).toMatchObject({ code: 'uploads-closed' });
        // A refusal is the endpoint's answer, and asking again would get it again.
        expect(ticketCalls).toBe(1);

        let confirmCalls = 0;
        const { runner: noConfirm } = runnerFor({ confirmUpload: async () => { confirmCalls++; return refusedWith('The invoice was withdrawn.'); } });
        const notConfirmed = await failureOf(noConfirm.upload(invoice()));
        expect(notConfirmed.reason).toBe('confirmRefused');
        expect(notConfirmed.callFailure).toMatchObject({ reason: 'refusal', refusal: { content: 'The invoice was withdrawn.' } });
        expect(confirmCalls).toBe(1);

        // An app function that throws rather than answering is its own code failing, which no retry cures.
        const { runner: throwing } = runnerFor({ requestTicket: async () => { throw new Error('ticket code broke'); } });
        const thrown = await failureOf(throwing.upload(invoice()));
        expect(thrown.reason).toBe('ticketRefused');
        expect((thrown.cause as Error).message).toBe('ticket code broke');
        expect(thrown.callFailure).toBeUndefined();
    });

    it('asks for the ticket again after a call that got no answer, a timeout or a 5xx, and never after a rejected input', async () => {
        const failures: LambderApiOutcome<never>[] = [unanswered('network'), unanswered('timeout'), unanswered('server')];
        let asked = 0;
        const endpoints = bucketEndpoints();
        const { runner } = runnerFor({
            endpoints,
            storageRetry: { attempts: 4, baseDelayMs: 1, maxDelayMs: 1 },
            requestTicket: async (fileFacts, call) => {
                asked++;
                return failures.shift() ?? await endpoints.requestTicket(fileFacts, call);
            },
        });

        expect(await runner.upload(invoice())).toEqual({ objectKey: 'stores/store-7/invoices/1.pdf' });
        expect(asked).toBe(4);
        expect(endpoints.calls.requestTicket).toBe(1);

        let invalidCalls = 0;
        const { runner: invalid } = runnerFor({
            requestTicket: async () => {
                invalidCalls++;
                return { ok: false, reason: 'validation', status: 422, zodError: { name: 'ZodError', message: 'storeId: Invalid UUID', issues: [] } };
            },
        });
        const rejected = await failureOf(invalid.upload(invoice()));
        expect(rejected.reason).toBe('ticketRefused');
        expect(rejected.callFailure?.reason).toBe('validation');
        expect(invalidCalls).toBe(1);
    });

    it('confirms the stored bytes again after a dropped call, with the same ticket, leaving no second object behind', async () => {
        const confirmedWith: IssuedTicket[] = [];
        let drops = 2;
        const endpoints = bucketEndpoints();
        const { runner } = runnerFor({
            endpoints,
            confirmUpload: async (issued, call) => {
                confirmedWith.push(issued);
                return drops-- > 0 ? unanswered('network') : await endpoints.confirmUpload(issued, call);
            },
        });

        expect(await runner.upload(invoice())).toEqual({ objectKey: 'stores/store-7/invoices/1.pdf' });
        expect(endpoints.calls.requestTicket).toBe(1);
        expect(confirmedWith).toHaveLength(3);
        expect(new Set(confirmedWith).size).toBe(1);
        expect(bucket.listObjectKeys()).toEqual(['stores/store-7/invoices/1.pdf']);
    });

    it('gives up as networkFailed once every attempt at a call has gone unanswered, with the last failure on the error', async () => {
        let confirms = 0;
        const { runner } = runnerFor({ confirmUpload: async () => { confirms++; return unanswered('server'); } });

        const failure = await failureOf(runner.upload(invoice()));
        expect(failure.reason).toBe('networkFailed');
        expect(failure.callFailure).toMatchObject({ reason: 'server', status: 503 });
        expect((failure.cause as Error).message).toBe('the call failed as server');
        expect(confirms).toBe(3);
    });

    it('gives each step every attempt: retries spent at storage do not shorten the confirm\'s', async () => {
        let posts = 0;
        const dropPost = () => {
            posts++;
            return msw.HttpResponse.error();
        };
        server.use(msw.http.post(bucket.baseUrl, dropPost, { once: true }), msw.http.post(bucket.baseUrl, dropPost, { once: true }));
        let drops = 2;
        const endpoints = bucketEndpoints();
        const { runner } = runnerFor({
            endpoints,
            confirmUpload: async (issued, call) => drops-- > 0 ? unanswered('timeout') : await endpoints.confirmUpload(issued, call),
        });

        // Three attempts a step: two failed posts and then two dropped confirms still upload.
        expect(await runner.upload(invoice())).toEqual({ objectKey: 'stores/store-7/invoices/1.pdf' });
        expect(posts).toBe(2);
        expect(endpoints.calls.confirmUpload).toBe(1);
    });

    it('stops during the wait before another try at a call', async () => {
        const controller = new AbortController();
        const { runner } = runnerFor({
            storageRetry: { attempts: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 },
            requestTicket: async () => {
                setTimeout(() => controller.abort(), 10);
                return unanswered('network');
            },
        });

        expect((await failureOf(runner.upload(invoice(), { signal: controller.signal }))).reason).toBe('aborted');
    });

    it('takes a caller\'s outcomes as they come, over a real server\'s ticket and confirm endpoints', async () => {
        const app = initLambder().create({ apiPath: '/api' });
        const factsById = new Map<string, LambderUploadFileFacts & { objectKey: string }>();
        let ticketCalls = 0;
        const shop = app.registerApiGroups(app.defineApiGroup('invoices', {
            requestUpload: app.defineApi({
                input: z.object({ storeId: z.string(), fileFacts: LambderUploadFileFactsSchema }),
                output: z.object({ ticket: LambderUploadTicketSchema, invoiceId: z.string() }),
            }, async ({ apiPayload }) => {
                ticketCalls++;
                if(apiPayload.storeId === 'store-closed') refuse('Uploads are closed for this store.');
                const invoiceId = `invoice-${ticketCalls}`;
                const objectKey = `stores/${apiPayload.storeId}/invoices/${invoiceId}.pdf`;
                const ticket = await bucket.issueUploadTicket({ objectKey, fileFacts: apiPayload.fileFacts, uploadRule: PDF_RULE });
                factsById.set(invoiceId, { ...apiPayload.fileFacts, objectKey });
                return { ticket, invoiceId };
            }),
            confirmUpload: app.defineApi({
                input: z.object({ invoiceId: z.string() }),
                output: z.object({ invoiceId: z.string(), fileName: z.string() }),
            }, async ({ apiPayload }) => {
                const stored = factsById.get(apiPayload.invoiceId);
                if(!stored) refuse('Invoice not found.');
                const verdict = await bucket.verifyUploadedObject({ objectKey: stored.objectKey, fileFacts: stored });
                if(!verdict.verified) refuse('The upload did not arrive.');
                return { invoiceId: apiPayload.invoiceId, fileName: stored.fileName };
            }),
        }));
        const caller = new LambderCaller<typeof shop.ApiContract>({ transport: lambderHandlerTransport(shop.getHandler()) });
        const runnerForStore = (storeId: string) => new LambderUploadRunner({
            uploadRule: PDF_RULE,
            requestTicket: (fileFacts, { signal }) => caller.invoices.requestUpload.outcome({ storeId, fileFacts }, { signal }),
            confirmUpload: ({ invoiceId }, { signal }) => caller.invoices.confirmUpload.outcome({ invoiceId }, { signal }),
        });

        const receipt = await runnerForStore('store-7').upload(invoice());
        expectTypeOf(receipt).toEqualTypeOf<{ invoiceId: string; fileName: string }>();
        expect(receipt).toEqual({ invoiceId: 'invoice-1', fileName: 'Invoice 1042.pdf' });
        expect(bucket.listObjectKeys()).toEqual(['stores/store-7/invoices/invoice-1.pdf']);

        const closed = await failureOf(runnerForStore('store-closed').upload(invoice()));
        expect(closed.reason).toBe('ticketRefused');
        expect(closed.callFailure?.refusal?.content).toBe('Uploads are closed for this store.');
    });
});


/**
 * The browser's path: an XMLHttpRequest stand-in that hands its post to the
 * memory bucket, reports the whole body as sent, and can be told to go silent
 * (the stall watch must end such a post) or to answer something else.
 */
class StandInXhr {
    static silentPosts = 0;
    static answer: ((request: Request) => Promise<Response>) | null = null;
    upload: { onprogress: ((event: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    responseText = '';
    private url = '';
    private aborted = false;

    open(_method: string, url: string){
        this.url = url;
    }

    send(body: FormData){
        if(StandInXhr.silentPosts > 0){
            StandInXhr.silentPosts--;
            return;
        }
        void (async () => {
            const request = new Request(this.url, { method: 'POST', body });
            const response = StandInXhr.answer ? await StandInXhr.answer(request) : (await bucket.handleStorageRequest(request))!;
            if(this.aborted) return;
            // More than the file: the form's own framing counts too.
            this.upload.onprogress?.({ loaded: Number.MAX_SAFE_INTEGER });
            this.status = response.status;
            this.responseText = await response.text();
            this.onload?.();
        })();
    }

    abort(){
        this.aborted = true;
        this.onabort?.();
    }
}

describe('LambderUploadRunner over XMLHttpRequest', () => {
    afterEach(() => {
        StandInXhr.silentPosts = 0;
        StandInXhr.answer = null;
    });

    it('reports the bytes sent, never more than the file, and stores it', async () => {
        vi.stubGlobal('XMLHttpRequest', StandInXhr);
        const { runner } = runnerFor();
        const sent: number[] = [];
        const file = invoice();

        expect(await runner.upload(file, { onProgress: ({ phase, sentBytes }) => { if(phase === 'uploading') sent.push(sentBytes); } })).toEqual({ objectKey: 'stores/store-7/invoices/1.pdf' });
        expect(sent.at(-1)).toBe(file.size);
        expect(bucket.listObjectKeys()).toEqual(['stores/store-7/invoices/1.pdf']);
    });

    it('ends a post that moves nothing for the stall limit, and tries again with the same ticket', async () => {
        vi.stubGlobal('XMLHttpRequest', StandInXhr);
        StandInXhr.silentPosts = 1;
        const { runner, calls } = runnerFor({ stallTimeoutMs: 20 });

        expect(await runner.upload(invoice())).toEqual({ objectKey: 'stores/store-7/invoices/1.pdf' });
        expect(calls.requestTicket).toBe(1);
    });

    it('settles on a refusal it cannot fully decode rather than waiting for ever', async () => {
        vi.stubGlobal('XMLHttpRequest', StandInXhr);
        StandInXhr.answer = async () => new Response('<Error><Code>Bad&#x110000;</Code><Message>no</Message></Error>', { status: 400 });
        const { runner } = runnerFor();

        const failure = await failureOf(runner.upload(invoice()));
        expect(failure.reason).toBe('storageRejected');
        expect(failure.message).toBe('storageRejected: Bad&#x110000;: no');
    });
});

describe('LambderMemoryUploadBucket', () => {
    it('reads an object back through a download link until the link expires', async () => {
        await bucket.writeObject({ objectKey: 'stores/store-7/receipts/r 1.pdf', body: new TextEncoder().encode('%PDF receipt'), mimeType: 'application/pdf' });
        const url = await bucket.issueDownloadUrl({ objectKey: 'stores/store-7/receipts/r 1.pdf', lifetimeSeconds: 60 });
        expect(url.startsWith(`${bucket.baseUrl}stores/store-7/receipts/r%201.pdf?`)).toBe(true);

        const response = await fetch(url);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('application/pdf');
        expect(await response.text()).toBe('%PDF receipt');

        clock += 61_000;
        const expired = await fetch(url);
        expect(expired.status).toBe(403);
        expect(await expired.text()).toContain('<Code>AccessDenied</Code><Message>Request has expired</Message>');
    });

    it('refuses a post that carries no ticket it issued, as S3 refuses one outside its policy', async () => {
        const form = new FormData();
        form.append('key', 'stores/store-7/invoices/forged.pdf');
        form.append('file', invoice());

        const response = await fetch(bucket.baseUrl, { method: 'POST', body: form });

        expect(response.status).toBe(403);
        expect(await response.text()).toContain('<Code>AccessDenied</Code>');
        expect(bucket.listObjectKeys()).toEqual([]);
    });

    it('verifies what it holds against the facts, and says what is wrong', async () => {
        const body = new TextEncoder().encode('%PDF invoice');
        const sha256Base64 = await sha256Base64Of(body);
        await bucket.writeObject({ objectKey: 'a.pdf', body, mimeType: 'application/pdf', sha256Base64 });

        await expect(bucket.verifyUploadedObject({ objectKey: 'a.pdf', fileFacts: { byteSize: body.byteLength, sha256Base64 } })).resolves.toEqual({ verified: true });
        await expect(bucket.verifyUploadedObject({ objectKey: 'a.pdf', fileFacts: { byteSize: body.byteLength + 1, sha256Base64 } })).resolves.toEqual({ verified: false, reason: 'factsMismatch' });
        await expect(bucket.verifyUploadedObject({ objectKey: 'b.pdf', fileFacts: { byteSize: body.byteLength, sha256Base64 } })).resolves.toEqual({ verified: false, reason: 'objectMissing' });
    });

    it('refuses a write whose checksum is not the body\'s, copies, deletes, and forgets everything on reset', async () => {
        const body = new TextEncoder().encode('%PDF invoice');
        await expect(bucket.writeObject({ objectKey: 'a.pdf', body, mimeType: 'application/pdf', sha256Base64: await sha256Base64Of(new TextEncoder().encode('other')) })).rejects.toThrow(/not the body's/);

        await bucket.writeObject({ objectKey: 'a.pdf', body, mimeType: 'application/pdf' });
        await bucket.copyObject({ fromObjectKey: 'a.pdf', toObjectKey: 'b.pdf' });
        await bucket.deleteObject('a.pdf');
        await bucket.deleteObject('never-written.pdf');
        expect(bucket.listObjectKeys()).toEqual(['b.pdf']);
        await expect(bucket.readObject('a.pdf')).rejects.toThrow(/nothing is stored under a\.pdf/);

        bucket.reset();
        expect(bucket.listObjectKeys()).toEqual([]);
    });

    it('holds a post to S3\'s form rules: every ticket field, no other, all before the file', async () => {
        const file = invoice();
        const facts: LambderUploadFileFacts = { fileName: file.name, mimeType: file.type, byteSize: file.size, sha256Base64: await sha256Base64Of(new Uint8Array(await file.arrayBuffer())) };
        const ticket = await bucket.issueUploadTicket({ objectKey: 'stores/store-7/invoices/strict.pdf', fileFacts: facts, uploadRule: PDF_RULE });
        const post = async (build: (form: FormData) => void) => {
            const form = new FormData();
            build(form);
            const response = await fetch(ticket.uploadUrl, { method: 'POST', body: form });
            return { status: response.status, text: await response.text() };
        };
        const withFields = (form: FormData) => { for(const [name, value] of Object.entries(formFieldsOf(ticket))) form.append(name, value); };

        const extra = await post((form) => { withFields(form); form.append('acl', 'public-read'); form.append('file', file); });
        expect(extra.status).toBe(403);
        expect(extra.text).toContain('Extra input fields: acl');

        // A field after the file is not read, as S3 reads none: the pinned checksum is then missing.
        const late = await post((form) => {
            for(const [name, value] of Object.entries(formFieldsOf(ticket))) if(name !== 'x-amz-checksum-sha256') form.append(name, value);
            form.append('file', file);
            form.append('x-amz-checksum-sha256', facts.sha256Base64);
        });
        expect(late.status).toBe(403);
        expect(bucket.listObjectKeys()).toEqual([]);

        expect((await post((form) => { withFields(form); form.append('file', file); })).status).toBe(204);
        expect(bucket.listObjectKeys()).toEqual(['stores/store-7/invoices/strict.pdf']);
    });

    it('will not sign a key holding ${filename}, keeps a link for a key with a leading slash under its base, and answers a malformed path', async () => {
        const facts: LambderUploadFileFacts = { fileName: 'a.pdf', mimeType: 'application/pdf', byteSize: 3, sha256Base64: await sha256Base64Of(new Uint8Array([1, 2, 3])) };
        await expect(bucket.issueUploadTicket({ objectKey: 'stores/${filename}', fileFacts: facts, uploadRule: PDF_RULE })).rejects.toThrow(/may not hold/);

        await bucket.writeObject({ objectKey: '/receipts/7.pdf', body: new TextEncoder().encode('%PDF'), mimeType: 'application/pdf' });
        const url = await bucket.issueDownloadUrl({ objectKey: '/receipts/7.pdf' });
        expect(url.startsWith(bucket.baseUrl)).toBe(true);
        expect(await (await fetch(url)).text()).toBe('%PDF');

        // Asked directly: MSW's own URL matching throws on such a path before any handler runs.
        const malformed = await bucket.handleStorageRequest(new Request(`${bucket.baseUrl}receipts/%E0%A4%A.pdf`));
        expect(malformed?.status).toBe(400);
        expect(await malformed?.text()).toContain('<Code>InvalidURI</Code>');
    });

    it('keeps what a ticket said the object carries, and answers a link with its headers, the link\'s disposition first', async () => {
        const file = invoice();
        const { runner } = runnerFor({
            requestTicket: async (fileFacts) => {
                const objectKey = 'stores/store-7/invoices/tagged.pdf';
                const ticket = await bucket.issueUploadTicket({
                    objectKey, fileFacts, uploadRule: PDF_RULE,
                    object: { tags: { retention: '30d' }, metadata: { invoice: '1042' }, cacheControl: 'private, max-age=60', contentDisposition: { disposition: 'inline', fileName: 'Invoice 1042.pdf' } },
                });
                return answered({ ticket, objectKey });
            },
            confirmUpload: async ({ objectKey }) => answered({ objectKey }),
        });
        await runner.upload(file);

        expect(bucket.inspectObject('stores/store-7/invoices/tagged.pdf')).toEqual({
            byteSize: file.size, mimeType: 'application/pdf', sha256Base64: await sha256Base64Of(new Uint8Array(await file.arrayBuffer())),
            tags: { retention: '30d' }, metadata: { invoice: '1042' }, cacheControl: 'private, max-age=60',
            contentDisposition: { disposition: 'inline', fileName: 'Invoice 1042.pdf' },
        });
        const asStored = await fetch(await bucket.issueDownloadUrl({ objectKey: 'stores/store-7/invoices/tagged.pdf' }));
        expect(asStored.headers.get('cache-control')).toBe('private, max-age=60');
        expect(asStored.headers.get('content-disposition')).toBe('inline; filename="Invoice 1042.pdf"; filename*=UTF-8\'\'Invoice%201042.pdf');
        const saved = await fetch(await bucket.issueDownloadUrl({ objectKey: 'stores/store-7/invoices/tagged.pdf', contentDisposition: { disposition: 'attachment' } }));
        expect(saved.headers.get('content-disposition')).toBe('attachment');
        expect(bucket.inspectObject('stores/store-7/invoices/missing.pdf')).toBeNull();
    });

    it('expires a ticket by its own lifetime, and a link by the bucket\'s', async () => {
        const shortLived = new LambderMemoryUploadBucket({ now: () => clock, downloadLifetimeSeconds: 30 });
        const file = invoice();
        const facts: LambderUploadFileFacts = { fileName: file.name, mimeType: file.type, byteSize: file.size, sha256Base64: await sha256Base64Of(new Uint8Array(await file.arrayBuffer())) };
        const ticket = await shortLived.issueUploadTicket({ objectKey: 'a.pdf', fileFacts: facts, uploadRule: PDF_RULE, lifetimeSeconds: 5 });
        expect(ticket.expiresAt).toBe(clock + 5_000);

        clock += 6_000;
        const form = new FormData();
        for(const [name, value] of Object.entries(formFieldsOf(ticket))) form.append(name, value);
        form.append('file', file);
        const late = await shortLived.handleStorageRequest(new Request(shortLived.baseUrl, { method: 'POST', body: form }));
        expect(late?.status).toBe(403);
        expect(await late?.text()).toContain('Policy expired');

        await shortLived.writeObject({ objectKey: 'a.pdf', body: new Uint8Array([1]), mimeType: 'application/pdf' });
        const link = await shortLived.issueDownloadUrl({ objectKey: 'a.pdf' });
        clock += 31_000;
        expect((await shortLived.handleStorageRequest(new Request(link)))?.status).toBe(403);
    });

    it('answers only for its own base URL, leaving any other request to the caller', async () => {
        expect(await bucket.handleStorageRequest(new Request('https://elsewhere.invalid/a.pdf'))).toBeNull();
        expect(new LambderMemoryUploadBucket({ baseUrl: 'https://uploads.example.invalid/shop' }).baseUrl).toBe('https://uploads.example.invalid/shop/');
    });
});

describe('LambderUploadRunner over a bucket that signs PUT tickets', () => {
    /** A runner over the PUT bucket, its endpoints as the POST one's. */
    const putRunner = (object?: Parameters<LambderMemoryUploadBucket['issueUploadTicket']>[0]['object']) => new LambderUploadRunner<IssuedTicket, { objectKey: string }>({
        uploadRule: PDF_RULE,
        requestTicket: async (fileFacts) => {
            const objectKey = 'stores/store-7/invoices/put.pdf';
            const ticket = LambderUploadTicketSchema.parse(await putBucket.issueUploadTicket({ objectKey, fileFacts, uploadRule: PDF_RULE, object }));
            return answered({ ticket, objectKey });
        },
        confirmUpload: async ({ objectKey }) => answered({ objectKey }),
    });

    it('puts the bytes under the ticket\'s URL with its headers, and keeps what the object carries', async () => {
        const file = invoice();
        const receipt = await putRunner({ metadata: { invoice: '1042' }, cacheControl: 'private, max-age=60', contentDisposition: { disposition: 'inline' } }).upload(file);

        expect(receipt).toEqual({ objectKey: 'stores/store-7/invoices/put.pdf' });
        expect(putBucket.inspectObject('stores/store-7/invoices/put.pdf')).toEqual({
            byteSize: file.size, mimeType: 'application/pdf', sha256Base64: (await factsOf(file)).sha256Base64,
            metadata: { invoice: '1042' }, cacheControl: 'private, max-age=60', contentDisposition: { disposition: 'inline' },
        });
    });

    it('signs a PUT ticket for the object\'s key, with the headers that pin the file', async () => {
        const facts = await factsOf(invoice());
        const ticket = await putBucket.issueUploadTicket({
            objectKey: 'stores/store-7/invoices/7.pdf', fileFacts: facts, uploadRule: PDF_RULE,
            object: { tags: { retention: '30d' }, metadata: { Invoice: '7' } },
        });

        expect(ticket.method).toBe('PUT');
        expect(ticket.uploadUrl.startsWith(`${putBucket.baseUrl}stores/store-7/invoices/7.pdf?`)).toBe(true);
        expect(headersOf(ticket)).toEqual({
            'content-type': 'application/pdf',
            'x-amz-checksum-sha256': facts.sha256Base64,
            'x-amz-tagging': 'retention=30d',
            'x-amz-meta-invoice': '7',
        });
    });

    it('is refused by storage when the bytes are not the ones the ticket was signed for', async () => {
        const other = await sha256Base64Of(new TextEncoder().encode('another file'));
        const runner = new LambderUploadRunner<IssuedTicket, string>({
            uploadRule: PDF_RULE,
            requestTicket: async (fileFacts) => {
                const ticket = await putBucket.issueUploadTicket({ objectKey: 'a.pdf', fileFacts: { ...fileFacts, sha256Base64: other }, uploadRule: PDF_RULE });
                return answered({ ticket, objectKey: 'a.pdf' });
            },
            confirmUpload: async ({ objectKey }) => answered(objectKey),
        });

        const failure = await failureOf(runner.upload(invoice()));

        expect(failure.message).toBe('storageRejected: BadDigest: The SHA256 you specified did not match the calculated checksum.');
        expect(putBucket.listObjectKeys()).toEqual([]);
    });

    it('asks for a new ticket when storage says the URL expired', async () => {
        let issued = 0;
        const runner = new LambderUploadRunner<IssuedTicket, string>({
            uploadRule: PDF_RULE,
            requestTicket: async (fileFacts) => {
                issued++;
                const ticket = await putBucket.issueUploadTicket({ objectKey: `renewed-${issued}.pdf`, fileFacts, uploadRule: PDF_RULE });
                if(issued === 1) clock += 601_000;
                return answered({ ticket, objectKey: `renewed-${issued}.pdf` });
            },
            confirmUpload: async ({ objectKey }) => answered(objectKey),
        });

        expect(await runner.upload(invoice())).toBe('renewed-2.pdf');
        expect(putBucket.listObjectKeys()).toEqual(['renewed-2.pdf']);
    });

    it('holds a PUT to a presigned URL\'s rules: the signed headers as signed, no unsigned x-amz- header, the signed length', async () => {
        const file = invoice();
        const ticket = await putBucket.issueUploadTicket({ objectKey: 'strict.pdf', fileFacts: await factsOf(file), uploadRule: PDF_RULE });
        const put = async (headers: Record<string, string>, body: BodyInit = file, url = ticket.uploadUrl) => {
            const response = await fetch(url, { method: 'PUT', headers, body });
            return { status: response.status, text: await response.text() };
        };
        const signed = headersOf(ticket);

        const retyped = await put({ ...signed, 'content-type': 'text/plain' });
        expect(retyped.status).toBe(403);
        expect(retyped.text).toContain('<Code>SignatureDoesNotMatch</Code>');

        const unsigned = await put({ ...signed, 'x-amz-acl': 'public-read' });
        expect(unsigned.status).toBe(403);
        expect(unsigned.text).toContain('not signed: x-amz-acl');

        const longer = await put(signed, new Blob([file, 'x']));
        expect(longer.status).toBe(403);
        expect(longer.text).toContain('<Code>SignatureDoesNotMatch</Code>');

        const elsewhere = await put(signed, file, ticket.uploadUrl.replace('strict.pdf', 'other.pdf'));
        expect(elsewhere.status).toBe(403);
        expect(putBucket.listObjectKeys()).toEqual([]);

        expect((await put(signed)).status).toBe(200);
        expect(putBucket.listObjectKeys()).toEqual(['strict.pdf']);
    });
});
