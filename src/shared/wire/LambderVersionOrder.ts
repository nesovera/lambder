/**
 * Dotted version strings ("1.2.10"), compared segment by segment as numbers,
 * so "1.2.10" sorts after "1.2.9" where a string comparison would put it
 * first. The server's version floor (minApiVersion) reads a caller's version
 * this way, and an app deciding whether a client is behind can read the
 * envelope's apiVersion the same way.
 */

/** True for one or more decimal segments joined by dots: "7", "1.2", "1.2.10". */
export const isDottedVersion = (value: string): boolean => /^\d+(\.\d+)*$/.test(value);

/** A segment as a number; anything that is not one counts as 0, so a version nothing can read sorts below every real one. */
const segmentOf = (text: string): number => {
    const parsed = parseInt(text, 10);
    return Number.isFinite(parsed) ? parsed : 0;
};

/** -1 when `a` is older than `b`, 1 when newer, 0 when equal. A missing segment counts as 0, so "1.2" equals "1.2.0". */
export const compareDottedVersions = (a: string, b: string): -1 | 0 | 1 => {
    const left = a.split(".").map(segmentOf);
    const right = b.split(".").map(segmentOf);
    for(let i = 0; i < Math.max(left.length, right.length); i += 1){
        const x = left[i] ?? 0;
        const y = right[i] ?? 0;
        if(x < y) return -1;
        if(x > y) return 1;
    }
    return 0;
};
