/**
 * The shared compression option resolver: one vocabulary (`true` / `false` /
 * overrides) resolved and validated the same way at every site, at
 * construction rather than on some later request.
 */

import { describe, it, expect } from 'vitest';
import { resolveCompressionOption, LAMBDER_ENCODINGS } from '../src/shared/LambderCompressionOption.js';
import { DEFAULT_RESPONSE_COMPRESSION_SETTINGS } from '../src/core/LambderResponse.js';

const atRest = { minBytes: 1024, quality: 5 };

describe('resolveCompressionOption', () => {
    it('resolves the shared vocabulary', () => {
        expect(resolveCompressionOption(false, atRest)).toBeNull();
        expect(resolveCompressionOption(true, atRest)).toEqual(atRest);
        expect(resolveCompressionOption(undefined, atRest)).toEqual(atRest);
        expect(resolveCompressionOption({ minBytes: 0 }, atRest)).toEqual({ minBytes: 0, quality: 5 });
        expect(resolveCompressionOption({ quality: 11 }, atRest)).toEqual({ minBytes: 1024, quality: 11 });
    });

    it('treats a field set to undefined as unspecified', () => {
        // `{ minBytes: config.threshold }` with an optional threshold must
        // keep the default, not replace it with undefined.
        expect(resolveCompressionOption({ minBytes: undefined }, atRest)).toEqual(atRest);
        expect(resolveCompressionOption({ quality: undefined }, atRest)).toEqual(atRest);
        expect(resolveCompressionOption({ encodings: undefined }, DEFAULT_RESPONSE_COMPRESSION_SETTINGS))
            .toEqual(DEFAULT_RESPONSE_COMPRESSION_SETTINGS);
    });

    it('rejects a bad threshold or quality', () => {
        expect(() => resolveCompressionOption({ minBytes: -1 }, atRest)).toThrow(/non-negative integer/);
        expect(() => resolveCompressionOption({ minBytes: 1.5 }, atRest)).toThrow(/non-negative integer/);
        expect(() => resolveCompressionOption({ quality: 12 }, atRest)).toThrow(/0 to 11/);
        expect(() => resolveCompressionOption({ quality: 2.5 }, atRest)).toThrow(/0 to 11/);
    });

    it('rejects an empty or unknown encoding list', () => {
        expect(() => resolveCompressionOption({ encodings: [] }, DEFAULT_RESPONSE_COMPRESSION_SETTINGS)).toThrow(/non-empty list/);
        expect(() => resolveCompressionOption({ encodings: ['deflate' as any] }, DEFAULT_RESPONSE_COMPRESSION_SETTINGS)).toThrow(/non-empty list/);
        expect(() => resolveCompressionOption({ encodings: 'gzip' as any }, DEFAULT_RESPONSE_COMPRESSION_SETTINGS)).toThrow(/non-empty list/);
        for(const encoding of LAMBDER_ENCODINGS){
            expect(resolveCompressionOption({ encodings: [encoding] }, DEFAULT_RESPONSE_COMPRESSION_SETTINGS)?.encodings).toEqual([encoding]);
        }
    });
});
