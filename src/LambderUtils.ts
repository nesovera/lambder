import fs from "fs";
import * as path from "path";
import ejs from "ejs";

export default class LambderUtils {
    private ejsPath?: string;

    constructor(
        { ejsPath }: {
            ejsPath?: string
        } = {}
    ){
        this.ejsPath = ejsPath;
    };

    private readEjsFileSync(filePath: string){
        if(!this.ejsPath){ return "EJS PATH NOT SET!"; }
        const ejsPath = path.resolve(this.ejsPath);
        const absolutePath = path.join(ejsPath, filePath);
        console.log("readEjsFileSync", { filePath, ejsPath, absolutePath });
        if(!absolutePath.includes(ejsPath)){ return "forbidden-ejs-path"; }
        return String(fs.readFileSync(absolutePath));
    };

    private checkEjsFileExist(filePath: string){
        if(!this.ejsPath){ return "EJS PATH NOT SET!"; }
        const ejsPath = path.resolve(this.ejsPath);
        const absolutePath = path.join(this.ejsPath, filePath);
        console.log("checkEjsFileExist", { filePath, ejsPath, absolutePath });
        if(!absolutePath.includes(ejsPath)){ return false; }
        return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
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
        if(!this.checkEjsFileExist(filePath)){
            return "File not found: " + filePath;
        }
        const template = this.readEjsFileSync(filePath);
        return this.renderEjs(template, pageData);
    };

};