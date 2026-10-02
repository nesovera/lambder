/**
 * The DynamoDB SDK, loaded on first use.
 *
 * `@aws-sdk/client-dynamodb` is an optional peer dependency: an app that uses
 * no DynamoDB store should neither install it nor pay for loading it, and a
 * module-level import would cost every cold start and make every bundled
 * Lambder app reference it. So the stores import its types only and take the
 * classes from here the first time they touch the table, as
 * LambderS3FileSource and LambderInvokeCaller do. One loader, memoized for
 * the container's life; a missing package fails that first call with the
 * install hint rather than failing the import of lambder itself.
 *
 * Every store speaks the item-level API, attribute values and all, so they
 * take one client type and need one package. The session store, the one
 * whose items hold an app's JSON, converts it with marshallJsonValue and
 * unmarshallJsonValue below, so no store needs `@aws-sdk/lib-dynamodb`.
 *
 * The facts about DynamoDB itself that every store must agree on live here
 * too: a conditional write's refusal is an answer rather than a failure, a
 * partition key and an item each have a limit that caller data can pass, and
 * a number attribute read back may be missing or not a number.
 */
import { withInstallHint } from "./LambderSdkInstallHint.js";
let clientSdk;
/** `@aws-sdk/client-dynamodb`, for the item-level API every store speaks. */
const loadDynamoClientSdk = (user) => {
    clientSdk ??= withInstallHint(import("@aws-sdk/client-dynamodb"), "@aws-sdk/client-dynamodb", user, () => { clientSdk = undefined; });
    return clientSdk;
};
/**
 * The default clients, one per region ("" for the SDK's default chain),
 * shared by every store not given a client of its own. A client is a
 * connection pool and a credential chain: sessions, rate limits,
 * idempotency and the cache building one each would mean four pools and, on
 * a cold container, four TLS handshakes and credential lookups inside the
 * first request.
 */
const defaultClients = new Map();
const defaultClientFor = (sdk, region) => {
    let client = defaultClients.get(region ?? "");
    if (!client) {
        client = new sdk.DynamoDBClient(region ? { region } : {});
        defaultClients.set(region ?? "", client);
    }
    return client;
};
/**
 * The "ready" step each DynamoDB-backed store runs before its first table
 * call: load the SDK, then take the client the app supplied or the shared
 * default one for the store's region. Memoized for the store's life, except
 * that a FAILED load is not, so a store that ran before the package was
 * installed asks again rather than caching the install hint forever.
 *
 * One implementation for every store, so they cannot drift apart on the
 * region. `region` absent means the SDK's default chain (`AWS_REGION`, the
 * Lambda environment, the shared config file); a store leaves it alone
 * unless the caller names one, since pinning one (say `us-east-1`) would
 * ignore the deployment's own region.
 */
export const createDynamoClientLoader = (options) => {
    let readyPromise;
    return () => {
        readyPromise ??= loadDynamoClientSdk(options.user)
            .then((sdk) => ({ sdk, client: options.client ?? defaultClientFor(sdk, options.region) }))
            .catch((error) => { readyPromise = undefined; throw error; });
        return readyPromise;
    };
};
/**
 * Whether DynamoDB refused a write because its condition did not hold, which
 * is how every conditional write here reports the thing it was testing for: a
 * claim already taken, a counter at its limit, a lease somebody else holds.
 * An answer, not a failure, so it is the one error class these stores catch
 * and the reason they must not catch any other.
 */
export const isConditionalCheckFailure = (error) => !!error && typeof error === "object" && "name" in error && error.name === "ConditionalCheckFailedException";
/** DynamoDB's names for "too many requests": a hot partition, the table's or account's throughput, the request rate. */
const THROTTLE_ERROR_NAMES = ["ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded"];
/**
 * Whether DynamoDB refused a request, after the SDK's own retries, because
 * of the rate at one key range, rather than the table's or the account's.
 * A key range is a partition, which holds many keys, so the throttle falls
 * on the key asked about and on its neighbours alike: whether this key is
 * the one flooding it is the caller's to find out.
 *
 * Every throttle names why in its ThrottlingReasons (throttlingReasons on a
 * ThrottlingException), as `<Table|Index><Read|Write><LimitType>`; only
 * KeyRangeThroughputExceeded is about one partition. The other limit types
 * (ProvisionedThroughputExceeded, AccountLimitExceeded,
 * MaxOnDemandThroughputExceeded) are the table or the account running out,
 * which says nothing about any one partition. An SDK older than the reasons
 * (`@aws-sdk/client-dynamodb` before 3.868.0, the peer dependency's
 * minimum), or a local DynamoDB, names none, and reads as not a key range's.
 */
export const isKeyRangeThrottle = (error) => {
    if (!error || typeof error !== "object" || !("name" in error) || !THROTTLE_ERROR_NAMES.includes(String(error.name)))
        return false;
    const { ThrottlingReasons, throttlingReasons } = error;
    const reasons = ThrottlingReasons ?? throttlingReasons;
    return Array.isArray(reasons)
        && reasons.some((reason) => typeof reason?.reason === "string" && reason.reason.endsWith("KeyRangeThroughputExceeded"));
};
/**
 * DynamoDB's own limit on a partition key, which every store's
 * `<keyPrefix>#<caller data>` key has to fit inside.
 */
export const MAX_PARTITION_KEY_BYTES = 2048;
/**
 * The partition key, or a refusal naming the byte count. Every store here
 * builds its key from caller data (an idempotency key and the identity it is
 * scoped by, a rate-limit key a policy handler returned), so the length is
 * the caller's to reach and this is the one place that measures it.
 *
 * Checked here because DynamoDB answers an over-long key with a
 * ValidationException, not a ConditionalCheckFailedException: it would
 * escape as a store error that reads as "the table is broken" and, under a
 * fail-open setting, be swallowed into no protection at all. The message
 * carries the count and never the key, because it reaches a log.
 */
export const assertPartitionKeyFits = (options) => {
    const partitionKeyBytes = Buffer.byteLength(options.partitionKey, "utf8");
    if (partitionKeyBytes > MAX_PARTITION_KEY_BYTES) {
        throw new Error(`${options.user}: the ${options.what} is ${partitionKeyBytes} bytes with its prefix, over DynamoDB's ${MAX_PARTITION_KEY_BYTES}-byte partition key limit. ${options.remedy}`);
    }
    return options.partitionKey;
};
/** DynamoDB's own limit on one item, its attribute names and values together: 400 KB. */
export const MAX_ITEM_BYTES = 400 * 1024;
/**
 * The significant digits of a number attribute's text: what DynamoDB stores
 * of it. Leading and trailing zeroes are not stored, nor are the sign, the
 * point and an exponent.
 */
const significantDigits = (numberText) => Math.max(numberText.replace(/^[-+]/, "").split(/e/i)[0].replace(".", "").replace(/^0+/, "").replace(/0+$/, "").length, 1);
/**
 * The size DynamoDB counts for one attribute value against its item limit: a
 * string's UTF-8 bytes, a binary's bytes, one byte for a boolean or null, a
 * byte per two significant digits of a number and one more, and for a map
 * or a list three bytes plus, per element, one byte, its name (a map's) and
 * its value. These are the rules DynamoDB states for its item limit, so a
 * store can refuse an item by its size before the table answers it with a
 * ValidationException, which is not a ConditionalCheckFailedException and
 * so escapes as a store error that names nothing the app can act on. The
 * set types are sized nowhere because no store writes one.
 */
export const attributeValueBytes = (value) => {
    if (value.S !== undefined)
        return Buffer.byteLength(value.S, "utf8");
    if (value.N !== undefined)
        return Math.ceil(significantDigits(value.N) / 2) + 1;
    if (value.B !== undefined)
        return value.B.byteLength;
    if (value.BOOL !== undefined || value.NULL !== undefined)
        return 1;
    if (value.L !== undefined)
        return value.L.reduce((total, element) => total + 1 + attributeValueBytes(element), 3);
    if (value.M !== undefined) {
        return Object.entries(value.M).reduce((total, [name, element]) => total + 1 + Buffer.byteLength(name, "utf8") + attributeValueBytes(element), 3);
    }
    throw new Error(`attributeValueBytes cannot size an attribute of type ${Object.keys(value).join(", ") || "none"}`);
};
/**
 * A JSON value as the attribute DynamoDB keeps it: a string as `S`, a number
 * as `N` in its shortest round-trip text, a boolean as `BOOL`, null as
 * `NULL`, an array as `L` and an object as `M`. This is what
 * `@aws-sdk/lib-dynamodb`'s document client writes for the same value, so an
 * item written either way reads back through unmarshallJsonValue.
 *
 * JSON only, as the name says: anything JSON.parse cannot hand back (an
 * undefined, a non-finite number, a function, a Set, a class instance) is
 * refused rather than guessed at. Map entries are built with
 * Object.fromEntries so that a `__proto__` key, which JSON.parse keeps as an
 * own key, stays an entry rather than setting the prototype of the map.
 */
export const marshallJsonValue = (value) => {
    if (value === null)
        return { NULL: true };
    if (typeof value === "string")
        return { S: value };
    if (typeof value === "boolean")
        return { BOOL: value };
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            throw new Error(`marshallJsonValue cannot store the number ${value}: JSON has no such value.`);
        return { N: String(value) };
    }
    if (Array.isArray(value))
        return { L: value.map(marshallJsonValue) };
    if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
        return { M: Object.fromEntries(Object.entries(value).map(([name, element]) => [name, marshallJsonValue(element)])) };
    }
    throw new Error(`marshallJsonValue cannot store a value of type ${value === undefined ? "undefined" : typeof value}: it is not JSON.`);
};
/**
 * The JSON value an attribute holds: the inverse of marshallJsonValue, and
 * the reading of what the document client wrote for one. A number reads as
 * the JS number its text names, as JSON.parse would read the same text. An
 * attribute JSON has no form for (a binary, a set) throws: it was not
 * written from JSON, so it is not this store's.
 */
export const unmarshallJsonValue = (attribute) => {
    if (attribute.S !== undefined)
        return attribute.S;
    if (attribute.N !== undefined)
        return Number(attribute.N);
    if (attribute.BOOL !== undefined)
        return attribute.BOOL;
    if (attribute.NULL !== undefined)
        return null;
    if (attribute.L !== undefined)
        return attribute.L.map(unmarshallJsonValue);
    if (attribute.M !== undefined) {
        return Object.fromEntries(Object.entries(attribute.M).map(([name, element]) => [name, unmarshallJsonValue(element)]));
    }
    throw new Error(`unmarshallJsonValue cannot read an attribute of type ${Object.keys(attribute).join(", ") || "none"} as JSON.`);
};
/**
 * A number attribute as stored, or the fallback when it is missing or not a
 * number. `Number(undefined)` and `Number("nope")` are both NaN, which every
 * later comparison answers false to: a NaN expiry reads as "not expired" and
 * a NaN status code reaches the client as one.
 */
export const storedNumber = (raw, fallback) => {
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
};
