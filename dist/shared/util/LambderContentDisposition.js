/**
 * A Content-Disposition header for a file name of any characters: an ASCII
 * `filename` for old clients, and the exact name as UTF-8 in `filename*`
 * (RFC 6266). A character a header cannot carry never reaches it, so a name
 * holding a quote or a line break cannot end the header early.
 */
export const contentDispositionHeader = ({ disposition, fileName }) => {
    if (fileName === undefined)
        return disposition;
    const fallback = fileName.replace(/[^\x20-\x7e]|["\\%]/g, "_");
    const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};
