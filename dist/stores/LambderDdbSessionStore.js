import { createDynamoDocumentClientLoader, isConditionalCheckFailure } from "./LambderDdbSdk.js";
import { compressText, restoreText } from "../shared/wire/LambderCompressionCodec.js";
import { resolveCompressionOption, } from "../shared/wire/LambderCompressionOption.js";
/**
 * Session compression defaults: every record compressed (see
 * LambderCompressionOption for the option's shape and toggle semantics).
 * A compressed record carries the data's JSON as Brotli bytes (`dataBr`)
 * beside its byte length (`dataBytes`), the scheme LambderDdbCache and
 * LambderDdbIdempotencyStore use; below minBytes, or with compression off, the
 * record keeps a plain `data` attribute.
 */
const SESSION_COMPRESSION_DEFAULTS = { minBytes: 0, quality: 5 };
/**
 * Sessions at rest in DynamoDB: one item per session under the two hashes,
 * with session.data Brotli-compressed by default. The store maps the
 * manager's record onto the table's own key attribute names and back, and
 * owns nothing of the session model itself.
 *
 * Table shape: a string hash key (the salted sessionKey hash, every session
 * of one subject shares it) and a string range key (the bearer secret's
 * hash), plus a TTL on `expiresAt` to let DynamoDB sweep expired sessions.
 */
export class LambderDdbSessionStore {
    /** DynamoDB keeps records after this process is gone. */
    isMemoryOnly = false;
    tableName;
    partitionKey;
    sortKey;
    compression;
    /** The SDK and the client, loaded and created the first time the table is touched (see LambderDdbSdk). */
    ready;
    constructor(options) {
        if (!options.tableName.trim())
            throw new Error("tableName is required");
        this.tableName = options.tableName;
        this.partitionKey = options.partitionKey ?? "pk";
        this.sortKey = options.sortKey ?? "sk";
        this.compression = resolveCompressionOption(options.compression, SESSION_COMPRESSION_DEFAULTS);
        this.ready = createDynamoDocumentClientLoader({
            user: "LambderDdbSessionStore",
            ...(options.region !== undefined ? { region: options.region } : {}),
            ...(options.client ? { client: options.client } : {}),
        });
    }
    keyOf(sessionKeyHash, secretHash) {
        return { [this.partitionKey]: sessionKeyHash, [this.sortKey]: secretHash };
    }
    /** The item for a record: the two hashes under the table's key names, the data plain or compressed. */
    async toItem(record) {
        const { sessionKeyHash, secretHash, data, ...rest } = record;
        const item = { ...this.keyOf(sessionKeyHash, secretHash), ...rest };
        const raw = this.compression && Buffer.from(JSON.stringify(data), "utf8");
        if (this.compression && raw && raw.byteLength >= this.compression.minBytes) {
            item.dataBr = await compressText(raw, "br", this.compression.quality);
            item.dataBytes = raw.byteLength;
        }
        else {
            item.data = data;
        }
        return item;
    }
    /**
     * The record for an item. A compressed record decodes back into `data`;
     * one whose data cannot be decoded is a malformed record and reads as no
     * session, the same as a record missing its csrfTokenHash.
     *
     * Read failures and malformed records have to stay apart, and this is the
     * seam where they separate. A read failure is infrastructure and must
     * surface as a 500, because signing somebody out over a transient
     * DynamoDB error is a worse answer than an error page. A record that will
     * not decode is not transient: it will not decode on the next request
     * either, so a 500 there is a session the visitor can neither use nor
     * clear, on every request, until the TTL retires it. Ending it lets them
     * log in again.
     */
    async fromItem(item) {
        const { [this.partitionKey]: sessionKeyHash, [this.sortKey]: secretHash, dataBr, dataBytes, data, ...rest } = item;
        let restored = data;
        if (dataBr) {
            try {
                restored = JSON.parse(await restoreText(dataBr, "br", { declaredBytes: dataBytes }));
            }
            catch (err) {
                console.warn(`LambderDdbSessionStore: a session record in "${this.tableName}" could not be decoded, so it reads as no session.`, err);
                return null;
            }
        }
        // The load-bearing fields are checked before the cast, because
        // everything past this line trusts them: the manager compares the two
        // hashes in constant time (a non-string would throw there rather than
        // answer false) and reads expiresAt as a number to decide whether the
        // session is over. An item missing them is not this store's record,
        // whether it was written by hand, by an older schema, or by another
        // app sharing the table, and it reads as no session for the same
        // reason an undecodable one does: it will not become valid later.
        if (typeof sessionKeyHash !== "string" || typeof secretHash !== "string"
            || typeof rest.csrfTokenHash !== "string" || typeof rest.sessionKey !== "string"
            || typeof rest.createdAt !== "number" || typeof rest.expiresAt !== "number"
            || typeof rest.ttlInSeconds !== "number") {
            console.warn(`LambderDdbSessionStore: an item in "${this.tableName}" is missing the fields a session record has, so it reads as no session.`);
            return null;
        }
        // The one cast: session.data is whatever the app put there, and JSON
        // (or the plain attribute) hands it back as any. Nothing in the store
        // can check it, because the shape is the app's, not this layer's.
        return { sessionKeyHash, secretHash, data: restored, ...rest };
    }
    async get(sessionKeyHash, secretHash) {
        const { client, sdk } = await this.ready();
        const response = await client.send(new sdk.GetCommand({ TableName: this.tableName, Key: this.keyOf(sessionKeyHash, secretHash), ConsistentRead: true }));
        if (!response.Item)
            return null;
        return await this.fromItem(response.Item);
    }
    async put(record) {
        const item = await this.toItem(record);
        const { client, sdk } = await this.ready();
        await client.send(new sdk.PutCommand({ TableName: this.tableName, Item: item }));
    }
    async delete(sessionKeyHash, secretHash) {
        const { client, sdk } = await this.ready();
        await client.send(new sdk.DeleteCommand({ TableName: this.tableName, Key: this.keyOf(sessionKeyHash, secretHash) }));
    }
    async listSecretHashes(sessionKeyHash) {
        const params = {
            TableName: this.tableName,
            KeyConditionExpression: "#pk = :pv",
            ProjectionExpression: "#sk",
            ExpressionAttributeNames: { "#pk": this.partitionKey, "#sk": this.sortKey },
            ExpressionAttributeValues: { ":pv": sessionKeyHash },
        };
        const hashes = [];
        for (;;) {
            const { client, sdk } = await this.ready();
            const { Items, LastEvaluatedKey } = await client.send(new sdk.QueryCommand(params));
            for (const item of Items ?? [])
                hashes.push(item[this.sortKey]);
            if (LastEvaluatedKey === undefined)
                return hashes;
            params.ExclusiveStartKey = LastEvaluatedKey;
        }
    }
    async markDataExpired(sessionKeyHash, secretHash, at) {
        try {
            const { client, sdk } = await this.ready();
            await client.send(new sdk.UpdateCommand({
                TableName: this.tableName,
                Key: this.keyOf(sessionKeyHash, secretHash),
                UpdateExpression: "SET #dataExpiresAt = :at",
                ConditionExpression: "attribute_exists(#sk)",
                ExpressionAttributeNames: { "#dataExpiresAt": "dataExpiresAt", "#sk": this.sortKey },
                ExpressionAttributeValues: { ":at": at },
            }));
        }
        catch (err) {
            // Deleted between the query and the update: nothing left to expire.
            if (!isConditionalCheckFailure(err))
                throw err;
        }
    }
}
