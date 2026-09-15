/**
 * What a bundled browser build actually sees. package.json maps fs, path,
 * zlib and crypto to `false` for the browser, and webpack, Vite and esbuild
 * each honour that by resolving the import to a STUB MODULE rather than by
 * rejecting it. A stub is an object, so "did the import work" cannot be
 * answered by truthiness: the module has to be asked for a function it would
 * really export.
 *
 * Mocking the zlib specifier reproduces the bundler exactly, which a test
 * that only forces the import to reject does not. Without the probe, the mock
 * runtime restoring a gzipped request payload in a browser dies with
 * "zlib.gunzip is not a function", surfacing to the caller as a 400
 * invalid-request-payload.
 */

import { describe, it, expect, vi } from 'vitest';

// A webpack-shaped stub: an object with nothing on it. Vite and esbuild
// produce their own shapes; all three answer no function.
vi.mock('zlib', () => ({ default: {} }));

const { getZlib } = await import('../src/shared/util/LambderNodeModules.js');
const { restoreBytes, restoreText } = await import('../src/shared/wire/LambderCompressionCodec.js');
const { compressPayloadGzip } = await import('../src/shared/wire/LambderRequestPayload.js');
const { restoreCompressedPayload } = await import('../src/api/LambderApiRequest.js');
type LambderApiRequest = import('../src/api/LambderApiRequest.js').LambderApiRequest;

/**
 * Gzip through the web CompressionStream, the way a browser produces a
 * compressed request payload. Node's zlib is mocked away in this file, which
 * is the whole point of it.
 */
const gzipThroughWebStreams = async (text: string): Promise<Uint8Array> => {
    const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
};

describe('A runtime whose zlib is a bundler stub', () => {
    it('reports no zlib at all, rather than a module that cannot decompress', async () => {
        expect(await getZlib()).toBeNull();
    });

    it('restores a gzipped payload through DecompressionStream instead', async () => {
        const text = JSON.stringify({ values: Array.from({ length: 200 }, (_, i) => `row-${i}`) });
        const compressed = await gzipThroughWebStreams(text);

        const restored = await restoreText(compressed, 'gzip', { declaredBytes: Buffer.byteLength(text, 'utf8') });

        expect(restored).toBe(text);
    });

    it('still enforces the size bound on that path, so a bomb cannot get through it', async () => {
        const huge = 'x'.repeat(200_000);
        const compressed = await gzipThroughWebStreams(huge);

        await expect(restoreBytes(compressed, 'gzip', { maxBytes: 1000 })).rejects.toThrow();
    });

    it('lets a compressed request payload through the API request path', async () => {
        const payload = { values: Array.from({ length: 200 }, (_, i) => `row-${i}`) };
        const json = JSON.stringify(payload);
        const envelope = await compressPayloadGzip(json, 0);
        expect(envelope).not.toBeNull();

        const request: LambderApiRequest = {
            apiName: 'thing.do', version: null, token: '', siteHost: 'localhost',
            payload: undefined, compressedPayload: {
                gzip: envelope!.payloadGz,
                brotli: undefined,
                declaredBytes: envelope!.payloadBytes,
            },
            guardInputs: undefined, idempotencyKey: undefined,
            headers: {}, cookies: {}, ip: '1.2.3.4', host: 'localhost',
        };

        const restored = await restoreCompressedPayload(request, 20_000_000);

        expect(restored.ok).toBe(true);
        expect(request.payload).toEqual(payload);
    });
});
