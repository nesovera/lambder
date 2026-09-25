/**
 * The cache vocabulary every cache in Lambder shares: how an entry is
 * addressed, what writing and listing take, and the methods an app calls.
 *
 * Kept apart from LambderDdbCache for the reason the rate-limit and
 * idempotency contracts are: an app that types its caches against this
 * interface can hold a LambderMemoryCache in a test and a LambderDdbCache in
 * production without the test's import graph ever reaching the DynamoDB
 * store. Pure and dependency-free.
 */
export {};
