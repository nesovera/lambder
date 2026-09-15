import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type LambderCompressionOption } from "../shared/wire/LambderCompressionOption.js";
import type { LambderSessionRecord, LambderSessionStore } from "../shared/contracts/LambderSessionStore.js";
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
    /** The item for a record: the two hashes under the table's key names, the data plain or compressed. */
    private toItem;
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
    private fromItem;
    get(sessionKeyHash: string, secretHash: string): Promise<LambderSessionRecord<SessionData> | null>;
    put(record: LambderSessionRecord<SessionData>): Promise<void>;
    delete(sessionKeyHash: string, secretHash: string): Promise<void>;
    listSecretHashes(sessionKeyHash: string): Promise<string[]>;
    markDataExpired(sessionKeyHash: string, secretHash: string, at: number): Promise<void>;
}
