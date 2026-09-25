/**
 * A transport saying why it failed, instead of leaving the caller to assume.
 * Thrown by a transport; the caller reads `reason` and keeps `cause`, so the
 * thing that actually went wrong survives the trip.
 */
export class LambderTransportFailure extends Error {
    isLambderTransportFailure = true;
    reason;
    constructor(reason, message, options = {}) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = "LambderTransportFailure";
        this.reason = reason;
    }
}
/** Brand-based type guard, so a duplicate install of the package still matches. */
export const isLambderTransportFailure = (err) => err instanceof Error && err.isLambderTransportFailure === true;
/**
 * The fields of the request envelope, in wire order: the one statement of
 * what a call sends, for every sender.
 *
 * Two senders write it. A transport hands the payload over as a value
 * (buildTransportEnvelope, below); LambderInvokeCaller has already serialized
 * its payload to decide on compression, and splices that JSON onto the end
 * rather than parsing and stringifying it again (buildEnvelopeJson, in
 * invoke/LambderLambdaEvent.ts). The splice builds on this function so a new
 * envelope field cannot reach one sender and miss the other, which nothing on
 * the wire would catch.
 */
export const buildEnvelopeFields = (fields) => ({
    apiName: fields.apiName,
    version: fields.version,
    ...(fields.signature !== undefined ? { signature: fields.signature } : {}),
    token: fields.token,
    siteHost: fields.siteHost,
    ...(fields.compressed ?? fields.payloadSlot ?? {}),
    ...(fields.guardInputs !== undefined ? { guardInputs: fields.guardInputs } : {}),
    ...(fields.idempotencyKey !== undefined ? { idempotencyKey: fields.idempotencyKey } : {}),
});
/**
 * The body envelope every transport posts, as a plain object: the same
 * fields whichever transport carries them, so the server and the mock
 * runtime read one shape.
 */
export const buildTransportEnvelope = (request) => buildEnvelopeFields({
    apiName: request.apiName,
    version: request.version,
    signature: request.signature,
    token: request.token,
    siteHost: request.siteHost,
    payloadSlot: { payload: request.payload },
    compressed: request.compressed,
    guardInputs: request.guardInputs,
    idempotencyKey: request.idempotencyKey,
});
export const resolveApiPathTarget = (apiPath) => {
    // Only an absolute URL carries a host. Parsing "/api" would need a base,
    // and inventing one invents a host to go with it.
    if (!/^https?:\/\//i.test(apiPath))
        return { path: apiPath };
    try {
        const url = new URL(apiPath);
        return { host: url.hostname, path: url.pathname, secure: url.protocol === "https:" };
    }
    catch {
        return { path: apiPath };
    }
};
