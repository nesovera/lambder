/**
 * The keys of the two doors `lambder/testing` opens on a built instance.
 *
 * Symbols rather than named methods, and exported by no entry point: the
 * package's exports map is what a consumer can import, so only
 * `lambder/testing` can name a key, and nothing on the typed surface of an
 * instance offers either door to a serving app.
 */
/**
 * Puts other stores under the instance.
 *
 * An app is one module-level instance whose handlers and guards close over it
 * (`app.getSessionController(ctx)`), so a test cannot be handed a copy over
 * other stores: the copy's closures would still reach the original and the
 * production table under it. The stores are therefore replaced in place, and
 * every class that holds one answers to this key with a method that takes the
 * replacement.
 */
export const LAMBDER_BACKEND_SWAP = Symbol("lambder.backendSwap");
/**
 * Watches what the instance throws while answering a request.
 *
 * A crash is answered by the app's global error handler, or by the framework's
 * own 500, and either way the answer deliberately says nothing about what was
 * thrown: that is right for a client and useless to a test, whose author needs
 * the error and its stack. The watcher is handed the error and changes nothing
 * about the answer, so what an app does with a crash stays testable.
 */
export const LAMBDER_CRASH_WATCH = Symbol("lambder.crashWatch");
