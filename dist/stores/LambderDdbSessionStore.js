import { createDynamoDocumentClientLoader, isConditionalCheckFailure } from "./LambderDdbSdk.js";
import { compressText, restoreText } from "../shared/wire/LambderCompressionCodec.js";
import { resolveCompressionOption, } from "../shared/wire/LambderCompressionOption.js";
/** The fields besides data an update may write, as the manager names them. */
const UPDATABLE_FIELDS = ["dataExpiresAt", "lastAccessedAt", "expiresAt"];
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
 *
 * Every write is conditional: a create on the item not existing, an update
 * on it existing, so no write already in flight can bring back a session a
 * logout deleted.
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
    /**
     * session.data as the attributes that hold it: `dataBr` and `dataBytes`
     * when compressed, a plain `data` otherwise. Either way it goes through
     * its JSON first, so a plain record holds exactly what a compressed one
     * restores to: an `undefined` inside the data is dropped rather than
     * handed to the document client, which refuses one and would fail the
     * write (a login answering 500) only when compression is off.
     */
    async dataAttributes(data) {
        const json = JSON.stringify(data);
        const raw = Buffer.from(json, "utf8");
        if (this.compression && raw.byteLength >= this.compression.minBytes) {
            return { dataBr: await compressText(raw, "br", this.compression.quality), dataBytes: raw.byteLength };
        }
        return { data: JSON.parse(json) };
    }
    /** The item for a record: the two hashes under the table's key names, the data plain or compressed. */
    async toItem(record) {
        const { sessionKeyHash, secretHash, data, ...rest } = record;
        return { ...this.keyOf(sessionKeyHash, secretHash), ...rest, ...await this.dataAttributes(data) };
    }
    /**
     * The record for an item. A compressed record decodes back into `data`;
     * one whose data cannot be decoded is malformed and reads as no session,
     * like a record missing its csrfTokenHash.
     *
     * This is where read failures and malformed records separate. A read
     * failure is infrastructure and must surface as a 500: signing somebody
     * out over a transient DynamoDB error is worse than an error page. A
     * record that will not decode will not decode on the next request either,
     * so a 500 there would be a session the visitor can neither use nor clear
     * until the TTL retires it. Ending it lets them log in again.
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
        // session is over. An item missing them is not this store's record
        // (written by an earlier major, by hand, or by another app sharing the
        // table), and it reads as no session for the same reason an
        // undecodable one does: it will not become valid later. Not logged: a
        // visitor whose cookie names such an item sends it on every request
        // until the cookie expires, and the item itself goes with its TTL.
        // dataVersion is load-bearing the same way: every conditioned write
        // names the one read, and a record without it would fail that write
        // rather than answer "stale".
        if (typeof sessionKeyHash !== "string" || typeof secretHash !== "string"
            || typeof rest.csrfTokenHash !== "string" || typeof rest.sessionKey !== "string"
            || typeof rest.createdAt !== "number" || typeof rest.expiresAt !== "number"
            || typeof rest.ttlInSeconds !== "number" || typeof rest.dataVersion !== "number") {
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
    async create(record) {
        const item = await this.toItem(record);
        const { client, sdk } = await this.ready();
        await client.send(new sdk.PutCommand({
            TableName: this.tableName,
            Item: item,
            ConditionExpression: "attribute_not_exists(#sk)",
            ExpressionAttributeNames: { "#sk": this.sortKey },
        }));
    }
    async update(sessionKeyHash, secretHash, changes, condition) {
        const names = { "#sk": this.sortKey };
        const values = {};
        const set = [];
        const remove = [];
        const add = [];
        if ("data" in changes) {
            // The data is held in one of two forms, so writing one removes the other.
            const attributes = await this.dataAttributes(changes.data);
            for (const attribute of ["data", "dataBr", "dataBytes"]) {
                names[`#${attribute}`] = attribute;
                if (attribute in attributes) {
                    values[`:${attribute}`] = attributes[attribute];
                    set.push(`#${attribute} = :${attribute}`);
                }
                else {
                    remove.push(`#${attribute}`);
                }
            }
        }
        for (const field of UPDATABLE_FIELDS) {
            if (changes[field] === undefined)
                continue;
            names[`#${field}`] = field;
            values[`:${field}`] = changes[field];
            set.push(`#${field} = :${field}`);
        }
        // A write of the data or its deadline moves the version in the same
        // write, whatever value it writes (see LambderSessionStore.update).
        if ("data" in changes || changes.dataExpiresAt !== undefined) {
            names["#dataVersion"] = "dataVersion";
            values[":dataVersionStep"] = 1;
            add.push("#dataVersion :dataVersionStep");
        }
        let conditionExpression = "attribute_exists(#sk)";
        if (condition) {
            names["#dataVersion"] = "dataVersion";
            values[":readDataVersion"] = condition.dataVersion;
            conditionExpression += " AND #dataVersion = :readDataVersion";
        }
        try {
            const { client, sdk } = await this.ready();
            await client.send(new sdk.UpdateCommand({
                TableName: this.tableName,
                Key: this.keyOf(sessionKeyHash, secretHash),
                UpdateExpression: [
                    set.length ? `SET ${set.join(", ")}` : "",
                    add.length ? `ADD ${add.join(", ")}` : "",
                    remove.length ? `REMOVE ${remove.join(", ")}` : "",
                ].filter(Boolean).join(" "),
                ConditionExpression: conditionExpression,
                ExpressionAttributeNames: names,
                ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
                // Which half of the condition failed is told by the item the
                // refusal hands back, in the same call: none means the record
                // is gone, one means its dataVersion moved.
                ReturnValuesOnConditionCheckFailure: "ALL_OLD",
            }));
            return "updated";
        }
        catch (err) {
            if (!isConditionalCheckFailure(err))
                throw err;
            return err.Item ? "stale" : "missing";
        }
    }
    async delete(sessionKeyHash, secretHash) {
        const { client, sdk } = await this.ready();
        const response = await client.send(new sdk.DeleteCommand({ TableName: this.tableName, Key: this.keyOf(sessionKeyHash, secretHash), ReturnValues: "ALL_OLD" }));
        return response.Attributes ? await this.fromItem(response.Attributes) : null;
    }
    async listSecretHashes(sessionKeyHash) {
        const params = {
            TableName: this.tableName,
            KeyConditionExpression: "#pk = :pv",
            ProjectionExpression: "#sk",
            ExpressionAttributeNames: { "#pk": this.partitionKey, "#sk": this.sortKey },
            ExpressionAttributeValues: { ":pv": sessionKeyHash },
            // Consistent: "log out everywhere" has to find a session created
            // a moment before it, and an eventually consistent read may not.
            ConsistentRead: true,
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
}
