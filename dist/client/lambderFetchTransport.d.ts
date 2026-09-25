import type { LambderApiTransport } from "../shared/transport/LambderApiTransport.js";
/**
 * The production transport: one POST of the envelope to the API path over
 * fetch, with the cookie and CORS behaviour a browser call needs. The
 * caller's default, built from its isCorsEnabled option. `cors` defaults to
 * whether the call's apiPath is on another origin than the page's: a browser
 * refuses a same-origin mode request to another origin outright, and a
 * credentialed cross-origin one is what a separate API host needs.
 */
export declare const lambderFetchTransport: (options?: {
    cors?: boolean;
}) => LambderApiTransport;
