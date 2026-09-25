/**
 * What reaches each gateway, and what a request looks like coming from one.
 *
 * A REST API (payload v1) decodes a base64 body only for its
 * binaryMediaTypes, so text has to leave as text there and compression is on
 * only when the app names it. The gateways also disagree on the path: a REST
 * API and a Function URL deliver it percent-encoded and an HTTP API decoded
 * (in payload format 1.0 as in 2.0), and ctx.path has to be one spelling
 * whichever sent it.
 */

import { describe, it, expect } from 'vitest';
import Lambder from '../src/core/Lambder.js';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import type { LambderResponse } from '../src/core/LambderResponse.js';
import type { LambderFileSource } from '../src/shared/contracts/LambderFileSource.js';
import { brotliBody, createMockContext, createMockEvent, createMockEventV2, decodeBody, testPublicFiles } from './helpers.js';

const bigHtml = '<p>' + 'lambder '.repeat(500) + '</p>';
const accepting = { Host: 'localhost', 'Accept-Encoding': 'br, gzip' };

describe('Compression per event format', () => {
    const app = (options: ConstructorParameters<typeof Lambder>[0] = {}) =>
        new Lambder({ files: testPublicFiles(), ...options }).addRoute('/big', (ctx, res) => res.html(bigHtml));

    it('leaves a REST API answer uncompressed and as text unless compression is named', async () => {
        const result = await app().render(createMockEvent('/big', { headers: accepting }), createMockContext());

        expect(result.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
        expect(result.isBase64Encoded).toBe(false);
        expect(result.body).toBe(bigHtml);
    });

    it('compresses on a REST API once the app names compression', async () => {
        const result = await app({ compression: true }).render(createMockEvent('/big', { headers: accepting }), createMockContext());

        expect(result.multiValueHeaders?.['Content-Encoding']).toEqual(['br']);
        expect(brotliBody(result)).toBe(bigHtml);
    });

    it('compresses on an HTTP API or Function URL by default', async () => {
        const result = await app().render(
            createMockEventV2('/big', { headers: { host: 'localhost', 'accept-encoding': 'br, gzip' } }),
            createMockContext(),
        );

        expect(result.headers?.['Content-Encoding']).toBe('br');
        expect(brotliBody(result)).toBe(bigHtml);
    });
});

describe('Text leaves as text, bytes as base64', () => {
    const files = new Map<string, { body: Buffer, mimeType?: string }>([
        ['app.css', { body: Buffer.from('body { content: "ü"; }') }],
        ['logo.png', { body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]) }],
        ['legacy.txt', { body: Buffer.from([0x63, 0x61, 0x66, 0xe9]) }], // "café" in Latin-1: not UTF-8
    ]);
    const source: LambderFileSource = { read: async (relativePath) => files.get(relativePath) ?? null };
    const serve = async (requestPath: string) =>
        await new Lambder({ files: source }).servePublicFiles().render(createMockEvent(requestPath), createMockContext());

    it('sends a served text file as UTF-8 text, which a REST API passes through as it is', async () => {
        const css = await serve('/app.css');
        expect(css.isBase64Encoded).toBe(false);
        expect(css.body).toBe('body { content: "ü"; }');
    });

    it('sends binary files, and text that is not UTF-8, as base64', async () => {
        const png = await serve('/logo.png');
        expect(png.isBase64Encoded).toBe(true);
        expect(Buffer.from(png.body, 'base64')).toEqual(files.get('logo.png')!.body);

        const legacy = await serve('/legacy.txt');
        expect(legacy.isBase64Encoded).toBe(true);
        expect(Buffer.from(legacy.body, 'base64')).toEqual(files.get('legacy.txt')!.body);
    });
});

describe('ETag before compression', () => {
    const app = () => new Lambder({ files: testPublicFiles(), compression: true }).addRoute('/big', (ctx, res) => res.html(bigHtml));

    it('tags each representation apart, and answers a revalidation of the compressed one with a 304', async () => {
        const identity = await app().render(createMockEvent('/big'), createMockContext());
        const compressed = await app().render(createMockEvent('/big', { headers: accepting }), createMockContext());
        const identityTag = identity.multiValueHeaders?.['ETag']?.[0];
        const compressedTag = compressed.multiValueHeaders?.['ETag']?.[0];
        expect(identityTag).toMatch(/^"[0-9a-f]{32}"$/);
        expect(compressedTag).toBe(identityTag!.replace(/"$/, '-br"'));

        const revalidated = await app().render(
            createMockEvent('/big', { headers: { ...accepting, 'If-None-Match': compressedTag! } }),
            createMockContext(),
        );
        expect(revalidated.statusCode).toBe(304);
        expect(revalidated.body).toBe('');
        expect(revalidated.multiValueHeaders?.['Content-Encoding']).toBeUndefined();

        // The identity tag does not stand for the compressed bytes.
        const mismatched = await app().render(
            createMockEvent('/big', { headers: { ...accepting, 'If-None-Match': identityTag! } }),
            createMockContext(),
        );
        expect(mismatched.statusCode).toBe(200);
    });

    it('gives a cached file the same tag on every request', async () => {
        const source: LambderFileSource = { read: async () => ({ body: Buffer.from(bigHtml) }) };
        const lambder = new Lambder({ files: source }).servePublicFiles();
        const first = await lambder.render(createMockEvent('/page.html'), createMockContext());
        const second = await lambder.render(createMockEvent('/page.html'), createMockContext());
        expect(first.multiValueHeaders?.['ETag']).toEqual(second.multiValueHeaders?.['ETag']);
    });
});

describe('A response object kept between requests', () => {
    it('carries only its own caller\'s cookies and headers', async () => {
        let kept: LambderResponse | null = null;
        const lambder = new Lambder({ files: testPublicFiles(), compression: true })
            .addRoute('/kept', (ctx, res) => {
                res.setCookie('visitor', ctx.get.name ?? '');
                kept ??= res.html(bigHtml);
                return kept;
            });

        await lambder.render(createMockEvent('/kept', { queryStringParameters: { name: 'first' }, headers: accepting }), createMockContext());
        const second = await lambder.render(createMockEvent('/kept', { queryStringParameters: { name: 'second' } }), createMockContext());

        const cookies = second.multiValueHeaders?.['Set-Cookie'] ?? [];
        expect(cookies).toHaveLength(1);
        expect(cookies[0]).toMatch(/^visitor=second/);
        // Nor the first caller's Content-Encoding: this one accepted none.
        expect(second.multiValueHeaders?.['Content-Encoding']).toBeUndefined();
        expect(decodeBody(second)).toBe(bigHtml);
        expect(kept!.headers['Set-Cookie']).toBeUndefined();
    });
});

/**
 * An HTTP API's payload format 1.0 event: a REST API's shape plus the
 * `version: "1.0"` a REST API never sends, its path decoded by the gateway
 * and a named stage kept at its front.
 */
const createHttpApiV1Event = (path: string, stage = '$default'): APIGatewayProxyEvent => ({
    ...createMockEvent(path, { requestContext: { stage, identity: { sourceIp: '9.9.9.9' } } as APIGatewayProxyEvent['requestContext'] }),
    version: '1.0',
} as APIGatewayProxyEvent);

describe('ctx.path, whichever gateway delivered it', () => {
    const seen: Array<{ path: string, rawPath: string, params: Record<string, string> }> = [];
    const app = () => new Lambder({ files: testPublicFiles() })
        .addRoute('/hakkımızda', (ctx, res) => res.text('about'))
        .addRoute('/files/:name', (ctx, res) => {
            seen.push({ path: ctx.path, rawPath: ctx.rawPath, params: ctx.pathParams });
            return res.text(ctx.pathParams.name ?? '');
        });

    it('finds a route with non-ASCII characters on an encoding gateway and a decoding one', async () => {
        const rest = await app().render(createMockEvent('/hakk%C4%B1m%C4%B1zda'), createMockContext());
        const httpApi = await app().render(createMockEventV2('/hakkımızda'), createMockContext());
        const httpApiV1 = await app().render(createHttpApiV1Event('/hakkımızda'), createMockContext());
        expect(decodeBody(rest)).toBe('about');
        expect(decodeBody(httpApi)).toBe('about');
        expect(decodeBody(httpApiV1)).toBe('about');
    });

    it('keeps an encoded slash out of the separators, and hands it to a param as a slash', async () => {
        seen.length = 0;
        const result = await app().render(createMockEvent('/files/reports%2F2026%20q1.pdf'), createMockContext());
        expect(decodeBody(result)).toBe('reports/2026 q1.pdf');
        expect(seen[0]).toEqual({
            path: '/files/reports%2F2026 q1.pdf',
            rawPath: '/files/reports%2F2026%20q1.pdf',
            params: { name: 'reports/2026 q1.pdf' },
        });
    });

    it('hands a param its "#" and "?", which a decoded path carries as text', async () => {
        const result = await app().render(createMockEvent('/files/C%23'), createMockContext());
        expect(decodeBody(result)).toBe('C#');
        const asked = await app().render(createMockEventV2('/files/what?'), createMockContext());
        expect(decodeBody(asked)).toBe('what?');
        const askedV1 = await app().render(createHttpApiV1Event('/files/what?'), createMockContext());
        expect(decodeBody(askedV1)).toBe('what?');
    });

    it('reads a segment whose escapes do not decode as the text it arrived as', async () => {
        seen.length = 0;
        await app().render(createMockEvent('/files/100%'), createMockContext());
        await app().render(createMockEvent('/files/%E0%A4%A'), createMockContext());
        expect(seen.map((entry) => entry.path)).toEqual(['/files/100%25', '/files/%25E0%25A4%25A']);
        expect(seen.map((entry) => entry.params.name)).toEqual(['100%', '%E0%A4%A']);
    });

    it('decodes a path once, so an escape inside it stays text, on every gateway', async () => {
        const guarded = () => new Lambder({ files: testPublicFiles() })
            .addRoute('/admin', (ctx, res) => res.text('admin'))
            .setRouteFallbackHandler((ctx, res) => res.text(`other:${ctx.path}`, { statusCode: 404 }));
        // The viewer asked for /%2561dmin: a REST API and a Function URL
        // deliver it as sent, an HTTP API decoded once, as /%61dmin, in either
        // payload format. Decoded again it would be /admin, past an authorizer
        // or a WAF rule that checked the path once.
        const rest = await guarded().render(createMockEvent('/%2561dmin'), createMockContext());
        const httpApi = await guarded().render(createMockEventV2('/%61dmin'), createMockContext());
        const httpApiV1 = await guarded().render(createHttpApiV1Event('/%61dmin'), createMockContext());
        const functionUrlEvent = createMockEventV2('/%2561dmin');
        functionUrlEvent.requestContext.domainName = 'abc123xyz.lambda-url.eu-central-1.on.aws';
        const functionUrl = await guarded().render(functionUrlEvent, createMockContext());
        for (const result of [rest, httpApi, httpApiV1, functionUrl]) {
            expect(result.statusCode).toBe(404);
            expect(decodeBody(result)).toBe('other:/%2561dmin');
        }
    });

    it('reads an HTTP API\'s payload format 1.0 path as decoded, and drops a named stage from its front', async () => {
        // Regression: a v1-shaped event was always read as a REST API's, so
        // an HTTP API sending payload format 1.0 had its decoded path decoded
        // again (the double decode above), and a named stage, which an HTTP
        // API keeps in the path, made every route miss.
        seen.length = 0;
        const staged = await app().render(createHttpApiV1Event('/prod/files/q1 report%.pdf', 'prod'), createMockContext());
        expect(decodeBody(staged)).toBe('q1 report%.pdf');
        expect(seen[0]).toEqual({ path: '/files/q1 report%25.pdf', rawPath: '/files/q1 report%.pdf', params: { name: 'q1 report%.pdf' } });

        // A REST API strips the stage itself and sends no version: its path
        // is read as sent, stage-named first segment included.
        seen.length = 0;
        const rest = createMockEvent('/prod/files/a%20b', { requestContext: { stage: 'prod' } as APIGatewayProxyEvent['requestContext'] });
        expect((await app().render(rest, createMockContext())).statusCode).toBe(404);
        expect(seen).toEqual([]);
    });

    it('decodes a Function URL\'s path, which arrives as the viewer sent it', async () => {
        const functionUrl = createMockEventV2('/hakk%C4%B1m%C4%B1zda');
        functionUrl.requestContext.domainName = 'abc123xyz.lambda-url.eu-central-1.on.aws';
        expect(decodeBody(await app().render(functionUrl, createMockContext()))).toBe('about');
    });

    it('keeps an escaped escape apart from an encoded slash', async () => {
        seen.length = 0;
        // %252F is the text "%2F", not a slash inside the segment.
        await app().render(createMockEvent('/files/a%252Fb'), createMockContext());
        expect(seen[0]).toMatchObject({ path: '/files/a%252Fb', params: { name: 'a%2Fb' } });
    });

    it('hands a RegExp route its captures with the kept escapes turned back', async () => {
        const captured: Array<Record<string, string>> = [];
        const regexApp = new Lambder({ files: testPublicFiles() })
            .addRoute(/^\/docs\/(?<name>[^/]+)$/, (ctx, res) => { captured.push(ctx.pathParams); return res.text('ok'); });
        await regexApp.render(createMockEvent('/docs/q1%2Freport%2525'), createMockContext());
        expect(captured).toEqual([{ name: 'q1/report%25' }]);
    });
});

describe('redirectTrailingSlash', () => {
    const app = () => new Lambder({ files: testPublicFiles() })
        .serveIndexHtml((ctx, res) => res.text('shell'), { redirectTrailingSlash: true });

    it('percent-encodes the Location, so a TAB a browser drops cannot make it another host', async () => {
        for (const requestPath of ['/%09/evil.example/', '/%0A/evil.example/']) {
            const result = await app().render(createMockEvent(requestPath), createMockContext());
            expect(result.statusCode).toBe(301);
            expect(result.multiValueHeaders?.['Location']?.[0]).toBe(`${requestPath.slice(0, -1)}`);
        }
    });

    it('redirects a non-ASCII path to its encoded canonical form', async () => {
        const result = await app().render(createMockEvent('/hakk%C4%B1m%C4%B1zda/'), createMockContext());
        expect(result.multiValueHeaders?.['Location']?.[0]).toBe('/hakk%C4%B1m%C4%B1zda');
    });

    it('redirects a path with an escaped escape to that same path', async () => {
        const result = await app().render(createMockEvent('/%2541/'), createMockContext());
        expect(result.multiValueHeaders?.['Location']?.[0]).toBe('/%2541');
    });
});

describe('res.redirect()', () => {
    it('percent-encodes what a Location cannot carry, so a path built from ctx.path stays on this host', async () => {
        const app = new Lambder({ files: testPublicFiles() })
            .addRoute('/go/:rest*', (ctx, res) => res.redirect(ctx.path.slice('/go'.length).toLowerCase()));
        const tab = await app.render(createMockEvent('/go/%09/EVIL.example'), createMockContext());
        expect(tab.multiValueHeaders?.['Location']?.[0]).toBe('/%09/evil.example');
        const lineBreak = await app.render(createMockEvent('/go/x%0D%0ASet-Cookie:%20a=1'), createMockContext());
        expect(lineBreak.multiValueHeaders?.['Location']?.[0]).toBe('/x%0D%0Aset-cookie:%20a=1');
        expect(lineBreak.multiValueHeaders?.['Set-Cookie']).toBeUndefined();
    });

    it('leaves an encoded URL as it was written', async () => {
        const app = new Lambder({ files: testPublicFiles() })
            .addRoute('/out', (ctx, res) => res.redirect('https://example.com/a%20b?q=1&r=%2F#top'));
        const result = await app.render(createMockEvent('/out'), createMockContext());
        expect(result.multiValueHeaders?.['Location']?.[0]).toBe('https://example.com/a%20b?q=1&r=%2F#top');
    });
});
