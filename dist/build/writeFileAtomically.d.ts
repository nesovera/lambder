/**
 * Writes a generated file so that a build reading it meanwhile sees the old
 * contents or the new, never half of either: the text goes to a file beside
 * the target and is renamed over it. A symlink is followed to the file it
 * names, since renamed over, the link itself would become the new file and
 * its target would keep the old contents.
 */
export declare const writeFileAtomically: (file: string, contents: string, exists: boolean) => void;
