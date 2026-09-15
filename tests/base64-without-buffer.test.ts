/**
 * LambderBase64's no-Buffer branch: the one a browser takes, which is where
 * the mock runtime decodes an untrusted request payload. Node always has
 * Buffer, so the branch is unreachable in this suite unless the global is
 * taken away, which each test here does and puts back in a `finally`.
 *
 * What it has to get right is what the Buffer path gets for free: chunking
 * the input so a large payload cannot overflow String.fromCharCode's
 * argument list, honouring a view's byte offset rather than encoding the
 * whole buffer behind it, and leaving multi-byte text intact.
 */

import { describe, it, expect } from 'vitest';
import { bytesToBase64, base64ToBytes, base64ToText } from '../src/shared/util/LambderBase64.js';

/** Runs `body` with no `Buffer` global, whatever it does. */
const withoutBuffer = <T>(body: () => T): T => {
    const global = globalThis as { Buffer?: unknown };
    const saved = global.Buffer;
    delete global.Buffer;
    try {
        return body();
    } finally {
        global.Buffer = saved;
    }
};

describe('LambderBase64 where there is no Buffer', () => {
    it('round-trips bytes through the platform encoder', () => {
        const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
        const expected = Buffer.from(bytes).toString('base64');

        withoutBuffer(() => {
            expect(typeof Buffer).toBe('undefined');
            expect(bytesToBase64(bytes)).toBe(expected);
            expect([...base64ToBytes(expected)]).toEqual([...bytes]);
        });
    });

    it('encodes past the 0x8000 chunk boundary, which is what the chunking is for', () => {
        // Two full chunks and a remainder, with every byte value in play, so a
        // chunk seam that dropped or doubled bytes would show.
        const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, index) => index % 256);
        const expected = Buffer.from(bytes).toString('base64');

        withoutBuffer(() => {
            expect(bytesToBase64(bytes)).toBe(expected);
            expect([...base64ToBytes(expected)]).toEqual([...bytes]);
        });
    });

    it('encodes a view of a larger buffer, not the buffer behind it', () => {
        const backing = new Uint8Array([9, 9, 9, 1, 2, 3, 9, 9]);
        const view = backing.subarray(3, 6);
        const expected = Buffer.from([1, 2, 3]).toString('base64');

        withoutBuffer(() => {
            expect(bytesToBase64(view)).toBe(expected);
        });
    });

    it('decodes multi-byte text back to the text', () => {
        const text = 'ıŞğ üö, 東京 🚌';
        const encoded = Buffer.from(text, 'utf8').toString('base64');

        withoutBuffer(() => {
            expect(base64ToText(encoded)).toBe(text);
            expect(bytesToBase64(new TextEncoder().encode(text))).toBe(encoded);
        });
    });
});
