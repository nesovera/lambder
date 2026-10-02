import type { LambderApiRequest } from "../api/LambderApiRequest.js";
/**
 * The key of the door the mock's own adapters open on a LambderMockApp: what
 * an adapter asks of the runtime and tells it beyond handing it a call.
 *
 * A symbol rather than named members, and exported by no entry point: the
 * package's exports map is what a consumer can import, so only an adapter of
 * the package's own (the MSW handler) can name the key, and nothing on the
 * app's typed surface offers an app the adapter's bookkeeping as an API.
 */
export declare const LAMBDER_MOCK_ADAPTER_DOOR: unique symbol;
/** What a LambderMockApp answers to LAMBDER_MOCK_ADAPTER_DOOR. */
export type LambderMockAdapterDoor = {
    /**
     * Whether a call to this name would be answered from the registry, which
     * is what an adapter asks before passing one on. Asked once per request,
     * so not a list to scan.
     *
     * True for every name once a rest entry is registered, since it answers
     * whatever nothing else claimed. That makes a rest entry and the MSW
     * adapter's `onUnmocked: "passthrough"` alternatives rather than layers:
     * with one registered, nothing is handed on to the network.
     */
    hasRegisteredEntry(apiName: string): boolean;
    /**
     * Records a call the adapter handed on instead of answering: the MSW
     * adapter's passthrough. Without it a name the registry does not know
     * leaves no trace at all, and a mistyped endpoint reaches the real
     * network with nothing in the call log or on the subscription to say so,
     * which is the one failure the log exists to make visible.
     */
    notePassthrough(request: LambderApiRequest): void;
    /**
     * Mirrors an answer's non-HttpOnly cookies into document.cookie and
     * remembers them, so reset() expires them again. The direct transport's
     * "document" mode and the MSW adapter both come through the runtime's one
     * mirror, so there is one record of what was planted.
     */
    mirrorCookiesIntoDocument(setCookies: readonly string[]): void;
};
