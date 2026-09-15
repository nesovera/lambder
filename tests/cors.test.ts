/**
 * CORS configuration: preflight, credentialed origins, allowlists.
 */

import { describe, it, expect } from 'vitest';
import { initLambder } from '../src/core/Lambder.js';
import { createMockEvent, createMockContext, testPublicFiles } from './helpers.js';
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
     * The preflight used to be given its headers where the 204 was built AND
     * again at the end of render(), once as a preflight and once not, so an
     * allowlisted app answered every preflight with a duplicated Vary and an
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

    it('never combines a wildcard origin with credentials', async () => {
        const lambder = initLambder().create({ files: testPublicFiles(), cors: { credentials: true } })
            .addRoute('/data', (ctx, res) => res.json({ ok: true }));

        const result = await lambder.render(
            createMockEvent('/data', { headers: { Host: 'localhost', Origin: 'https://site.example' } }),
            createMockContext(),
        );
        expect(result.multiValueHeaders?.['Access-Control-Allow-Origin']).toEqual(['https://site.example']);
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
     * a pattern (every subdomain of a tenant domain, a preview deployment),
     * and it was the one form with no test at all.
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

