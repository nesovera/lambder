/**
 * The mark on an error already reported where it arose, which the instance's
 * crash reporting reads to skip a second report.
 */

import { describe, it, expect } from 'vitest';
import { isErrorReported, markErrorReported } from '../../src/shared/util/LambderErrorReportMark.js';

describe('markErrorReported and isErrorReported', () => {
    it('marks the one error, and nothing that wraps it or merely looks like it', () => {
        const reported = new Error('the callee refused');
        expect(isErrorReported(reported)).toBe(false);
        markErrorReported(reported);
        expect(isErrorReported(reported)).toBe(true);

        expect(isErrorReported(new Error('the gateway failed', { cause: reported }))).toBe(false);
        expect(isErrorReported({ message: 'the callee refused' })).toBe(false);
        expect(isErrorReported(null)).toBe(false);
        expect(isErrorReported('the callee refused')).toBe(false);
    });

    it('stays out of what the error serializes to and lists as its own keys', () => {
        const reported = Object.assign(new Error('the callee refused'), { reason: 'refusal' });
        markErrorReported(reported);

        expect(JSON.stringify(reported)).toBe('{"reason":"refusal"}');
        expect(Object.keys(reported)).toEqual(['reason']);
        expect({ ...reported }).toEqual({ reason: 'refusal' });
    });

    it('is read through the global symbol registry, so a second copy of the package reads the first one\'s mark', () => {
        const reported = new Error('marked by another copy');
        Object.defineProperty(reported, Symbol.for('lambder.errorReported'), { value: true });

        expect(isErrorReported(reported)).toBe(true);
    });
});
