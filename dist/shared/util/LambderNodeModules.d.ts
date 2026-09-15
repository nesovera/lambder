/**
 * The Node built-ins Lambder uses where they exist, and nothing where they do
 * not: the same code runs on Lambda and in a browser, so every one of these
 * is optional and every caller handles null.
 */
export declare const getFS: () => Promise<typeof import('fs') | null>;
export declare const getPath: () => Promise<typeof import('path') | null>;
export declare const getZlib: () => Promise<typeof import('zlib') | null>;
export declare const getCrypto: () => Promise<typeof import('crypto') | null>;
