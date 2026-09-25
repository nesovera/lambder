/**
 * The DynamoDB SDK, loaded on first use.
 *
 * `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` are optional peer
 * dependencies: an app that uses no DynamoDB store should neither install
 * them nor pay for loading them, and a module-level import would cost every
 * cold start and make every bundled Lambder app reference both packages. So
 * the session manager and the stores import their types only and take the
 * classes from here the first time they touch the table, as
 * LambderS3FileSource and LambderInvokeCaller do. One loader per package,
 * memoized for the container's life; a missing package fails that first call
 * with the install hint rather than failing the import of lambder itself.
 *
 * The facts about DynamoDB itself that every store must agree on live here
 * too: a conditional write's refusal is an answer rather than a failure, and
 * a partition key has a limit that keys built from caller data can pass.
 */

import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

type LambderDynamoClientSdk = typeof import("@aws-sdk/client-dynamodb");
type LambderDynamoDocumentSdk = typeof import("@aws-sdk/lib-dynamodb");

let clientSdk: Promise<LambderDynamoClientSdk> | undefined;
let documentSdk: Promise<LambderDynamoDocumentSdk> | undefined;

const withInstallHint = <T>(loading: Promise<T>, packageName: string, user: string, reset: () => void): Promise<T> =>
    loading.catch((cause: unknown) => {
        // Not memoized: the package may be installed later in the same process (tests), and the next caller names itself.
        reset();
        throw new Error(`${user} requires ${packageName}: npm install ${packageName}`, { cause });
    });

/** `@aws-sdk/client-dynamodb`, for the item-level API the stores speak and the client the session manager wraps. */
const loadDynamoClientSdk = (user: string): Promise<LambderDynamoClientSdk> => {
    clientSdk ??= withInstallHint(import("@aws-sdk/client-dynamodb"), "@aws-sdk/client-dynamodb", user, () => { clientSdk = undefined; });
    return clientSdk;
};

/** `@aws-sdk/lib-dynamodb`, the document client the session manager reads and writes through. */
const loadDynamoDocumentSdk = (user: string): Promise<LambderDynamoDocumentSdk> => {
    documentSdk ??= withInstallHint(import("@aws-sdk/lib-dynamodb"), "@aws-sdk/lib-dynamodb", user, () => { documentSdk = undefined; });
    return documentSdk;
};

/**
 * The default clients, one per region ("" for the SDK's default chain),
 * shared by every store not given a client of its own. A client is a
 * connection pool and a credential chain: sessions, rate limits,
 * idempotency and the cache building one each would mean four pools and, on
 * a cold container, four TLS handshakes and credential lookups inside the
 * first request.
 */
const defaultClients = new Map<string, DynamoDBClient>();
const defaultDocumentClients = new Map<string, DynamoDBDocumentClient>();

const defaultClientFor = (sdk: LambderDynamoClientSdk, region: string | undefined): DynamoDBClient => {
    let client = defaultClients.get(region ?? "");
    if(!client){
        client = new sdk.DynamoDBClient(region ? { region } : {});
        defaultClients.set(region ?? "", client);
    }
    return client;
};

/** What every DynamoDB-backed store needs before it can touch its table: the SDK, and a client made with it. */
export type LambderDynamoClientReady = { client: DynamoDBClient; sdk: LambderDynamoClientSdk };

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
export const createDynamoClientLoader = (
    options: { user: string; region?: string; client?: DynamoDBClient },
): (() => Promise<LambderDynamoClientReady>) => {
    let readyPromise: Promise<LambderDynamoClientReady> | undefined;
    return () => {
        readyPromise ??= loadDynamoClientSdk(options.user)
            .then((sdk) => ({ sdk, client: options.client ?? defaultClientFor(sdk, options.region) }))
            .catch((error: unknown) => { readyPromise = undefined; throw error; });
        return readyPromise;
    };
};

/** What the session store needs before its first table call: the document SDK, and a document client made with it. */
export type LambderDynamoDocumentClientReady = { client: DynamoDBDocumentClient; sdk: LambderDynamoDocumentSdk };

/**
 * The document-client twin of createDynamoClientLoader, for the one store
 * that speaks the document API. A supplied client is taken as is, and then
 * only `@aws-sdk/lib-dynamodb` is loaded: the item-level package is needed
 * only to construct a client of our own.
 */
export const createDynamoDocumentClientLoader = (
    options: { user: string; region?: string; client?: DynamoDBDocumentClient },
): (() => Promise<LambderDynamoDocumentClientReady>) => {
    let readyPromise: Promise<LambderDynamoDocumentClientReady> | undefined;
    const build = async (): Promise<LambderDynamoDocumentClientReady> => {
        if(options.client) return { sdk: await loadDynamoDocumentSdk(options.user), client: options.client };
        const [clientSdk, sdk] = await Promise.all([loadDynamoClientSdk(options.user), loadDynamoDocumentSdk(options.user)]);
        // Over the same shared client the item-level stores use, so the
        // session store's calls go through that one connection pool too.
        let client = defaultDocumentClients.get(options.region ?? "");
        if(!client){
            client = sdk.DynamoDBDocumentClient.from(defaultClientFor(clientSdk, options.region));
            defaultDocumentClients.set(options.region ?? "", client);
        }
        return { sdk, client };
    };
    return () => {
        readyPromise ??= build().catch((error: unknown) => { readyPromise = undefined; throw error; });
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
export const isConditionalCheckFailure = (error: unknown): boolean =>
    !!error && typeof error === "object" && "name" in error && error.name === "ConditionalCheckFailedException";

/** DynamoDB's names for "too many requests": a hot partition, the table's or account's throughput, the request rate. */
const THROTTLE_ERROR_NAMES: readonly string[] = ["ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded"];

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
export const isKeyRangeThrottle = (error: unknown): boolean => {
    if(!error || typeof error !== "object" || !("name" in error) || !THROTTLE_ERROR_NAMES.includes(String(error.name))) return false;
    const { ThrottlingReasons, throttlingReasons } = error as { ThrottlingReasons?: unknown; throttlingReasons?: unknown };
    const reasons = ThrottlingReasons ?? throttlingReasons;
    return Array.isArray(reasons)
        && reasons.some((reason: { reason?: unknown } | null) => typeof reason?.reason === "string" && reason.reason.endsWith("KeyRangeThroughputExceeded"));
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
export const assertPartitionKeyFits = (
    options: { user: string, what: string, partitionKey: string, remedy: string },
): string => {
    const partitionKeyBytes = Buffer.byteLength(options.partitionKey, "utf8");
    if(partitionKeyBytes > MAX_PARTITION_KEY_BYTES){
        throw new Error(`${options.user}: the ${options.what} is ${partitionKeyBytes} bytes with its prefix, over DynamoDB's ${MAX_PARTITION_KEY_BYTES}-byte partition key limit. ${options.remedy}`);
    }
    return options.partitionKey;
};
