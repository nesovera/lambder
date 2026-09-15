import { getFS, getPath } from "../shared/util/LambderNodeModules.js";
import type { LambderFile, LambderFileSource } from "../shared/contracts/LambderFileSource.js";

/**
 * Files from a folder on the Lambda's filesystem, typically the build output
 * bundled into the deployment package. Reads stay under root: the reader's
 * path rule already refuses anything that could leave it, and the resolved
 * path is checked against the root again here, because a contract is not a
 * boundary.
 */
export class LambderLocalFileSource implements LambderFileSource {
    private root: string;

    constructor({ root }: { root: string }){
        this.root = root;
    }

    async read(relativePath: string): Promise<LambderFile | null> {
        const fs = await getFS();
        const path = await getPath();
        if(!fs || !path) throw new Error("Lambder: LambderLocalFileSource requires a Node.js environment.");

        const base = path.resolve(this.root);
        const absolute = path.resolve(base, relativePath);
        if(absolute !== base && !absolute.startsWith(base + path.sep)) return null;

        const stat = await fs.promises.stat(absolute).catch(() => null);
        if(!stat?.isFile()) return null;
        return { body: await fs.promises.readFile(absolute) };
    }
}
