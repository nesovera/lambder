import LambderResponseBuilder from "./LambderResponseBuilder.js";
export default class LambderResolver extends LambderResponseBuilder {
    resolve;
    reject;
    die;
    constructor({ isCorsEnabled, publicPath, apiVersion, lambderUtils, ctx, resolve, reject }) {
        super({ isCorsEnabled, publicPath, apiVersion, lambderUtils, ctx, });
        this.resolve = resolve;
        this.reject = reject;
        this.die = {
            raw: this.autoResolve(this.raw),
            json: this.autoResolve(this.json),
            xml: this.autoResolve(this.xml),
            html: this.autoResolve(this.html),
            status301: this.autoResolve(this.status301),
            status404: this.autoResolve(this.status404),
            cors: this.autoResolve(this.cors),
            fileBase64: this.autoResolve(this.fileBase64),
            file: this.autoResolve(this.file),
            ejsFile: this.autoResolvePromise(this.ejsFile),
            ejsTemplate: this.autoResolvePromise(this.ejsTemplate),
            api: this.autoResolve(this.api),
        };
    }
    autoResolve(method) {
        return (...args) => {
            const result = method.apply(this, args);
            this.resolve(result);
            return result;
        };
    }
    autoResolvePromise(method) {
        return (...args) => {
            return new Promise((resolve, reject) => {
                method.apply(this, args)
                    .then(result => {
                    this.resolve(result);
                    resolve(result);
                })
                    .catch(err => {
                    this.reject(err);
                    reject(err);
                });
            });
        };
    }
}
;
