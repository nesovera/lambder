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
            // Overloaded on the payload (see LambderApiAnswer); the implementation takes both shapes.
            api: ((payload, config, options) => {
                throw this.api(payload, config, options);
            }),
            apiBinary: ((payload, config, options) => {
                throw this.apiBinary(payload, config, options);
            }),
            file: async (...a) => { throw await this.file(...a); },
            templateFile: async (...a) => { throw await this.templateFile(...a); },
        };
    }
    api(payload, config, options) {
        return super.api(payload, config, options);
    }
    apiBinary(payload, config, options) {
        return super.apiBinary(payload, config, options);
    }
}
