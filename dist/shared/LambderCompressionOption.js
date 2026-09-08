/**
 * The compression option every part of Lambder speaks, and the one function
 * that resolves it.
 *
 * Five places compress something: sessions, LambderDdbCache and
 * LambderDdbIdempotency (Brotli at rest in DynamoDB), HTTP responses
 * (Brotli/gzip on the wire) and request payloads (gzip on the wire). They
 * differ in what they can be tuned with, so each declares its own settings
 * type, but they share one vocabulary and one resolution: `true` is on with
 * that site's defaults, `false` is off, an object overrides individual
 * fields, and `minBytes` is always the size from which a value is
 * compressed (0: always). Resolved settings are `null` when off, so every
 * consumer holds `Settings | null` and reads `minBytes` the same way.
 *
 * Nothing here touches zlib, so the browser entry can resolve the caller's
 * option without pulling Node built-ins into the bundle; the compression
 * primitives themselves live in LambderCompressionCodec, which does load zlib.
 */
/** Algorithms Lambder can produce. Brotli at rest and preferred on responses; gzip everywhere a browser has to do the compressing. */
export const LAMBDER_ENCODINGS = ["br", "gzip"];
/**
 * Resolves one site's option against its defaults: `null` when off,
 * otherwise the defaults with any supplied fields on top. `undefined` means
 * "unspecified", so a site whose default is off passes `option ?? false`
 * and one whose default is on passes the option through. A field set to
 * `undefined` inside the object is unspecified too, so `{ minBytes:
 * config.threshold }` with an optional threshold keeps the default.
 *
 * Validation is deliberately at resolution (construction) rather than at
 * use: a misconfigured threshold, quality or encoding list is a startup
 * error, not a surprise on some later request. The resolver knows the whole
 * shared vocabulary and checks each field a site carries.
 */
export const resolveCompressionOption = (option, defaults) => {
    if (option === false)
        return null;
    const config = option === true || option === undefined ? {} : option;
    const overrides = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
    const settings = { ...defaults, ...overrides };
    if (!Number.isSafeInteger(settings.minBytes) || settings.minBytes < 0) {
        throw new Error("compression.minBytes must be a non-negative integer");
    }
    if (settings.quality !== undefined && (!Number.isInteger(settings.quality) || settings.quality < 0 || settings.quality > 11)) {
        throw new Error("compression.quality must be an integer from 0 to 11");
    }
    if (settings.encodings !== undefined && (!Array.isArray(settings.encodings)
        || settings.encodings.length === 0
        || settings.encodings.some((encoding) => !LAMBDER_ENCODINGS.includes(encoding)))) {
        throw new Error(`compression.encodings must be a non-empty list of ${LAMBDER_ENCODINGS.map((e) => `"${e}"`).join(", ")}`);
    }
    return settings;
};
