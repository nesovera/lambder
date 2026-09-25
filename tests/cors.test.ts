/**
 * CORS configuration: preflight, credentialed origins, allowlists.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { initLambder } from '../src/core/Lambder.js';
import { createMockEvent, createMockContext, testPublicFiles } from './helpers.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('CORS', () => {
    it('answers preflight with configured origins', async () => {
        const lambder = initLambder().create({ files: testPublicFiles(), cors: { origins: ['https://app.example.com'], credentials: true } });

        const result = await lambder.render(
            createMockEvent('/api', { httpMethod: 'OPTIONS', headers: { Host: 'localhost', Origin: 'https://app.example.com' } }),
            createMockContext(),
        );
        expect(result.statusCode).toBe(204);
        expect(result.multiValueHeaders?.['Access-Control-Allow-Origin']).toEqual(['https://app.example.com']);
        expect(result.multiValueHeaders?.['Access-Control-Allow-Credentials']).toEqual(['true']);
        expect(result.multiValueHeaders?.['Access-Control-Allow-Methods']?.[0]).toContain('POST');
    });

    /**
     * A preflight gets its CORS headers once, as a preflight. Applying them
     * again as an ordinary answer would duplicate Vary and add an
     * Access-Control-Expose-Headers that means nothing before a request.
     */
    it('applies CORS once to a preflight', async () => {
        const lambder = initLambder().create({ files: testPublicFiles(), cors: { origins: ['https://app.example.com'], credentials: true } });

        const result = await lambder.render(
            createMockEvent('/api', { httpMethod: 'OPTIONS', headers: { Host: 'localhost', Origin: 'https://app.example.com' } }),
            createMockContext(),
        );
        expect(result.multiValueHeaders?.['Vary']).toEqual(['Origin']);
        expect(result.multiValueHeaders?.['Access-Control-Expose-Headers']).toBeUndefined();
        expect(result.multiValueHeaders?.['Access-Control-Allow-Origin']).toEqual(['https://app.example.com']);
    });

    it('refuses credentials with every origin allowed, which would let any website read signed-in answers', () => {
        expect(() => initLambder().create({ files: testPublicFiles(), cors: { credentials: true } }))
            .toThrow(/cors.credentials needs cors.origins to be an allowlist or a predicate/);
        expect(() => initLambder().create({ files: testPublicFiles(), cors: { credentials: true, origins: '*' } }))
            .toThrow(/allowlist or a predicate/);
        expect(() => initLambder().create({ files: testPublicFiles(), cors: { credentials: true, origins: ['https://app.example.com'] } }))
            .not.toThrow();
    });

    it('varies by Origin under an allowlist even when the Origin was refused or absent, so a cache cannot serve one to the other', async () => {
        const lambder = initLambder().create({ files: testPublicFiles(), cors: { origins: ['https://app.example.com'] } })
            .addRoute('/data', (ctx, res) => res.json({ ok: true }));
        const headersFor = async (origin?: string) => (await lambder.render(
            createMockEvent('/data', { headers: { Host: 'localhost', ...(origin ? { Origin: origin } : {}) } }),
            createMockContext(),
        )).multiValueHeaders ?? {};

        expect((await headersFor('https://evil.example'))['Vary']).toEqual(['Origin']);
        expect((await headersFor())['Vary']).toEqual(['Origin']);
        expect((await headersFor('https://evil.example'))['Access-Control-Allow-Origin']).toBeUndefined();
        expect((await headersFor('https://app.example.com'))['Vary']).toEqual(['Origin']);

        // Everyone allowed: the answer is the same for every Origin, so no Vary.
        const open = await initLambder().create({ files: testPublicFiles(), cors: true })
            .addRoute('/data', (ctx, res) => res.json({ ok: true }))
            .render(createMockEvent('/data', { headers: { Host: 'localhost', Origin: 'https://site.example' } }), createMockContext());
        expect(open.multiValueHeaders?.['Vary']).toBeUndefined();
    });

    it('exposes Retry-After to cross-origin callers by default, or the configured list', async () => {
        const call = async (cors: any) => (await initLambder().create({ files: testPublicFiles(), cors })
            .addRoute('/data', (ctx, res) => res.json({ ok: true }))
            .render(createMockEvent('/data', { headers: { Host: 'localhost', Origin: 'https://site.example' } }), createMockContext()))
            .multiValueHeaders?.['Access-Control-Expose-Headers'];
        expect(await call(true)).toEqual(['Retry-After']);
        expect(await call({ exposeHeaders: ['Retry-After', 'X-Request-Id'] })).toEqual(['Retry-After, X-Request-Id']);
        expect(await call({ exposeHeaders: [] })).toBeUndefined();
    });

    /**
     * The predicate form is the one an app reaches for when the allowlist is
     * a pattern (every subdomain of a tenant domain, a preview deployment).
     */
    it('consults an origins predicate, and hands it the request context', async () => {
        const asked: { origin: string, host: string }[] = [];
        const lambder = initLambder().create({
            files: testPublicFiles(),
            cors: {
                origins: (origin, ctx) => {
                    asked.push({ origin, host: ctx.host });
                    return origin.endsWith('.example.com');
                },
            },
        }).addRoute('/data', (ctx, res) => res.json({ ok: true }));

        const allowed = await lambder.render(
            createMockEvent('/data', { headers: { Host: 'localhost', Origin: 'https://tenant.example.com' } }),
            createMockContext(),
        );
        expect(allowed.multiValueHeaders?.['Access-Control-Allow-Origin']).toEqual(['https://tenant.example.com']);
        // An echoed origin always carries Vary, or a shared cache would serve
        // one tenant's answer to the next.
        expect(allowed.multiValueHeaders?.['Vary']).toContain('Origin');

        const refused = await lambder.render(
            createMockEvent('/data', { headers: { Host: 'localhost', Origin: 'https://evil.example' } }),
            createMockContext(),
        );
        expect(refused.multiValueHeaders?.['Access-Control-Allow-Origin']).toBeUndefined();

        expect(asked.map((entry) => entry.origin)).toEqual(['https://tenant.example.com', 'https://evil.example']);
        expect(asked.every((entry) => entry.host === 'localhost')).toBe(true);
    });

    /**
     * Browsers send `Origin: null` from a sandboxed frame, a file:// page or
     * after a cross-origin redirect, and `new URL("null")` throws. Pins the
     * bug where that throw rejected render() (a 502 no client can parse) and
     * the crash path ran the predicate again, reporting a second,
     * misattributed crash.
     */
    it('counts a predicate that throws as refused, logs it once, and answers the request normally', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const reported: string[] = [];
        const lambder = initLambder().create({
            files: testPublicFiles(),
            cors: { origins: (origin) => new URL(origin).hostname.endsWith('.example.com') },
            crashes: { report: (crash) => { reported.push(crash.message); } },
        }).addRoute('/data', (ctx, res) => res.json({ ok: true }));

        const result = await lambder.render(
            createMockEvent('/data', { headers: { Host: 'localhost', Origin: 'null' } }),
            createMockContext(),
        );

        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body)).toEqual({ ok: true });
        expect(result.multiValueHeaders?.['Vary']).toEqual(['Origin']);
        expect(result.multiValueHeaders?.['Access-Control-Allow-Origin']).toBeUndefined();
        expect(reported).toEqual([]);
        const logged = error.mock.calls.filter((call) => String(call[0]).includes('cors.origins threw'));
        expect(logged).toHaveLength(1);
        expect(String(logged[0]![0])).not.toContain('null');
    });

    it('settles the origin once per request and reuses it on the crash path, which runs no app code', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const asked: string[] = [];
        const reported: string[] = [];
        const build = (origins: (origin: string) => boolean) => initLambder().create({
            files: testPublicFiles(),
            cors: { origins },
            crashes: { report: (crash) => { reported.push(crash.message); } },
        }).addRoute('/broken', () => { throw new Error('the page broke'); });

        const allowed = await build((origin) => { asked.push(origin); return origin === 'https://app.example.com'; }).render(
            createMockEvent('/broken', { headers: { Host: 'localhost', Origin: 'https://app.example.com' } }),
            createMockContext(),
        );
        expect(allowed.statusCode).toBe(500);
        expect(allowed.multiValueHeaders?.['Access-Control-Allow-Origin']).toEqual(['https://app.example.com']);
        expect(asked).toEqual(['https://app.example.com']);

        const throwing = await build((origin) => new URL(origin).hostname.endsWith('.example.com')).render(
            createMockEvent('/broken', { headers: { Host: 'localhost', Origin: 'null' } }),
            createMockContext(),
        );
        expect(throwing.statusCode).toBe(500);
        expect(throwing.multiValueHeaders?.['Vary']).toEqual(['Origin']);
        expect(throwing.multiValueHeaders?.['Access-Control-Allow-Origin']).toBeUndefined();
        expect(reported).toEqual(['the page broke', 'the page broke']);
    });

    it('omits CORS headers for disallowed origins', async () => {
        const lambder = initLambder().create({ files: testPublicFiles(), cors: { origins: ['https://allowed.example'] } })
            .addRoute('/data', (ctx, res) => res.json({ ok: true }));

        const result = await lambder.render(
            createMockEvent('/data', { headers: { Host: 'localhost', Origin: 'https://evil.example' } }),
            createMockContext(),
        );
        expect(result.multiValueHeaders?.['Access-Control-Allow-Origin']).toBeUndefined();
    });
});

