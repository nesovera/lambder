import fs from "fs";
import * as path from "path";
import ejs from "ejs";
export default class LambderUtils {
    ejsPath;
    constructor({ ejsPath } = {}) {
        this.ejsPath = ejsPath;
    }
    ;
    readEjsFileSync(filePath) {
        if (!this.ejsPath) {
            return "EJS PATH NOT SET!";
        }
        const ejsPath = path.resolve(this.ejsPath);
        const absolutePath = path.join(ejsPath, filePath);
        console.log("readEjsFileSync", { filePath, ejsPath, absolutePath });
        if (!absolutePath.includes(ejsPath)) {
            return "forbidden-ejs-path";
        }
        return String(fs.readFileSync(absolutePath));
    }
    ;
    checkEjsFileExist(filePath) {
        if (!this.ejsPath) {
            return "EJS PATH NOT SET!";
        }
        const ejsPath = path.resolve(this.ejsPath);
        const absolutePath = path.join(this.ejsPath, filePath);
        console.log("checkEjsFileExist", { filePath, ejsPath, absolutePath });
        if (!absolutePath.includes(ejsPath)) {
            return false;
        }
        return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
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
        if (!this.checkEjsFileExist(filePath)) {
            return "File not found: " + filePath;
        }
        const template = this.readEjsFileSync(filePath);
        return this.renderEjs(template, pageData);
    }
    ;
}
;
