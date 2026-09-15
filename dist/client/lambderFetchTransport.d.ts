import type { LambderApiTransport } from "../shared/transport/LambderApiTransport.js";
/**
 * The production transport: one POST of the envelope to the API path over
 * fetch, with the cookie and CORS behaviour a browser call needs. The
 * caller's default, built from its isCorsEnabled option.
 */
export declare const lambderFetchTransport: (options?: {
    cors?: boolean;
}) => LambderApiTransport;
