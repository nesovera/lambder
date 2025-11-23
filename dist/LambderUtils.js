import ejs from "ejs";
import { getFS, getPath } from "./node-polyfills.js";
export default class LambderUtils {
    ejsPath;
    constructor({ ejsPath } = {}) {
        this.ejsPath = ejsPath;
    }
    ;
    async readEjsFileSync(filePath) {
        const fs = await getFS();
        const path = await getPath();
        if (!fs || !path) {
            throw new Error("File system operations are not available in browser environment");
        }
        if (!this.ejsPath) {
            return "EJS PATH NOT SET!";
        }
        const ejsPath = path.resolve(this.ejsPath);
        const normalizedFilePath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
        const absolutePath = path.resolve(ejsPath, normalizedFilePath);
        if (!absolutePath.startsWith(ejsPath)) {
            return "forbidden-ejs-path";
        }
        return await fs.promises.readFile(absolutePath, 'utf-8');
    }
    ;
    async checkEjsFileExist(filePath) {
        const fs = await getFS();
        const path = await getPath();
        if (!fs || !path) {
            return false;
        }
        if (!this.ejsPath) {
            return "EJS PATH NOT SET!";
        }
        const ejsPath = path.resolve(this.ejsPath);
        const normalizedFilePath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
        const absolutePath = path.resolve(ejsPath, normalizedFilePath);
        if (!absolutePath.startsWith(ejsPath)) {
            return false;
        }
        try {
            const stat = await fs.promises.stat(absolutePath);
            return stat.isFile();
        }
        catch {
            return false;
        }
    }
    ;
    async renderEjs(template, pageData) {
        const includeRenderedFile = async (filePath, partialData) => {
            const template = await this.readEjsFileSync(filePath);
            return await ejs.render(template, { page: pageData, partial: partialData, include: includeRenderedFile }, { async: true });
        };
        const renderedResult = await ejs.render(template, { page: pageData, include: includeRenderedFile }, { async: true });
        return renderedResult;
    }
    ;
    async renderEjsFile(filePath, pageData) {
        const doesFileExist = await this.checkEjsFileExist(filePath);
        if (!doesFileExist) {
            return "File not found: " + filePath;
        }
        const template = await this.readEjsFileSync(filePath);
        return this.renderEjs(template, pageData);
    }
    ;
}
;
