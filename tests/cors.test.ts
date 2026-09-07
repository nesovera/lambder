/**
 * CORS configuration: preflight, credentialed origins, allowlists.
 */

import { describe, it, expect } from 'vitest';
import Lambder, { initLambder } from '../src/core/Lambder.js';
import { createMockEvent, createMockContext } from './helpers.js';
describe('CORS', () => {
    it('answers preflight with configured origins', async () => {
        const lambder = initLambder().create({ publicPath: './public', cors: { origins: ['https://app.example.com'], credentials: true } });

        const result = await lambder.render(
            createMockEvent('/api', { httpMethod: 'OPTIONS', headers: { Host: 'localhost', Origin: 'https://app.example.com' } }),
            createMockContext(),
        );
        expect(result.statusCode).toBe(204);
        expect(result.multiValueHeaders?.['Access-Control-Allow-Origin']).toEqual(['https://app.example.com']);
        expect(result.multiValueHeaders?.['Access-Control-Allow-Credentials']).toEqual(['true']);
        expect(result.multiValueHeaders?.['Access-Control-Allow-Methods']?.[0]).toContain('POST');
    });

    it('never combines a wildcard origin with credentials', async () => {
        const lambder = initLambder().create({ publicPath: './public', cors: { credentials: true } })
            .addRoute('/data', (ctx, res) => res.json({ ok: true }));

        const result = await lambder.render(
            createMockEvent('/data', { headers: { Host: 'localhost', Origin: 'https://site.example' } }),
            createMockContext(),
        );
        expect(result.multiValueHeaders?.['Access-Control-Allow-Origin']).toEqual(['https://site.example']);
    });

    it('exposes Retry-After to cross-origin callers by default, or the configured list', async () => {
        const call = async (cors: any) => (await initLambder().create({ publicPath: './public', cors })
            .addRoute('/data', (ctx, res) => res.json({ ok: true }))
            .render(createMockEvent('/data', { headers: { Host: 'localhost', Origin: 'https://site.example' } }), createMockContext()))
            .multiValueHeaders?.['Access-Control-Expose-Headers'];
        expect(await call(true)).toEqual(['Retry-After']);
        expect(await call({ exposeHeaders: ['Retry-After', 'X-Request-Id'] })).toEqual(['Retry-After, X-Request-Id']);
        expect(await call({ exposeHeaders: [] })).toBeUndefined();
    });

    it('omits CORS headers for disallowed origins', async () => {
        const lambder = initLambder().create({ publicPath: './public', cors: { origins: ['https://allowed.example'] } })
            .addRoute('/data', (ctx, res) => res.json({ ok: true }));

        const result = await lambder.render(
            createMockEvent('/data', { headers: { Host: 'localhost', Origin: 'https://evil.example' } }),
            createMockContext(),
        );
        expect(result.multiValueHeaders?.['Access-Control-Allow-Origin']).toBeUndefined();
    });
});

