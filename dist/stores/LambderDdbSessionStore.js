import { attributeValueBytes, createDynamoClientLoader, isConditionalCheckFailure, marshallJsonValue, MAX_ITEM_BYTES, storedNumber, unmarshallJsonValue, } from "./LambderDdbSdk.js";
import { restoreStoredText, storedTextOf } from "./LambderStoredText.js";
import { resolveCompressionOption, } from "../shared/wire/LambderCompressionOption.js";
/** The fields besides data an update may write, as the manager names them. */
const UPDATABLE_FIELDS = ["dataExpiresAt", "lastAccessedAt", "expiresAt"];
/**
 * Session compression defaults: every record compressed (see
 * LambderCompressionOption for the option's shape and toggle semantics).
 * A compressed record carries the data's JSON as Brotli bytes (`dataBr`)
 * beside its byte length (`dataBytes`), the scheme every DynamoDB store here
 * keeps text in (see LambderStoredText); below minBytes, or with compression
 * off, the record keeps a plain `data` attribute.
 */
const SESSION_COMPRESSION_DEFAULTS = { minBytes: 0, quality: 5 };
/**
 * The longest session.data a record holds, in UTF-8 bytes of its JSON: the
 * most the store writes, and so the ceiling it restores a compressed record
 * under. Far past what a session should carry, since it is read on every
 * request, and the same 32 MiB the cache and the idempotency store keep.
 */
const DATA_CEILING = { user: "LambderDdbSessionStore", maxTextBytes: 32 * 1024 * 1024 };
/**
 * What session.data may take of a record as stored, sized as DynamoDB sizes
 * an item: its item limit less 8 KB for the record's other attributes (three
 * hashes, the session key and a handful of numbers, a few hundred bytes with
 * any session key of sensible length).
 */
const MAX_STORED_DATA_BYTES = MAX_ITEM_BYTES - 8 * 1024;
/** A number attribute's value, or undefined when the attribute is missing or holds no finite number. */
const numberAttributeOf = (attribute) => {
    const value = attribute?.N === undefined ? NaN : Number(attribute.N);
    return Number.isFinite(value) ? value : undefined;
};
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
        this.ready = createDynamoClientLoader({ user: "LambderDdbSessionStore", region: options.region, client: options.client });
    }
    keyOf(sessionKeyHash, secretHash) {
        return { [this.partitionKey]: { S: sessionKeyHash }, [this.sortKey]: { S: secretHash } };
    }
    /**
     * session.data as the attributes that hold it: `dataBr` and `dataBytes`
     * when compressed, a plain `data` attribute otherwise. Either way it goes
     * through its JSON first, so a plain record holds exactly what a
     * compressed one restores to: an `undefined` inside the data is dropped,
     * as JSON drops it, rather than handed to marshallJsonValue, which
     * refuses one and would fail the write (a login answering 500) only when
     * compression is off.
     *
     * Data too large for a record is refused here, before anything is
     * written, with the size and the limit it passed: DynamoDB would refuse
     * the item with a ValidationException that names neither, and data past
     * the restore ceiling would be written only to read back as no session.
     * Create and update measure the same attributes, so data one accepts the
     * other does too.
     */
    async dataAttributes(data) {
        const json = JSON.stringify(data);
        const utf8 = Buffer.from(json, "utf8");
        if (utf8.byteLength > DATA_CEILING.maxTextBytes) {
            throw new Error(`LambderDdbSessionStore: session.data is ${utf8.byteLength} bytes of JSON, over the ${DATA_CEILING.maxTextBytes}-byte limit of a session record. Keep less in the session.`);
        }
        const text = await storedTextOf(utf8, this.compression);
        const attributes = text.encoding === "br"
            ? { dataBr: { B: text.stored }, dataBytes: { N: String(text.textBytes) } }
            : { data: marshallJsonValue(JSON.parse(json)) };
        const storedBytes = Object.entries(attributes)
            .reduce((total, [name, value]) => total + Buffer.byteLength(name, "utf8") + attributeValueBytes(value), 0);
        if (storedBytes > MAX_STORED_DATA_BYTES) {
            const remedy = text.encoding === "br" ? "Keep less in the session." : "Keep less in the session, or let the store's compression option compress it.";
            throw new Error(`LambderDdbSessionStore: session.data is ${storedBytes} bytes as stored, over the ${MAX_STORED_DATA_BYTES} bytes a session record leaves it inside DynamoDB's ${MAX_ITEM_BYTES}-byte item limit. ${remedy}`);
        }
        return attributes;
    }
    /**
     * The item for a record: the two hashes under the table's key names, the
     * record's other fields under their own names (strings and numbers, an
     * absent dataExpiresAt left out), the data plain or compressed. The
     * attribute names and types are the ones items have always carried, so
     * records written before and after read alike.
     */
    async toItem(record) {
        const { sessionKeyHash, secretHash, data, ...fields } = record;
        const item = { ...this.keyOf(sessionKeyHash, secretHash), ...await this.dataAttributes(data) };
        for (const [name, value] of Object.entries(fields)) {
            if (value !== undefined)
                item[name] = marshallJsonValue(value);
        }
        return item;
    }
    /**
     * The record for an item. A compressed record decodes back into `data`;
     * one whose data cannot be decoded, or declares more of it than the store
     * ever writes, is malformed and reads as no session, like a record
     * missing its csrfTokenHash.
     *
     * This is where read failures and malformed records separate. A read
     * failure is infrastructure and must surface as a 500: signing somebody
     * out over a transient DynamoDB error is worse than an error page. A
     * record that will not decode will not decode on the next request either,
     * so a 500 there would be a session the visitor can neither use nor clear
     * until the TTL retires it. Ending it lets them log in again.
     */
    async fromItem(item) {
        let data;
        try {
            const compressed = item.dataBr?.B;
            if (compressed)
                data = JSON.parse(await restoreStoredText(compressed, storedNumber(item.dataBytes?.N, 0), DATA_CEILING));
            else if (item.data)
                data = unmarshallJsonValue(item.data);
        }
        catch (err) {
            console.warn(`LambderDdbSessionStore: a session record in "${this.tableName}" could not be decoded, so it reads as no session.`, err);
            return null;
        }
        const sessionKeyHash = item[this.partitionKey]?.S;
        const secretHash = item[this.sortKey]?.S;
        const csrfTokenHash = item.csrfTokenHash?.S;
        const sessionKey = item.sessionKey?.S;
        const createdAt = numberAttributeOf(item.createdAt);
        const expiresAt = numberAttributeOf(item.expiresAt);
        const lastAccessedAt = numberAttributeOf(item.lastAccessedAt);
        const ttlInSeconds = numberAttributeOf(item.ttlInSeconds);
        const dataVersion = numberAttributeOf(item.dataVersion);
        const dataExpiresAt = numberAttributeOf(item.dataExpiresAt);
        // The load-bearing fields are checked before the record is built,
        // because everything past this line trusts them: the manager compares
        // the two hashes in constant time (a non-string would throw there
        // rather than answer false) and reads expiresAt as a number to decide
        // whether the session is over. An item missing them is not this
        // store's record (written by an earlier major, by hand, or by another
        // app sharing the table), and it reads as no session for the same
        // reason an undecodable one does: it will not become valid later. Not
        // logged: a visitor whose cookie names such an item sends it on every
        // request until the cookie expires, and the item itself goes with its
        // TTL. dataVersion is load-bearing the same way: every conditioned
        // write names the one read, and a record without it would fail that
        // write rather than answer "stale".
        if (sessionKeyHash === undefined || secretHash === undefined || csrfTokenHash === undefined || sessionKey === undefined
            || createdAt === undefined || expiresAt === undefined || ttlInSeconds === undefined || dataVersion === undefined) {
            return null;
        }
        // The cast: session.data is whatever the app put there, and JSON (or
        // the plain attribute) hands it back untyped. Nothing in the store can
        // check it, because the shape is the app's, not this layer's. The
        // other unchecked field is lastAccessedAt: written with every record,
        // and read as absent from an item without it rather than refusing it.
        return {
            sessionKeyHash, secretHash, csrfTokenHash, sessionKey, data: data,
            createdAt, expiresAt, ttlInSeconds, dataVersion,
            ...(lastAccessedAt !== undefined ? { lastAccessedAt } : {}),
            ...(dataExpiresAt !== undefined ? { dataExpiresAt } : {}),
        };
    }
    async get(sessionKeyHash, secretHash) {
        const { client, sdk } = await this.ready();
        const response = await client.send(new sdk.GetItemCommand({ TableName: this.tableName, Key: this.keyOf(sessionKeyHash, secretHash), ConsistentRead: true }));
        if (!response.Item)
            return null;
        return await this.fromItem(response.Item);
    }
    async create(record) {
        const item = await this.toItem(record);
        const { client, sdk } = await this.ready();
        await client.send(new sdk.PutItemCommand({
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
                const value = attributes[attribute];
                if (value) {
                    values[`:${attribute}`] = value;
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
            values[`:${field}`] = marshallJsonValue(changes[field]);
            set.push(`#${field} = :${field}`);
        }
        // A write of the data or its deadline moves the version in the same
        // write, whatever value it writes (see LambderSessionStore.update).
        if ("data" in changes || changes.dataExpiresAt !== undefined) {
            names["#dataVersion"] = "dataVersion";
            values[":dataVersionStep"] = { N: "1" };
            add.push("#dataVersion :dataVersionStep");
        }
        let conditionExpression = "attribute_exists(#sk)";
        if (condition) {
            names["#dataVersion"] = "dataVersion";
            values[":readDataVersion"] = marshallJsonValue(condition.dataVersion);
            conditionExpression += " AND #dataVersion = :readDataVersion";
        }
        try {
            const { client, sdk } = await this.ready();
            await client.send(new sdk.UpdateItemCommand({
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
        const response = await client.send(new sdk.DeleteItemCommand({ TableName: this.tableName, Key: this.keyOf(sessionKeyHash, secretHash), ReturnValues: "ALL_OLD" }));
        return response.Attributes ? await this.fromItem(response.Attributes) : null;
    }
    async listSecretHashes(sessionKeyHash) {
        const params = {
            TableName: this.tableName,
            KeyConditionExpression: "#pk = :pv",
            ProjectionExpression: "#sk",
            ExpressionAttributeNames: { "#pk": this.partitionKey, "#sk": this.sortKey },
            ExpressionAttributeValues: { ":pv": { S: sessionKeyHash } },
            // Consistent: "log out everywhere" has to find a session created
            // a moment before it, and an eventually consistent read may not.
            ConsistentRead: true,
        };
        const hashes = [];
        for (;;) {
            const { client, sdk } = await this.ready();
            const { Items, LastEvaluatedKey } = await client.send(new sdk.QueryCommand(params));
            for (const item of Items ?? []) {
                const secretHash = item[this.sortKey]?.S;
                if (secretHash !== undefined)
                    hashes.push(secretHash);
            }
            if (LastEvaluatedKey === undefined)
                return hashes;
            params.ExclusiveStartKey = LastEvaluatedKey;
        }
    }
}
