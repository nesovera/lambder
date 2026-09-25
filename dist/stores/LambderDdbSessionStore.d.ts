import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type LambderCompressionOption } from "../shared/wire/LambderCompressionOption.js";
import type { LambderSessionChanges, LambderSessionRecord, LambderSessionStore, LambderSessionUpdateResult } from "../shared/contracts/LambderSessionStore.js";
export type LambderDdbSessionStoreOptions = {
    tableName: string;
    /** Region the client is created for on first use; the SDK's default chain otherwise. */
    region?: string;
    /** Attribute names of the table's hash and range keys. Defaults: "pk" and "sk". */
    partitionKey?: string;
    sortKey?: string;
    /**
     * Brotli compression of session.data at rest. `true` (the default)
     * compresses every record, the same as `{ minBytes: 0 }`; `false` turns
     * it off; `{ minBytes }` compresses only records whose JSON is at least
     * that many bytes. Records written under either setting read back, so
     * it can be switched on or off on a live table.
     */
    compression?: LambderCompressionOption;
    /** A ready document client, e.g. one shared with the rest of the app. */
    client?: DynamoDBDocumentClient;
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
export declare class LambderDdbSessionStore<SessionData = unknown> implements LambderSessionStore<SessionData> {
    /** DynamoDB keeps records after this process is gone. */
    readonly isMemoryOnly = false;
    readonly tableName: string;
    private readonly partitionKey;
    private readonly sortKey;
    private readonly compression;
    /** The SDK and the client, loaded and created the first time the table is touched (see LambderDdbSdk). */
    private readonly ready;
    constructor(options: LambderDdbSessionStoreOptions);
    private keyOf;
    /**
     * session.data as the attributes that hold it: `dataBr` and `dataBytes`
     * when compressed, a plain `data` otherwise. Either way it goes through
     * its JSON first, so a plain record holds exactly what a compressed one
     * restores to: an `undefined` inside the data is dropped rather than
     * handed to the document client, which refuses one and would fail the
     * write (a login answering 500) only when compression is off.
     */
    private dataAttributes;
    /** The item for a record: the two hashes under the table's key names, the data plain or compressed. */
    private toItem;
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
    private fromItem;
    get(sessionKeyHash: string, secretHash: string): Promise<LambderSessionRecord<SessionData> | null>;
    create(record: LambderSessionRecord<SessionData>): Promise<void>;
    update(sessionKeyHash: string, secretHash: string, changes: LambderSessionChanges<SessionData>, condition?: {
        dataVersion: number;
    }): Promise<LambderSessionUpdateResult>;
    delete(sessionKeyHash: string, secretHash: string): Promise<LambderSessionRecord<SessionData> | null>;
    listSecretHashes(sessionKeyHash: string): Promise<string[]>;
}
