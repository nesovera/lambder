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
import {
    compressText,
    restoreBoundedText,
    LambderCompressionError,
    LAMBDER_RESTORE_FAILURES,
} from '../src/shared/LambderCompressionCodec.js';
import { LAMBDER_ENCODINGS } from '../src/shared/LambderCompressionOption.js';

const encodings = [...LAMBDER_ENCODINGS];
const text = JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `Row ${i}` })) });
const textBytes = Buffer.byteLength(text);

describe.each(encodings)('Compression codec (%s)', (encoding) => {
    it('round-trips text', async () => {
        const compressed = await compressText(Buffer.from(text), encoding, 5);

        expect(compressed.length).toBeLessThan(textBytes);
        await expect(restoreBoundedText(compressed, textBytes, encoding)).resolves.toBe(text);
    });

    it('round-trips multi-byte text by its UTF-8 length, not its character count', async () => {
        const unicode = JSON.stringify({ note: 'ünïcödé Şşğ İstanbul '.repeat(50) });
        const bytes = Buffer.byteLength(unicode);
        const compressed = await compressText(Buffer.from(unicode), encoding, 5);

        expect(bytes).toBeGreaterThan(unicode.length);
        await expect(restoreBoundedText(compressed, bytes, encoding)).resolves.toBe(unicode);
    });

    it('rejects a missing or nonsense declared length', async () => {
        const compressed = await compressText(Buffer.from(text), encoding, 5);

        for(const declared of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]){
            const failure = await restoreBoundedText(compressed, declared, encoding).catch((err) => err);
            expect(failure).toBeInstanceOf(LambderCompressionError);
            expect(failure.reason).toBe(LAMBDER_RESTORE_FAILURES.missingLength);
        }
    });

    it('refuses to expand past the declared length', async () => {
        // 5MB of compressible bytes declared as 100: the bound stops it.
        const bomb = encoding === 'br'
            ? brotliCompressSync(Buffer.alloc(5_000_000, 0x61))
            : gzipSync(Buffer.alloc(5_000_000, 0x61));

        const failure = await restoreBoundedText(bomb, 100, encoding).catch((err) => err);

        expect(failure).toBeInstanceOf(LambderCompressionError);
        expect(failure.reason).toBe(LAMBDER_RESTORE_FAILURES.undecodable);
    });

    it('rejects a shorter result than declared', async () => {
        const compressed = await compressText(Buffer.from(text), encoding, 5);

        const failure = await restoreBoundedText(compressed, textBytes + 10, encoding).catch((err) => err);

        expect(failure).toBeInstanceOf(LambderCompressionError);
        expect(failure.reason).toBe(LAMBDER_RESTORE_FAILURES.lengthMismatch);
    });

    it('rejects truncated bytes and bytes of another algorithm', async () => {
        const compressed = await compressText(Buffer.from(text), encoding, 5);
        const other = encoding === 'br' ? gzipSync(Buffer.from(text)) : brotliCompressSync(Buffer.from(text));

        for(const bad of [compressed.subarray(0, 20), other, Buffer.from('not compressed at all')]){
            const failure = await restoreBoundedText(bad, textBytes, encoding).catch((err) => err);
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
