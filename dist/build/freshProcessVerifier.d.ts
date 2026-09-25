/** What the parent asks for: which export of which module to digest, and the file to compare it with. */
export type FreshProcessRequest = {
    moduleUrl: string;
    exportName: string;
    file: string;
};
/** The comparison, or why none could be made. */
export type FreshProcessVerdict = {
    same: boolean;
    lines: string[];
} | {
    failure: string;
};
