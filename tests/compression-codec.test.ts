/**
 * The shared compression codec: one implementation of the bounded,
 * length-verified restore that every compressed value in Lambder depends on,
 * whether it is a session record at rest or an untrusted request body.
 *
 * The guarantee under test is the same for both encodings: the declared byte
 * length bounds the decompression AND must match the result exactly, so a
 * truncated, padded or over-expanding input fails rather than decoding to
 * something merely plausible.
 */

import { describe, it, expect } from 'vitest';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { compressText, restoreBytes, restoreText, LambderCompressionError, LAMBDER_RESTORE_FAILURES } from '../src/shared/LambderCompressionCodec.js';
import { LAMBDER_ENCODINGS } from '../src/shared/LambderCompressionOption.js';

const encodings = [...LAMBDER_ENCODINGS];
const text = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `Row ${i}` })) });
const textBytes = Buffer.byteLength(text);

describe.each(encodings)('Compression codec (%s)', (encoding) => {
    it('round-trips text', async () => {
        const compressed = await compressText(Buffer.from(text), encoding, 5);

        expect(compressed.length).toBeLessThan(textBytes);
        await expect(restoreText(compressed, encoding, { declaredBytes: textBytes })).resolves.toBe(text);
    });

    it('round-trips multi-byte text by its UTF-8 length, not its character count', async () => {
        const unicode = JSON.stringify({ note: 'ünïcödé Şşğ İstanbul '.repeat(50) });
        const bytes = Buffer.byteLength(unicode);
        const compressed = await compressText(Buffer.from(unicode), encoding, 5);

        expect(bytes).toBeGreaterThan(unicode.length);
        await expect(restoreText(compressed, encoding, { declaredBytes: bytes })).resolves.toBe(unicode);
    });

    it('rejects a missing or nonsense declared length', async () => {
        const compressed = await compressText(Buffer.from(text), encoding, 5);

        for(const declared of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]){
            const failure = await restoreText(compressed, encoding, { declaredBytes: declared }).catch((err) => err);
            expect(failure).toBeInstanceOf(LambderCompressionError);
            expect(failure.reason).toBe(LAMBDER_RESTORE_FAILURES.missingLength);
        }
    });

    it('refuses to expand past the declared length', async () => {
        // 5MB of compressible bytes declared as 100: the bound stops it.
        const bomb = encoding === 'br'
            ? brotliCompressSync(Buffer.alloc(5_000_000, 0x61))
            : gzipSync(Buffer.alloc(5_000_000, 0x61));

        const failure = await restoreText(bomb, encoding, { declaredBytes: 100 }).catch((err) => err);

        expect(failure).toBeInstanceOf(LambderCompressionError);
        expect(failure.reason).toBe(LAMBDER_RESTORE_FAILURES.undecodable);
    });

    it('rejects a shorter result than declared', async () => {
        const compressed = await compressText(Buffer.from(text), encoding, 5);

        const failure = await restoreText(compressed, encoding, { declaredBytes: textBytes + 10 }).catch((err) => err);

        expect(failure).toBeInstanceOf(LambderCompressionError);
        expect(failure.reason).toBe(LAMBDER_RESTORE_FAILURES.lengthMismatch);
    });

    it('rejects truncated bytes and bytes of another algorithm', async () => {
        const compressed = await compressText(Buffer.from(text), encoding, 5);
        const other = encoding === 'br' ? gzipSync(Buffer.from(text)) : brotliCompressSync(Buffer.from(text));

        for(const bad of [compressed.subarray(0, 20), other, Buffer.from('not compressed at all')]){
            const failure = await restoreText(bad, encoding, { declaredBytes: textBytes }).catch((err) => err);
            expect(failure).toBeInstanceOf(LambderCompressionError);
            expect(failure.reason).toBe(LAMBDER_RESTORE_FAILURES.undecodable);
        }
    });
});

describe('Compression codec - encoding choice', () => {
    it('applies the Brotli quality and leaves gzip alone', async () => {
        const body = Buffer.from(text);
        const [low, high, gzip] = await Promise.all([
            compressText(body, 'br', 1),
            compressText(body, 'br', 11),
            compressText(body, 'gzip', 11),
        ]);

        // Quality is a real knob for Brotli...
        expect(high.length).toBeLessThan(low.length);
        // ...and Brotli at the default quality beats gzip on this shape.
        expect((await compressText(body, 'br', 5)).length).toBeLessThan(gzip.length);
    });
});

describe('Compression codec - a ceiling instead of a declared length', () => {
    const text = 'the same line again and again, '.repeat(200);

    it.each(['br', 'gzip'] as const)('restores %s bytes under the ceiling', async (encoding) => {
        const compressed = await compressText(Buffer.from(text, 'utf8'), encoding, 5);
        await expect(restoreText(compressed, encoding, { maxBytes: Buffer.byteLength(text) })).resolves.toBe(text);
        await expect(restoreText(compressed, encoding, { maxBytes: 10_000_000 })).resolves.toBe(text);
    });

    it('refuses to expand past the ceiling, as undecodable', async () => {
        const compressed = await compressText(Buffer.from(text, 'utf8'), 'br', 5);
        const failure = await restoreText(compressed, 'br', { maxBytes: 100 }).catch((err: unknown) => err);
        expect(failure).toBeInstanceOf(LambderCompressionError);
        expect((failure as LambderCompressionError).reason).toBe(LAMBDER_RESTORE_FAILURES.undecodable);
    });

    it('rejects a nonsense ceiling and truncated bytes', async () => {
        const compressed = await compressText(Buffer.from(text, 'utf8'), 'gzip', 5);
        // A bad ceiling is the caller's mistake, not a restore failure.
        await expect(restoreText(compressed, 'gzip', { maxBytes: 0 })).rejects.toThrow("maxBytes must be a positive integer");
        await expect(restoreText(compressed.subarray(0, 20), 'gzip', { maxBytes: 100_000 })).rejects.toMatchObject({ reason: LAMBDER_RESTORE_FAILURES.undecodable });
    });
});

describe('Compression codec - restoreBytes keeps bytes that are not text', () => {
    /** Bytes no UTF-8 decode survives: a lone 0xff is not a valid sequence. */
    const binary = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), Buffer.alloc(4000, 0xff)]);

    it.each(['br', 'gzip'] as const)('round trips arbitrary %s bytes unchanged', async (encoding) => {
        const compressed = await compressText(binary, encoding, 5);
        const restored = await restoreBytes(compressed, encoding, { maxBytes: 1_000_000 });
        expect(restored.equals(binary)).toBe(true);
        // What restoreText would have done to them, and why a binary body cannot go through it.
        expect(Buffer.from(await restoreText(compressed, encoding, { maxBytes: 1_000_000 }), 'utf8').equals(binary)).toBe(false);
    });

    it('carries the same bound and verification as restoreText', async () => {
        const compressed = await compressText(binary, 'br', 5);
        await expect(restoreBytes(compressed, 'br', { declaredBytes: binary.length })).resolves.toHaveLength(binary.length);
        await expect(restoreBytes(compressed, 'br', { declaredBytes: binary.length + 1 }))
            .rejects.toMatchObject({ reason: LAMBDER_RESTORE_FAILURES.lengthMismatch });
        await expect(restoreBytes(compressed, 'br', { maxBytes: 100 }))
            .rejects.toMatchObject({ reason: LAMBDER_RESTORE_FAILURES.undecodable });
        await expect(restoreBytes(compressed, 'br', { maxBytes: 0 })).rejects.toThrow('maxBytes must be a positive integer');
    });
});
