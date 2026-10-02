import LambderCaller from "../client/LambderCaller.js";
import { withApiGroupCalls, } from "../shared/wire/LambderApiGroupCalls.js";
import { lambderHandlerTransport } from "../invoke/lambderHandlerTransport.js";
import { decodeLambdaHttpResult, localLambdaContext, synthesizeLambdaHttpEvent, } from "../invoke/LambderLambdaEvent.js";
import { LambderCookieJar } from "../shared/transport/LambderCookieJar.js";
import { lambderCookieJarTransport } from "../shared/transport/lambderCookieJarTransport.js";
import { assertApiSuccess } from "../shared/wire/LambderOutcomeAssertions.js";
import { DEFAULT_MAX_RESTORED_PAYLOAD_BYTES } from "../shared/wire/LambderRequestPayload.js";
/**
 * One simulated browser in front of a real Lambder app: a cookie jar, an
 * address and a host of its own, and two ways in. `api` / `apiOutcome` go
 * through a typed LambderCaller, over the real handler in this process, so a
 * call runs the whole pipeline (rate limits, session, replay, guards,
 * validation) the way a browser's would; `api` throws where the caller's
 * would hand back undefined. `request` is everything else a browser sends:
 * pages, redirects, session routes, file requests. Both carry the same jar,
 * so a session started through one is the session the other presents.
 *
 * Created by `LambderTestApp.visitor()` and `signIn()`, not constructed.
 */
class LambderTestVisitorCore {
    host;
    clientIp;
    /**
     * The typed caller `api` and `apiOutcome` run on, for code under test
     * that takes a LambderCaller itself (a frontend store, a shared client
     * module): handed this one, it talks to the real server in this process.
     * An answer's logList is not printed; it is on the outcome.
     */
    caller;
    /**
     * The endpoint's output; throws on every failure, with an Error that
     * names the endpoint and says what came back the way assertApiSuccess
     * does: the reason, the status, the refusal's code and message, and for
     * a crash the error the app threw, which is also the end of the Error's
     * cause chain. `apiOutcome` is for a test that expects a failure.
     */
    api;
    /**
     * The full outcome, never throwing: LambderCaller.apiOutcome, through
     * this visitor. Pair it with assertApiSuccess / assertApiFailure.
     *
     * When the app crashed answering the call, the outcome is the `server`
     * failure any client would get, whose error says only "Request failed:
     * 500"; here that error's `cause` is what the app actually threw, stack
     * included, so a failing test points at the line in the handler.
     */
    apiOutcome;
    #wiring;
    #headers;
    #cookieJar;
    #seenResetCount;
    constructor(wiring, options) {
        this.#wiring = wiring;
        this.host = options.host;
        this.clientIp = options.clientIp;
        this.#headers = options.headers ?? {};
        this.#cookieJar = new LambderCookieJar({ host: this.host });
        this.#seenResetCount = wiring.resetCount();
        const handlerTransport = lambderHandlerTransport(wiring.handler, { host: this.host, clientIp: this.clientIp, eventFormat: wiring.eventFormat });
        const withVisitorHeaders = (request) => handlerTransport({ ...request, headers: { ...this.#headers, ...request.headers } });
        this.caller = new LambderCaller({
            apiPath: wiring.apiPath,
            apiVersion: options.apiVersion,
            apiSignatures: options.apiSignatures,
            guardInputsProvider: options.guardInputsProvider,
            logListHandler: () => { },
            // The jar is read per call rather than captured, so a call made
            // after the test app was reset carries none of the old cookies.
            // The visitor's session lives in that jar, so a CSRF token the
            // caller read from a page's document.cookie (a test with a DOM)
            // is dropped and the jar's own is posted.
            transport: (request) => lambderCookieJarTransport(withVisitorHeaders, { jar: this.jar, host: this.host })({ ...request, token: "" }),
        });
        // The caller names the CSRF cookie the jar transport fills its token
        // from, so an app with custom session cookie names has to be matched
        // here or every session call would post an empty token.
        if (wiring.sessionCookieNames) {
            this.caller.setSessionCookieKey(wiring.sessionCookieNames.tokenCookieKey, wiring.sessionCookieNames.csrfCookieKey);
        }
        const caller = this.caller;
        const apiOutcome = async (apiName, ...callArgs) => {
            const { result: outcome, crash } = await wiring.watchCrash(() => caller.apiOutcome(apiName, ...callArgs));
            if (crash && !outcome.ok && "error" in outcome && outcome.error.cause === undefined)
                outcome.error.cause = crash;
            return outcome;
        };
        // The plain call reads as the output, so a failure has nowhere to go
        // but a throw. assertApiSuccess says what came back, as a test's own
        // assertion would; the endpoint's name says which step of a setup it
        // was.
        const api = async (apiName, ...callArgs) => {
            const outcome = await apiOutcome(apiName, ...callArgs);
            try {
                assertApiSuccess(outcome);
            }
            catch (err) {
                const described = err;
                throw new Error(`${apiName}: ${described.message}`, { cause: described.cause });
            }
            return outcome.payload;
        };
        this.api = api;
        this.apiOutcome = apiOutcome;
        // Each group of the contract through this visitor's own two calls:
        // visitor.orders.place(input) throws as visitor.api does, and
        // visitor.orders.place.outcome(input) carries the crash cause as
        // visitor.apiOutcome does.
        return withApiGroupCalls(this, (apiName, args) => api(apiName, ...args), (apiName, args) => apiOutcome(apiName, ...args));
    }
    /**
     * This visitor's cookies, to inspect or clear; every call and request
     * reads and fills them. The test app's reset() empties them, noticed here
     * the next time anything asks: a jar still holding the token of an
     * emptied store would read as signed in until an answer said otherwise.
     */
    get jar() {
        const resetCount = this.#wiring.resetCount();
        if (resetCount !== this.#seenResetCount) {
            this.#cookieJar.clear();
            this.#seenResetCount = resetCount;
        }
        return this.#cookieJar;
    }
    /**
     * One HTTP request to the app that is not an API call, answered by
     * whatever answers it in production: a route, a session route, the public
     * files, the index page, a fallback. The answer comes back decoded
     * (decompressed, headers lowercased), redirects are not followed, and
     * its Set-Cookie headers land in this visitor's jar.
     *
     * ```typescript
     * const page = await visitor.request("GET", "/orders?page=2");
     * expect(page.statusCode).toBe(200);
     * expect(page.text()).toContain("Your orders");
     * ```
     */
    async request(method, path, init = {}) {
        const queryStart = path.indexOf("?");
        const pathname = queryStart === -1 ? path : path.slice(0, queryStart);
        const query = {
            ...(queryStart === -1 ? {} : Object.fromEntries(new URLSearchParams(path.slice(queryStart + 1)))),
            ...init.query,
        };
        const cookieScope = { host: this.host, path: pathname };
        const event = synthesizeLambdaHttpEvent({
            method,
            path: pathname,
            query,
            host: this.host,
            headers: { ...this.#headers, ...init.headers },
            clientIp: this.clientIp,
            cookies: this.jar.cookiePairs(cookieScope),
            body: init.body,
        }, { invoke: false, eventFormat: this.#wiring.eventFormat });
        const result = await decodeLambdaHttpResult(await this.#wiring.handler(event, localLambdaContext("lambder-test")), DEFAULT_MAX_RESTORED_PAYLOAD_BYTES);
        if (result.cookies.length)
            this.jar.storeSetCookies(result.cookies, cookieScope);
        return result;
    }
    /**
     * Starts a session for this visitor without a login endpoint: minted by
     * the app's own session model, under its own cookie options, and planted
     * in this visitor's jar, so its next call is signed in. Returns the raw
     * tokens too, as LambderMockApp.signIn does.
     *
     * Throws when the cookies do not stick. An app that scopes its session
     * cookie to a domain (`cookie: { domain: ".example.com" }`) this visitor's
     * host is not under writes a cookie a browser on that host would drop, and
     * the jar drops it too; left silent, every later session call would
     * answer sessionExpired with nothing to say why.
     */
    async signIn(sessionKey, data, options = {}) {
        if (!this.#wiring.sessionCookieNames)
            throw new Error("LambderTestVisitor: signIn() needs an app with sessions. Pass the session option to create().");
        const { created, setCookies } = await this.#wiring.issueSession(this.host, sessionKey, data, options.ttlSeconds);
        this.jar.storeSetCookies(setCookies, { host: this.host });
        if (this.jar.get(this.#wiring.sessionCookieNames.tokenCookieKey, { host: this.host, includeHttpOnly: true }) === undefined) {
            throw new Error(`LambderTestVisitor: the session cookie did not stick for host "${this.host}", the way a browser on that host would drop it. ` +
                "The app most likely scopes its session cookie to a domain this host is not under: " +
                "give the test app or this visitor a `host` the cookie domain covers.");
        }
        return created;
    }
}
export const LambderTestVisitor = LambderTestVisitorCore;
