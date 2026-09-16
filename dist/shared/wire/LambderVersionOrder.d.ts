/**
 * Dotted version strings ("1.2.10"), compared segment by segment as numbers,
 * so "1.2.10" sorts after "1.2.9" where a string comparison would put it
 * first. The server's version floor (minApiVersion) reads a caller's version
 * this way, and an app deciding whether a client is behind can read the
 * envelope's apiVersion the same way.
 */
/** True for one or more decimal segments joined by dots: "7", "1.2", "1.2.10". */
export declare const isDottedVersion: (value: string) => boolean;
/** -1 when `a` is older than `b`, 1 when newer, 0 when equal. A missing segment counts as 0, so "1.2" equals "1.2.0". */
export declare const compareDottedVersions: (a: string, b: string) => -1 | 0 | 1;
