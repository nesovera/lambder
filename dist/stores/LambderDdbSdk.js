/**
 * The DynamoDB SDK, loaded on first use.
 *
 * `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` are optional peer
 * dependencies, and an app that keeps no sessions and uses none of the
 * DynamoDB stores should neither install them nor pay for loading them: a
 * module-level import costs every cold start something and, bundled, makes
 * every Lambder app reference both packages. So the session manager and the
 * three stores import their types only and take the classes from here the
 * first time they touch the table, the way LambderS3FileSource and
 * LambderInvokeCaller load theirs. One loader per package, memoized for the
 * container's life; a missing package fails that first call with the
 * install hint rather than failing the import of lambder itself.
 *
 * The two facts about DynamoDB itself that every one of those stores has to
 * agree on live here as well, for the same reason: a conditional write's
 * refusal is an answer rather than a failure, and a partition key has a
 * limit that the caller data these stores build keys from can pass.
 */
let clientSdk;
let documentSdk;
const withInstallHint = (loading, packageName, user, reset) => loading.catch((cause) => {
    // Not memoized: the package may be installed later in the same process (tests), and the next caller names itself.
    reset();
    throw new Error(`${user} requires ${packageName}: npm install ${packageName}`, { cause });
});
/** `@aws-sdk/client-dynamodb`, for the item-level API the stores speak and the client the session manager wraps. */
const loadDynamoClientSdk = (user) => {
    clientSdk ??= withInstallHint(import("@aws-sdk/client-dynamodb"), "@aws-sdk/client-dynamodb", user, () => { clientSdk = undefined; });
    return clientSdk;
};
/** `@aws-sdk/lib-dynamodb`, the document client the session manager reads and writes through. */
const loadDynamoDocumentSdk = (user) => {
    documentSdk ??= withInstallHint(import("@aws-sdk/lib-dynamodb"), "@aws-sdk/lib-dynamodb", user, () => { documentSdk = undefined; });
    return documentSdk;
};
/**
 * The "ready" step each DynamoDB-backed store runs before its first table
 * call: load the SDK, then take the client the app supplied or build one.
 * Memoized for the store's life, and a FAILED load is deliberately not, so a
 * store that ran before the package was installed asks again rather than
 * caching the install hint for ever.
 *
 * Written once because four stores had written it for themselves and had
 * already drifted apart on the region: three passed the SDK's default chain
 * through and the cache pinned `us-east-1`, so one store out of four ignored
 * the deployment's own region.
 *
 * `region` absent means the SDK's default chain (`AWS_REGION`, the Lambda
 * environment, the shared config file), which is what a store should leave
 * alone unless the caller names one.
 */
export const createDynamoClientLoader = (options) => {
    let readyPromise;
    return () => {
        readyPromise ??= loadDynamoClientSdk(options.user)
            .then((sdk) => ({ sdk, client: options.client ?? new sdk.DynamoDBClient(options.region ? { region: options.region } : {}) }))
            .catch((error) => { readyPromise = undefined; throw error; });
        return readyPromise;
    };
};
/**
 * The document-client twin of createDynamoClientLoader, for the one store
 * that speaks the document API. A supplied client is taken as is, and then
 * only `@aws-sdk/lib-dynamodb` is loaded: the item-level package is needed
 * only to construct a client of our own.
 */
export const createDynamoDocumentClientLoader = (options) => {
    let readyPromise;
    const build = async () => {
        if (options.client)
            return { sdk: await loadDynamoDocumentSdk(options.user), client: options.client };
        const [clientSdk, sdk] = await Promise.all([loadDynamoClientSdk(options.user), loadDynamoDocumentSdk(options.user)]);
        return { sdk, client: sdk.DynamoDBDocumentClient.from(new clientSdk.DynamoDBClient(options.region ? { region: options.region } : {})) };
    };
    return () => {
        readyPromise ??= build().catch((error) => { readyPromise = undefined; throw error; });
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
/**
 * DynamoDB's own limit on a partition key, which every store's
 * `<keyPrefix>#<caller data>` key has to fit inside.
 */
export const MAX_PARTITION_KEY_BYTES = 2048;
/**
 * The partition key, or a refusal naming the byte count. Every store here
 * builds its key out of caller data (an idempotency key and the identity it
 * is scoped by, a rate-limit key a policy handler returned), so the length is
 * the caller's to reach and this is the one place that measures it.
 *
 * Checked rather than left to DynamoDB, which answers an over-long key with a
 * ValidationException: that is not a ConditionalCheckFailedException, so it
 * escapes as a store error that reads as "the table is broken" and, under a
 * fail-open setting, is swallowed into no protection at all. The message
 * carries the count and never the key, because it reaches a log.
 */
export const assertPartitionKeyFits = (options) => {
    const partitionKeyBytes = Buffer.byteLength(options.partitionKey, "utf8");
    if (partitionKeyBytes > MAX_PARTITION_KEY_BYTES) {
        throw new Error(`${options.user}: the ${options.what} is ${partitionKeyBytes} bytes with its prefix, over DynamoDB's ${MAX_PARTITION_KEY_BYTES}-byte partition key limit. ${options.remedy}`);
    }
    return options.partitionKey;
};
