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
import { z } from 'zod';
import { bytesToBase64, base64ToBytes, base64ToText, isBase64Url } from '../../src/shared/util/LambderBase64.js';
import { LambderSignedClaims } from '../../src/shared/util/LambderSignedClaims.js';

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

describe('Signed claims where there is no Buffer', () => {
    /** The same as withoutBuffer, for a body that awaits: the global stays away until it settles. */
    const withoutBufferAsync = async <T>(body: () => Promise<T>): Promise<T> => {
        const global = globalThis as { Buffer?: unknown };
        const saved = global.Buffer;
        delete global.Buffer;
        try {
            return await body();
        } finally {
            global.Buffer = saved;
        }
    };

    it('answers null for a mac of a length no encoding has, rather than letting atob throw', async () => {
        const tickets = new LambderSignedClaims({ secret: 'ticket-secret', version: 't1', schema: z.object({ seat: z.string() }) });
        const token = await tickets.sign({ seat: 'A1' });
        const [version, body, mac] = token.split('.') as [string, string, string];
        // A SHA-256 mac is 43 characters; 41 leaves a remainder of one past a multiple of four.
        expect(mac).toHaveLength(43);
        const mangled = mac.slice(0, 41);
        expect(isBase64Url(mangled)).toBe(false);

        await withoutBufferAsync(async () => {
            expect(typeof Buffer).toBe('undefined');
            expect(await tickets.verify(`${version}.${body}.${mangled}`)).toBeNull();
            expect(await tickets.verify(`${version}.${body}X.${mac}`)).toBeNull();
            expect(await tickets.verify(token)).toEqual({ seat: 'A1' });
        });
    });
});
