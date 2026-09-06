export declare const brotliCompressText: (input: Buffer, quality: number) => Promise<Buffer>;
/** maxOutputLength bounds decompression so a corrupt record cannot balloon memory. */
export declare const brotliDecompressText: (input: Buffer, maxOutputLength: number) => Promise<Buffer>;
