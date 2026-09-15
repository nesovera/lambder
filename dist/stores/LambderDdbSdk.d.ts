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
 * DynamoDB's own limit on a partition key, which every store's
 * `<keyPrefix>#<caller data>` key has to fit inside.
 */
export declare const MAX_PARTITION_KEY_BYTES = 2048;
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
export declare const assertPartitionKeyFits: (options: {
    user: string;
    what: string;
    partitionKey: string;
    remedy: string;
}) => string;
export {};
