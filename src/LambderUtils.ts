import ejs from "ejs";
import { getFS, getPath } from "./node-polyfills.js";

export default class LambderUtils {
    private ejsPath?: string;

    constructor(
        { ejsPath }: {
            ejsPath?: string
        } = {}
    ){
        this.ejsPath = ejsPath;
    };

    private async readEjsFileSync(filePath: string){
        const fs = await getFS();
        const path = await getPath();
        
        if (!fs || !path) {
            throw new Error("File system operations are not available in browser environment");
        }
        if(!this.ejsPath){ return "EJS PATH NOT SET!"; }
        const ejsPath = path.resolve(this.ejsPath);
        const absolutePath = path.resolve(ejsPath, filePath);
        console.log("readEjsFileSync", { filePath, ejsPath, absolutePath });
        if(!absolutePath.startsWith(ejsPath)){ return "forbidden-ejs-path"; }
        return String(await fs.promises.readFile(absolutePath));
    };

    private async checkEjsFileExist(filePath: string){
        const fs = await getFS();
        const path = await getPath();
        
        if (!fs || !path) {
            return false;
        }
        if(!this.ejsPath){ return "EJS PATH NOT SET!"; }
        const ejsPath = path.resolve(this.ejsPath);
        const absolutePath = path.resolve(ejsPath, filePath);
        console.log("checkEjsFileExist", { filePath, ejsPath, absolutePath });
        if(!absolutePath.startsWith(ejsPath)){ return false; }
        try {
            const stat = await fs.promises.stat(absolutePath);
            return stat.isFile();
        } catch {
            return false;
        }
    };

	async renderEjs(
        template: string, 
        pageData: Record<string, any>,
    ):Promise<string>{
        const includeRenderedFile = async (filePath: string, partialData: Record<string, any>) => {
            const template = await this.readEjsFileSync(filePath);
            return await ejs.render(template, { page: pageData, partial: partialData, include: includeRenderedFile }, { async: true });
        }
        const renderedResult = await ejs.render(template, { page: pageData, include: includeRenderedFile }, { async: true });

        return renderedResult;
    };

	async renderEjsFile(
        filePath: string, 
        pageData: Record<string, any>,
    ):Promise<string>{
        const doesFileExist = await this.checkEjsFileExist(filePath);
        if(!doesFileExist){
            return "File not found: " + filePath;
        }
        const template = await this.readEjsFileSync(filePath);
        return this.renderEjs(template, pageData);
    };

};