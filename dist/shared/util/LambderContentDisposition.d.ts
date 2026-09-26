/**
 * A Content-Disposition header for a file name of any characters: an ASCII
 * `filename` for old clients, and the exact name as UTF-8 in `filename*`
 * (RFC 6266). A character a header cannot carry never reaches it, so a name
 * holding a quote or a line break cannot end the header early.
 */
export declare const contentDispositionHeader: ({ disposition, fileName }: {
    disposition: "inline" | "attachment";
    fileName?: string;
}) => string;
