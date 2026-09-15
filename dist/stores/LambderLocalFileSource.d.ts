import type { LambderFile, LambderFileSource } from "../shared/contracts/LambderFileSource.js";
/**
 * Files from a folder on the Lambda's filesystem, typically the build output
 * bundled into the deployment package. Reads stay under root: the reader's
 * path rule already refuses anything that could leave it, and the resolved
 * path is checked against the root again here, because a contract is not a
 * boundary.
 */
export declare class LambderLocalFileSource implements LambderFileSource {
    private root;
    constructor({ root }: {
        root: string;
    });
    read(relativePath: string): Promise<LambderFile | null>;
}
