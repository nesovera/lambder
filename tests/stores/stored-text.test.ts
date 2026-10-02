/**
 * The scheme every DynamoDB store here keeps text in (LambderStoredText):
 * compressed from the store's minBytes up and never when empty, the plain
 * form the very bytes handed in, and a restore that refuses a declared length
 * past the store's ceiling before it decompresses anything.
 *
 * The stores' own tests cover what each writes with it; this is the scheme.
 */

import { describe, it, expect } from 'vitest';
import { brotliCompressSync } from 'node:zlib';
import { restoreStoredText, storedTextOf } from '../../src/stores/LambderStoredText.js';
import { LambderCompressionError, LAMBDER_RESTORE_FAILURES } from '../../src/shared/wire/LambderCompressionCodec.js';

const utf8 = (text: string) => Buffer.from(text, 'utf8');
const ceiling = { user: 'TicketStore', maxTextBytes: 1024 };

describe('storedTextOf', () => {
    it('keeps the bytes handed in as they are with compression off', async () => {
        const text = utf8('{"order":1001}');
        const stored = await storedTextOf(text, null);

        expect(stored).toEqual({ encoding: 'identity', stored: text, textBytes: text.byteLength });
        expect(stored.stored).toBe(text);
    });

    it('compresses from minBytes up, and the compressed form restores to the text', async () => {
        const text = utf8('{"store":"nyc-01","hours":"9-5"}');
        const settings = { minBytes: text.byteLength, quality: 5 };

        expect((await storedTextOf(text.subarray(1), settings)).encoding).toBe('identity');
        const stored = await storedTextOf(text, settings);
        expect(stored.encoding).toBe('br');
        expect(stored.textBytes).toBe(text.byteLength);
        expect(await restoreStoredText(stored.stored, stored.textBytes, ceiling)).toBe(text.toString('utf8'));
    });

    it('never compresses an empty text, whose declared length the codec would refuse on the way back', async () => {
        const stored = await storedTextOf(utf8(''), { minBytes: 0, quality: 5 });
        expect(stored.encoding).toBe('identity');
        expect(stored.textBytes).toBe(0);
    });
});

describe('restoreStoredText', () => {
    it('refuses a declared length past the ceiling before decompressing, naming the store and the limit', async () => {
        // Bytes that are not Brotli at all: decompressing them would fail
        // as undecodable, so the ceiling's refusal shows nothing was tried.
        const failure = await restoreStoredText(utf8('not brotli'), 1025, ceiling).then(() => null, (error: unknown) => error as Error);

        expect(failure).not.toBeInstanceOf(LambderCompressionError);
        expect(failure?.message).toBe('TicketStore: a stored record declares 1025 bytes of text, over the 1024-byte limit it restores, so the record is unusable.');
    });

    it('restores up to the ceiling itself, and leaves a missing or mismatched length to the codec', async () => {
        const text = 'x'.repeat(1024);
        const compressed = brotliCompressSync(utf8(text));

        expect(await restoreStoredText(compressed, 1024, ceiling)).toBe(text);
        await expect(restoreStoredText(compressed, 0, ceiling)).rejects.toMatchObject({ reason: LAMBDER_RESTORE_FAILURES.missingLength });
        await expect(restoreStoredText(compressed, 1000, ceiling)).rejects.toBeInstanceOf(LambderCompressionError);
    });
});
