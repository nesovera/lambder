import LambderResponseBuilder from "./LambderResponseBuilder.js";
/**
 * Response builder passed to route/api handlers and hooks.
 *
 * `res.die.*` builds the response and THROWS it, immediately halting the
 * request at any call depth (handlers, hooks, nested service functions).
 * Lambder's render pipeline catches thrown LambderResponse instances and uses
 * them as the response. Plain `throw res.html(...)` works the same way.
 */
export default class LambderResolver extends LambderResponseBuilder {
    die;
    constructor(...args) {
        super(...args);
        this.die = {
            raw: (...a) => { throw this.raw(...a); },
            json: (...a) => { throw this.json(...a); },
            text: (...a) => { throw this.text(...a); },
            xml: (...a) => { throw this.xml(...a); },
            html: (...a) => { throw this.html(...a); },
            status: (...a) => { throw this.status(...a); },
            status404: (...a) => { throw this.status404(...a); },
            redirect: (...a) => { throw this.redirect(...a); },
            versionExpired: (...a) => { throw this.versionExpired(...a); },
            fileBase64: (...a) => { throw this.fileBase64(...a); },
            api: (...a) => { throw this.api(...a); },
            apiBinary: (...a) => { throw this.apiBinary(...a); },
            file: async (...a) => { throw await this.file(...a); },
            templateFile: async (...a) => { throw await this.templateFile(...a); },
        };
    }
    // Override api method with proper output typing
    api(payload, config, options) {
        return super.api(payload, config, options);
    }
    apiBinary(payload, config, options) {
        return super.apiBinary(payload, config, options);
    }
}
