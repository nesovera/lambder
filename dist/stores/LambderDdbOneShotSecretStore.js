import { assertPartitionKeyFits, createDynamoClientLoader, isConditionalCheckFailure, } from "./LambderDdbSdk.js";
import { randomSecret } from "../shared/util/LambderSignedClaims.js";
/**
 * Why each item of a cancelled transaction was refused, in the order the
 * items were sent, or null when the error is not a cancelled transaction.
 */
const transactionCancellationReasons = (error) => {
    if (!error || typeof error !== "object" || error.name !== "TransactionCanceledException")
        return null;
    const reasons = error.CancellationReasons;
    return Array.isArray(reasons) ? reasons : [];
};
/**
 * Whether DynamoDB refused a write only because another transaction held one
 * of its items at that moment, so nothing was written and the write can be
 * sent again: a cancelled transaction whose reasons name a conflict and no
 * failed condition (a condition's answer stands), or a single-item write
 * refused while a transaction held its item.
 */
const isWriteConflict = (error) => {
    if (error?.name === "TransactionConflictException")
        return true;
    const reasons = transactionCancellationReasons(error);
    return !!reasons
        && reasons.some((reason) => reason.Code === "TransactionConflict")
        && !reasons.some((reason) => reason.Code === "ConditionalCheckFailed");
};
/** How many times a write refused for a conflict is sent, in all. */
const CONFLICT_ATTEMPTS = 3;
/**
 * Sends a write, and again when DynamoDB refused it for a conflict, which the
 * SDK does not retry: two issues for one scope at once (a resend tapped
 * twice), or two scopes racing for one digest. A short random pause first,
 * so two writers that met do not meet again in step. Past the last attempt
 * the conflict is thrown.
 */
const sendRetryingConflicts = async (write) => {
    for (let attempt = 1;; attempt += 1) {
        try {
            return await write();
        }
        catch (error) {
            if (attempt >= CONFLICT_ATTEMPTS || !isWriteConflict(error))
                throw error;
            await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40 * attempt));
        }
    }
};
/** A number attribute as stored, or the fallback when it is missing or not a number, since NaN compares false to everything. */
const storedNumber = (raw, fallback) => {
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
};
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
export class LambderDdbOneShotSecretStore {
    tableName;
    keyPrefix;
    ready;
    constructor(options) {
        if (!options.tableName.trim())
            throw new Error("tableName is required");
        this.tableName = options.tableName;
        this.keyPrefix = options.keyPrefix ?? "OTS";
        this.ready = createDynamoClientLoader({ user: "LambderDdbOneShotSecretStore", region: options.region, client: options.client });
    }
    scopeKey(scope) {
        return {
            pk: { S: assertPartitionKeyFits({ user: "LambderDdbOneShotSecretStore", what: "scope", partitionKey: `${this.keyPrefix}#scope#${scope}`, remedy: "Name the scope with an identifier rather than the data itself." }) },
            sk: { S: "secret" },
        };
    }
    digestKey(digest) {
        return { pk: { S: `${this.keyPrefix}#digest#${digest}` }, sk: { S: "secret" } };
    }
    /**
     * A stored item as a record, with every field checked rather than cast: an
     * item another writer left in a shared table, or a partial write, is a
     * record to refuse rather than to trust.
     */
    static recordOf(item) {
        const id = item?.id?.S;
        const kind = item?.kind?.S;
        const scope = item?.scope?.S;
        const digest = item?.digest?.S;
        if (!item || !id || !kind || scope === undefined || !digest)
            return null;
        let meta = {};
        try {
            const parsed = JSON.parse(item.metaJson?.S ?? "{}");
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                for (const [key, value] of Object.entries(parsed)) {
                    if (key !== "__proto__" && typeof value === "string")
                        meta[key] = value;
                }
            }
        }
        catch {
            meta = {};
        }
        return {
            id, kind, scope, digest,
            issuedAt: storedNumber(item.issuedAt?.N, 0),
            expiresAt: storedNumber(item.expiresAt?.N, 0),
            attempts: storedNumber(item.attempts?.N, 0),
            meta,
        };
    }
    async issue(draft, { unlessIssuedAfter }) {
        const { client, sdk } = await this.ready();
        const id = randomSecret(12);
        const scopePut = {
            TableName: this.tableName,
            Item: {
                ...this.scopeKey(draft.scope),
                id: { S: id },
                kind: { S: draft.kind },
                scope: { S: draft.scope },
                digest: { S: draft.digest },
                issuedAt: { N: String(draft.issuedAt) },
                expiresAt: { N: String(draft.expiresAt) },
                attempts: { N: "0" },
                metaJson: { S: JSON.stringify(draft.meta) },
            },
            // The cooldown, when there is one: an item with no issuedAt
            // (another writer's, or a partial write) never blocks a scope.
            ...(unlessIssuedAfter === undefined ? {} : {
                ConditionExpression: "attribute_not_exists(pk) OR attribute_not_exists(issuedAt) OR issuedAt <= :threshold",
                ExpressionAttributeValues: { ":threshold": { N: String(unlessIssuedAfter) } },
                ReturnValuesOnConditionCheckFailure: "ALL_OLD",
            }),
        };
        // Refused with no item to show for it: gone again by the time the
        // condition was read; the next call resolves it. Reported as issued
        // this very second, so the caller waits the whole cooldown.
        const cooldownRefusal = (refusedBy) => ({ issued: false, refused: "cooldown", issuedAt: storedNumber(refusedBy?.issuedAt?.N, draft.issuedAt) });
        if (draft.shape === "code") {
            try {
                await sendRetryingConflicts(() => client.send(new sdk.PutItemCommand(scopePut)));
            }
            catch (error) {
                if (!isConditionalCheckFailure(error))
                    throw error;
                return cooldownRefusal(error.Item);
            }
            return { issued: true, id };
        }
        try {
            await sendRetryingConflicts(() => client.send(new sdk.TransactWriteItemsCommand({
                TransactItems: [
                    { Put: scopePut },
                    {
                        Put: {
                            TableName: this.tableName,
                            Item: { ...this.digestKey(draft.digest), scope: { S: draft.scope }, expiresAt: { N: String(draft.expiresAt) } },
                            ConditionExpression: "attribute_not_exists(pk) OR #scope = :scope",
                            ExpressionAttributeNames: { "#scope": "scope" },
                            ExpressionAttributeValues: { ":scope": { S: draft.scope } },
                        },
                    },
                ],
            })));
        }
        catch (error) {
            const reasons = transactionCancellationReasons(error);
            if (!reasons)
                throw error;
            // The scope's own condition first: a scope inside its cooldown is
            // refused as that, whatever its draw collided with.
            if (reasons[0]?.Code === "ConditionalCheckFailed")
                return cooldownRefusal(reasons[0].Item);
            if (reasons[1]?.Code === "ConditionalCheckFailed")
                return { issued: false, refused: "digestTaken" };
            throw error;
        }
        return { issued: true, id };
    }
    async findByScope(scope) {
        const { client, sdk } = await this.ready();
        // Strongly consistent: a redeem that follows an issue by milliseconds
        // has to see the record the issue wrote.
        const found = await client.send(new sdk.GetItemCommand({ TableName: this.tableName, Key: this.scopeKey(scope), ConsistentRead: true }));
        return LambderDdbOneShotSecretStore.recordOf(found.Item);
    }
    async findByDigest(digest) {
        const { client, sdk } = await this.ready();
        const lookup = await client.send(new sdk.GetItemCommand({ TableName: this.tableName, Key: this.digestKey(digest), ConsistentRead: true }));
        const scope = lookup.Item?.scope?.S;
        if (scope === undefined)
            return null;
        const record = await this.findByScope(scope);
        return record && record.digest === digest ? record : null;
    }
    async attempt(scope, id) {
        const { client, sdk } = await this.ready();
        try {
            const counted = await sendRetryingConflicts(() => client.send(new sdk.UpdateItemCommand({
                TableName: this.tableName,
                Key: this.scopeKey(scope),
                UpdateExpression: "ADD attempts :one",
                ConditionExpression: "id = :id",
                ExpressionAttributeValues: { ":one": { N: "1" }, ":id": { S: id } },
                ReturnValues: "ALL_NEW",
            })));
            return LambderDdbOneShotSecretStore.recordOf(counted.Attributes);
        }
        catch (error) {
            if (!isConditionalCheckFailure(error))
                throw error;
            return null;
        }
    }
    async consume(scope, id) {
        const { client, sdk } = await this.ready();
        try {
            await sendRetryingConflicts(() => client.send(new sdk.DeleteItemCommand({
                TableName: this.tableName,
                Key: this.scopeKey(scope),
                ConditionExpression: "id = :id",
                ExpressionAttributeValues: { ":id": { S: id } },
            })));
            return true;
        }
        catch (error) {
            if (!isConditionalCheckFailure(error))
                throw error;
            return false;
        }
    }
    async retire(scope) {
        const { client, sdk } = await this.ready();
        // The digest item is left to TTL: it points at a scope whose record
        // is gone or replaced, and finds nothing either way.
        await sendRetryingConflicts(() => client.send(new sdk.DeleteItemCommand({ TableName: this.tableName, Key: this.scopeKey(scope) })));
    }
}
export default LambderDdbOneShotSecretStore;
