import crypto from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
export default class LambderSessionManager {
    tableName;
    sessionSalt;
    partitionKey;
    sortKey;
    ddbDocumentClient;
    enableSlidingExpiration;
    constructor({ tableName, tableRegion, partitionKey, sortKey, sessionSalt, enableSlidingExpiration = true, }) {
        this.tableName = tableName;
        this.sessionSalt = sessionSalt;
        this.partitionKey = partitionKey;
        this.sortKey = sortKey;
        this.enableSlidingExpiration = enableSlidingExpiration;
        const ddbClient = new DynamoDBClient({ region: tableRegion });
        this.ddbDocumentClient = DynamoDBDocumentClient.from(ddbClient);
    }
    sessionUserKeyHasher(password) {
        return crypto.createHash("sha256")
            .update(`${password}${this.sessionSalt}`)
            .digest("hex");
    }
    constantTimeCompare(a, b) {
        if (a.length !== b.length)
            return false;
        const bufferA = Buffer.from(a, 'utf8');
        const bufferB = Buffer.from(b, 'utf8');
        return crypto.timingSafeEqual(new Uint8Array(bufferA), new Uint8Array(bufferB));
    }
    async ddbGetItem(key) {
        const response = await this.ddbDocumentClient.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }));
        if (response.Item)
            return response.Item;
        return null;
    }
    ;
    async ddbPutItem(item) {
        return await this.ddbDocumentClient.send(new PutCommand({ TableName: this.tableName, Item: item, }));
    }
    ;
    async ddbDeleteItem(key) {
        return await this.ddbDocumentClient.send(new DeleteCommand({ TableName: this.tableName, Key: key, }));
    }
    ;
    async ddbQueryAllByPartitionKey(partitionValue) {
        const params = {
            TableName: this.tableName,
            KeyConditionExpression: "#pk = :pv",
            ExpressionAttributeNames: { "#pk": this.partitionKey },
            ExpressionAttributeValues: { ":pv": partitionValue },
        };
        const queryResults = [];
        do {
            const { Items, LastEvaluatedKey } = await this.ddbDocumentClient.send(new QueryCommand(params));
            if (Items)
                queryResults.push(...Items);
            params.ExclusiveStartKey = LastEvaluatedKey;
            if (typeof LastEvaluatedKey == "undefined")
                return queryResults;
            // eslint-disable-next-line no-constant-condition
        } while (true);
    }
    ;
    async ddbDeleteAllByPartitionKey(partitionValue) {
        const queryResults = await this.ddbQueryAllByPartitionKey(partitionValue);
        for (const item of queryResults) {
            await this.ddbDocumentClient.send(new DeleteCommand({
                TableName: this.tableName,
                Key: { [this.partitionKey]: partitionValue, [this.sortKey]: item[this.sortKey] }
            }));
        }
    }
    async createSession(sessionKey, data = {}, ttlInSeconds = 30 * 24 * 60 * 60) {
        const sessionKeyHash = this.sessionUserKeyHasher(sessionKey);
        const sessionSortKey = crypto.randomBytes(32).toString("hex");
        const sessionToken = `${sessionKeyHash}:${sessionSortKey}`;
        const csrfToken = crypto.randomBytes(32).toString("hex");
        const createdAt = Math.floor(Date.now() / 1000);
        const lastAccessedAt = createdAt;
        const expiresAt = Number(createdAt) + Number(ttlInSeconds);
        const session = {
            [this.partitionKey]: sessionKeyHash,
            [this.sortKey]: sessionSortKey,
            sessionToken, csrfToken,
            sessionKey, data,
            createdAt, lastAccessedAt, expiresAt, ttlInSeconds
        };
        await this.ddbPutItem(session);
        return session;
    }
    async updateSessionData(session, newData) {
        if (!session)
            throw new Error("Invalid session");
        session.data = newData;
        session.lastAccessedAt = Math.floor(Date.now() / 1000);
        // Update expiration if sliding expiration is enabled
        if (this.enableSlidingExpiration) {
            session.expiresAt = session.lastAccessedAt + session.ttlInSeconds;
        }
        await this.ddbPutItem(session);
        return session;
    }
    async getSession(sessionToken) {
        const [sessionKeyHash, sessionSortKey] = sessionToken.split(":");
        if (!sessionKeyHash || !sessionSortKey)
            return null;
        try {
            let session = await this.ddbGetItem({
                [this.partitionKey]: sessionKeyHash,
                [this.sortKey]: sessionSortKey
            });
            // Use constant error response to prevent timing attacks
            if (!session)
                return null;
            if (!session.sessionToken || !this.constantTimeCompare(session.sessionToken, sessionToken))
                return null;
            if (!session.csrfToken)
                return null;
            if (!session.sessionKey)
                return null;
            if (!session.createdAt)
                return null;
            if (!session.expiresAt || session.expiresAt < Date.now() / 1000)
                return null;
            // Update last accessed time if sliding expiration is enabled
            if (this.enableSlidingExpiration) {
                session.lastAccessedAt = Math.floor(Date.now() / 1000);
                session.expiresAt = session.lastAccessedAt + session.ttlInSeconds;
                // Wait for the update to ensure it persists before Lambda freezes
                await this.ddbPutItem(session).catch(() => { });
            }
            return session;
        }
        catch (err) {
            return null;
        }
    }
    ;
    isSessionValid(session, sessionToken, csrfToken, skipCsrfTokenCheck = false) {
        if (!session)
            return false;
        if (!sessionToken || typeof sessionToken !== "string")
            return false;
        if (!this.constantTimeCompare(session.sessionToken, sessionToken))
            return false;
        if (!session.csrfToken)
            return false;
        if (!session.sessionKey)
            return false;
        if (!session.createdAt)
            return false;
        if (!session.expiresAt || session.expiresAt < Date.now() / 1000)
            return false;
        if (!skipCsrfTokenCheck) {
            if (!csrfToken || typeof csrfToken !== "string")
                return false;
            if (!this.constantTimeCompare(session.csrfToken, csrfToken))
                return false;
        }
        return true;
    }
    async deleteSession(session) {
        await this.ddbDeleteItem({
            [this.partitionKey]: session[this.partitionKey],
            [this.sortKey]: session[this.sortKey],
        });
        return true;
    }
    ;
    async deleteSessionAll(session) {
        await this.ddbDeleteAllByPartitionKey(session[this.partitionKey]);
        return true;
    }
    ;
    async regenerateSession(session) {
        if (!session)
            throw new Error("Invalid session");
        // Delete old session
        await this.deleteSession(session);
        // Create new session with same sessionKey and data but new tokens
        return await this.createSession(session.sessionKey, session.data, session.ttlInSeconds);
    }
}
;
