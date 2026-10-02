import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { LambderOneShotIssueOutcome, LambderOneShotSecretDraft, LambderOneShotSecretRecord, LambderOneShotSecretStore } from "../shared/contracts/LambderOneShotSecretStore.js";
import { LAMBDER_BACKEND_SWAP } from "../shared/util/LambderTestingDoors.js";
export interface LambderDdbOneShotSecretStoreOptions {
    tableName: string;
    /** Region the client is created for on first use; the SDK's default chain otherwise. */
    region?: string;
    /** Partition key prefix, keeps secrets separated from other systems in a shared table. Default: "OTS". */
    keyPrefix?: string;
    client?: DynamoDBClient;
}
/**
 * One-shot secrets in DynamoDB, under the store's prefix, so the table can be
 * shared with LambderDdbRateLimiter (`RL#`) and LambderDdbIdempotencyStore
 * (`IDEM#`):
 *
 * - `<prefix>#scope#<scope>` / `secret`: the scope's current record. Issuing
 *   writes it over whatever was there, which is how the older secret is
 *   retired in the same act; a cooldown is a condition on that write
 *   (`issuedAt <= :threshold`), so of two callers racing past it exactly one
 *   is issued and the other reads when the winner was.
 * - `<prefix>#digest#<digest>` / `secret`, for a token alone: the scope the
 *   digest belongs to, which is how a token is found by its value. A code is
 *   found through its scope and has none. A token's two items are written in
 *   one transaction, the digest item conditioned on being free or already the
 *   scope's (`attribute_not_exists(pk) OR #scope = :scope`), so no two scopes
 *   share a digest and no issue leaves a record without its digest. A digest
 *   of a secret the scope has since replaced points at a record whose digest
 *   differs, and finds nothing; it stays claimed until TTL removes it, and a
 *   token drawn onto it is drawn again.
 *
 * A try is counted with a conditional `ADD`, on the record named and no
 * other, and the item comes back with the count already spent; a consume is a
 * conditional delete of the record named. Both are one request, which is what
 * makes them safe against a second caller. Every write DynamoDB refuses only
 * because a transaction held its item at that moment is sent again, up to
 * three times, since the SDK does not retry that refusal and nothing was
 * written. Items carry `expiresAt` for
 * DynamoDB TTL; the class decides expiry itself, since TTL deletion is lazy,
 * and an item TTL has not yet retired is what lets it answer "expired" rather
 * than "none".
 */
export declare class LambderDdbOneShotSecretStore implements LambderOneShotSecretStore {
    readonly tableName: string;
    readonly keyPrefix: string;
    private readonly ready;
    constructor(options: LambderDdbOneShotSecretStoreOptions);
    /**
     * Puts a memory twin under this store in place, for `lambder/testing`:
     * every LambderOneShotSecretStore member answers from the twin from then
     * on, so the LambderOneShotSecrets built over this store issues and
     * verifies in memory. Keyed by a symbol no entry point exports; see
     * registerSwappableInstance.
     */
    [LAMBDER_BACKEND_SWAP](twins: {
        oneShotSecretStore(): LambderOneShotSecretStore;
    }): void;
    private scopeKey;
    private digestKey;
    /**
     * A stored item as a record, with every field checked rather than cast: an
     * item another writer left in a shared table, or a partial write, is a
     * record to refuse rather than to trust.
     */
    private static recordOf;
    issue(draft: LambderOneShotSecretDraft, { unlessIssuedAfter }: {
        unlessIssuedAfter?: number;
    }): Promise<LambderOneShotIssueOutcome>;
    findByScope(scope: string): Promise<LambderOneShotSecretRecord | null>;
    findByDigest(digest: string): Promise<LambderOneShotSecretRecord | null>;
    attempt(scope: string, id: string): Promise<LambderOneShotSecretRecord | null>;
    consume(scope: string, id: string): Promise<boolean>;
    retire(scope: string): Promise<void>;
}
export default LambderDdbOneShotSecretStore;
