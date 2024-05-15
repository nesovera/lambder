export default class LambderUtils {
    private ejsPath?;
    constructor({ ejsPath }?: {
        ejsPath?: string;
    });
    private readEjsFileSync;
    private checkEjsFileExist;
    renderEjs(template: string, pageData: Record<string, any>): Promise<string>;
    renderEjsFile(filePath: string, pageData: Record<string, any>): Promise<string>;
}
