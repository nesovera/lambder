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
/** What every DynamoDB-backed store needs before it can touch its table: the SDK, and a client made with it. */
export type LambderDynamoClientReady = {
    client: DynamoDBClient;
    sdk: LambderDynamoClientSdk;
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
export declare const createDynamoClientLoader: (options: {
    user: string;
    region?: string;
    client?: DynamoDBClient;
}) => (() => Promise<LambderDynamoClientReady>);
/** What the session store needs before its first table call: the document SDK, and a document client made with it. */
export type LambderDynamoDocumentClientReady = {
    client: DynamoDBDocumentClient;
    sdk: LambderDynamoDocumentSdk;
};
/**
 * The document-client twin of createDynamoClientLoader, for the one store
 * that speaks the document API. A supplied client is taken as is, and then
 * only `@aws-sdk/lib-dynamodb` is loaded: the item-level package is needed
 * only to construct a client of our own.
 */
export declare const createDynamoDocumentClientLoader: (options: {
    user: string;
    region?: string;
    client?: DynamoDBDocumentClient;
}) => (() => Promise<LambderDynamoDocumentClientReady>);
/**
 * Whether DynamoDB refused a write because its condition did not hold, which
 * is how every conditional write here reports the thing it was testing for: a
 * claim already taken, a counter at its limit, a lease somebody else holds.
 * An answer, not a failure, so it is the one error class these stores catch
 * and the reason they must not catch any other.
 */
export declare const isConditionalCheckFailure: (error: unknown) => boolean;
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
export declare const isKeyRangeThrottle: (error: unknown) => boolean;
/**
 * DynamoDB's own limit on a partition key, which every store's
 * `<keyPrefix>#<caller data>` key has to fit inside.
 */
export declare const MAX_PARTITION_KEY_BYTES = 2048;
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
export declare const assertPartitionKeyFits: (options: {
    user: string;
    what: string;
    partitionKey: string;
    remedy: string;
}) => string;
export {};
