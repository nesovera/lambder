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
 */
let clientSdk;
let documentSdk;
const withInstallHint = (loading, packageName, user, reset) => loading.catch((cause) => {
    // Not memoized: the package may be installed later in the same process (tests), and the next caller names itself.
    reset();
    throw new Error(`${user} requires ${packageName}: npm install ${packageName}`, { cause });
});
/** `@aws-sdk/client-dynamodb`, for the item-level API the stores speak and the client the session manager wraps. */
export const loadDynamoClientSdk = (user) => {
    clientSdk ??= withInstallHint(import("@aws-sdk/client-dynamodb"), "@aws-sdk/client-dynamodb", user, () => { clientSdk = undefined; });
    return clientSdk;
};
/** `@aws-sdk/lib-dynamodb`, the document client the session manager reads and writes through. */
export const loadDynamoDocumentSdk = (user) => {
    documentSdk ??= withInstallHint(import("@aws-sdk/lib-dynamodb"), "@aws-sdk/lib-dynamodb", user, () => { documentSdk = undefined; });
    return documentSdk;
};
