import crypto from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

export type LambderSessionContext<SessionData = any> = {
    [x: string]: any;
    /**
     * sha256 of the raw CSRF token. The raw bearer secrets are never stored:
     * they exist only in the client's cookies (and, at creation, on the
     * LambderCreatedSession result), so a read of the session table yields
     * no usable credentials.
     */
    csrfTokenHash: string;
    sessionKey: string;
    data: SessionData;
    createdAt: number;
    expiresAt: number;
    lastAccessedAt: number;
    ttlInSeconds: number;
    /**
     * When `data` must be renewed via the dataRefresh callback (epoch seconds).
     * Only present when dataRefresh is configured; independent of the
     * session's own expiresAt.
     */
    dataExpiresAt?: number;
};

/**
 * A freshly created (or regenerated) session: the persisted record plus the
 * RAW cookie secrets, which exist only here and in the cookies the caller
 * sets. At rest the record carries hashes of both.
 */
export type LambderCreatedSession<SessionData = any> = {
    session: LambderSessionContext<SessionData>;
    /** Raw bearer token for the session cookie (`pkHash:secret`). */
    sessionToken: string;
    /** Raw CSRF token for the client-readable csrf cookie. */
    csrfToken: string;
};

/**
 * Opt-in freshness for session.data that is derived from external state
 * (roles, permissions, feature flags...). When configured, every session read
 * checks dataExpiresAt and calls `refresh` past it, persisting the result
 * onto the same session record: same tokens, same cookies, the session
 * itself is untouched. The refresh write and the sliding-expiration write
 * share a single DynamoDB put when both are due.
 */
export type LambderSessionDataRefreshConfig<SessionData = any> = {
    /** Seconds session.data stays valid before refresh() runs on read. */
    ttlSeconds: number;
    /**
     * Rebuild session.data from its source of truth. Must be a pure
     * derivation (concurrent reads may run it in parallel; last write wins).
     * Return null to end the session: the record is deleted and the read
     * reports no session. Thrown errors fail the read as a
     * LambderSessionDataRefreshError and leave the session untouched; catch
     * inside and return session.data to explicitly serve stale instead.
     */
    refresh: (session: LambderSessionContext<SessionData>) => Promise<SessionData | null>;
};

/**
 * Wraps errors thrown by the dataRefresh callback so they stay
 * distinguishable from "no session": fetchSessionIfExists() swallows missing
 * or invalid sessions but rethrows this, otherwise a transient failure in
 * the refresh source would masquerade as a logout.
 */
export class LambderSessionDataRefreshError extends Error {
    constructor(cause: unknown) {
        super(`Session dataRefresh failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        this.name = "LambderSessionDataRefreshError";
    }
}

/**
 * Wraps DynamoDB failures during a session read so they stay distinguishable
 * from "no session": fetchSessionIfExists() swallows missing or invalid
 * sessions but rethrows this. Without the distinction a transient DynamoDB
 * error would answer sessionExpired, and the caller would then clear the
 * client's session cookies: an infra blip forcing a real logout.
 */
export class LambderSessionReadError extends Error {
    constructor(cause: unknown) {
        super(`Session read failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        this.name = "LambderSessionReadError";
    }
}


export default class LambderSessionManager{
    private tableName: string;
    private sessionSalt: string;
    private partitionKey: string;
    private sortKey: string;
    private ddbDocumentClient: DynamoDBDocumentClient;
    private enableSlidingExpiration: boolean;
    private slidingWriteIntervalSeconds: number | null;
    private dataRefresh: LambderSessionDataRefreshConfig | null;

    constructor(
        {
            tableName, tableRegion,
            partitionKey, sortKey,
            sessionSalt,
            enableSlidingExpiration = true,
            slidingWriteIntervalSeconds,
            dataRefresh,
        }: {
            tableName: string, tableRegion: string,
            partitionKey: string, sortKey: string,
            sessionSalt: string,
            enableSlidingExpiration?: boolean,
            slidingWriteIntervalSeconds?: number,
            dataRefresh?: LambderSessionDataRefreshConfig,
        }
    ){
        this.tableName = tableName;
        this.sessionSalt = sessionSalt;
        this.partitionKey = partitionKey;
        this.sortKey = sortKey;
        this.enableSlidingExpiration = enableSlidingExpiration;
        this.slidingWriteIntervalSeconds = slidingWriteIntervalSeconds ?? null;
        this.dataRefresh = dataRefresh ?? null;

        const ddbClient = new DynamoDBClient({ region: tableRegion });
        this.ddbDocumentClient = DynamoDBDocumentClient.from(ddbClient);
    }

    private sessionUserKeyHasher(password:string){
        return crypto.createHash("sha256")
                     .update(`${password}${this.sessionSalt}`)
                     .digest("hex");
    }

    /**
     * At-rest hash for the bearer secrets (session sort-key secret, CSRF
     * token). Fast unsalted sha256 is the right construction here: the
     * inputs are 256-bit random values, so there is nothing to brute-force;
     * hashing just ensures a leaked table read yields no usable cookies.
     */
    private hashToken(value: string){
        return crypto.createHash("sha256").update(value).digest("hex");
    }

    private constantTimeCompare(a: string, b: string): boolean {
        if (a.length !== b.length) return false;
        const bufferA = Buffer.from(a, 'utf8');
        const bufferB = Buffer.from(b, 'utf8');
        return crypto.timingSafeEqual(new Uint8Array(bufferA), new Uint8Array(bufferB));
    }

    private async ddbGetItem<T=any>(key:Record<string,string|number>){
        const response = await this.ddbDocumentClient.send(
            new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true })
        );
        if(response.Item) return response.Item as T;
        return null;
    };
    private async ddbPutItem(item: Record<string,any>){
        return await this.ddbDocumentClient.send(
            new PutCommand({ TableName: this.tableName, Item: item, })
        );
    };

    private async ddbDeleteItem(key:Record<string,string|number>){
        return await this.ddbDocumentClient.send(
            new DeleteCommand({ TableName: this.tableName, Key: key, })
        );
    };

    private async ddbQueryAllByPartitionKey (partitionValue: string){
        const params: any = {
            TableName: this.tableName,
            KeyConditionExpression: "#pk = :pv",
            ExpressionAttributeNames:{ "#pk": this.partitionKey },
            ExpressionAttributeValues: { ":pv": partitionValue },
        }
        const queryResults: any[] = [];
        do{
            const {Items, LastEvaluatedKey} =  await this.ddbDocumentClient.send(new QueryCommand(params));
            if(Items) queryResults.push(...Items);
            params.ExclusiveStartKey  = LastEvaluatedKey;
            if(typeof LastEvaluatedKey == "undefined") return queryResults;
        // eslint-disable-next-line no-constant-condition
        } while (true);
    };

    private async ddbDeleteAllByPartitionKey(partitionValue: string){
        const queryResults = await this.ddbQueryAllByPartitionKey(partitionValue);
        for(const item of queryResults){
            await this.ddbDocumentClient.send(new DeleteCommand({
                TableName: this.tableName,
                Key: { [this.partitionKey]: partitionValue, [this.sortKey]: item[this.sortKey] }
            }));
        }
    }

    public async createSession(
        sessionKey: string,
        data: any = {},
        ttlInSeconds:number = 30*24*60*60,
        options?: {
            /** Carries an existing data freshness stamp over (used by regenerateSession). */
            dataExpiresAt?: number
        }
    ): Promise<LambderCreatedSession> {
        const sessionKeyHash = this.sessionUserKeyHasher(sessionKey);
        // The sort-key SECRET goes to the client; only its hash becomes the
        // DynamoDB range key, so the table never contains a usable token.
        const sessionSortKeySecret = crypto.randomBytes(32).toString("hex");
        const sessionToken = `${sessionKeyHash}:${sessionSortKeySecret}`;
        const csrfToken = crypto.randomBytes(32).toString("hex");
        const createdAt = Math.floor(Date.now()/1000);
        const lastAccessedAt = createdAt;
        const expiresAt = Number(createdAt) + Number(ttlInSeconds);

        const session = {
            [this.partitionKey]: sessionKeyHash,
            [this.sortKey]: this.hashToken(sessionSortKeySecret),
            csrfTokenHash: this.hashToken(csrfToken),
            sessionKey, data,
            createdAt, lastAccessedAt, expiresAt, ttlInSeconds,
            ...(this.dataRefresh ? { dataExpiresAt: options?.dataExpiresAt ?? (createdAt + this.dataRefresh.ttlSeconds) } : {}),
        };
        await this.ddbPutItem(session);
        return { session, sessionToken, csrfToken };
    }

    public async updateSessionData(
        session: LambderSessionContext,
        newData?: any
    ): Promise<LambderSessionContext> {
        if(!session) throw new Error("Invalid session");
        session.data = newData;
        session.lastAccessedAt = Math.floor(Date.now()/1000);

        // Explicitly written data is fresh by definition.
        if(this.dataRefresh){
            session.dataExpiresAt = session.lastAccessedAt + this.dataRefresh.ttlSeconds;
        }

        // Update expiration if sliding expiration is enabled
        if(this.enableSlidingExpiration){
            session.expiresAt = session.lastAccessedAt + session.ttlInSeconds;
        }

        await this.ddbPutItem(session);
        return session;
    }

    public async getSession(sessionToken: string): Promise<LambderSessionContext|null>{
        const [ sessionKeyHash, sessionSortKeySecret ] = sessionToken.split(":");
        if(!sessionKeyHash || !sessionSortKeySecret) return null;
        // A DynamoDB read failure propagates typed: null means "no such
        // session", which callers translate to sessionExpired, and the caller
        // then clears the client's session cookies. A transient infra error
        // must surface as a 500, not force a logout.
        let session: LambderSessionContext | null;
        try{
            // The lookup itself proves possession of the raw secret: the
            // range key is its hash, so only the true secret finds the item.
            session = await this.ddbGetItem({
                [this.partitionKey]: sessionKeyHash,
                [this.sortKey]: this.hashToken(sessionSortKeySecret)
            });
        }catch(err){
            throw new LambderSessionReadError(err);
        }

        if(!session) return null;
        if(!session.csrfTokenHash) return null;
        if(!session.sessionKey) return null;
        if(!session.createdAt) return null;
        if(!session.expiresAt || session.expiresAt < Date.now()/1000) return null;

        const now = Math.floor(Date.now()/1000);
        let needsWrite = false;

        // Renew session.data once its shelf life has passed (opt-in
        // dataRefresh). Records from before the feature was enabled have no
        // dataExpiresAt, so they renew on first read.
        if(this.dataRefresh && (session.dataExpiresAt ?? 0) <= now){
            let newData;
            try{
                newData = await this.dataRefresh.refresh(session);
            }catch(err){
                // A failing refresh must fail this read, not masquerade as a
                // missing session or silently serve stale data.
                throw new LambderSessionDataRefreshError(err);
            }
            if(newData === null){
                await this.deleteSession(session);
                return null;
            }
            session.data = newData;
            session.dataExpiresAt = now + this.dataRefresh.ttlSeconds;
            needsWrite = true;
        }

        // Update last accessed time if sliding expiration is enabled.
        // Throttled: skip the DynamoDB write when the session was refreshed
        // recently, to avoid a write on every request. A due data renewal
        // above forces the write anyway, so both updates share one put.
        if(this.enableSlidingExpiration){
            const minInterval = this.slidingWriteIntervalSeconds
                ?? Math.max(60, Math.floor((session.ttlInSeconds || 0) * 0.05));
            if(needsWrite || now - (session.lastAccessedAt || 0) >= minInterval){
                session.lastAccessedAt = now;
                session.expiresAt = now + session.ttlInSeconds;
                needsWrite = true;
            }
        }

        if(needsWrite){
            // Wait for the update to ensure it persists before Lambda freezes.
            // A failed put is not fatal: the data served is fresh, and an
            // unpersisted renewal simply runs again on the next read.
            await this.ddbPutItem(session).catch(() => {});
        }

        return session;
    };

    /**
     * Runs the dataRefresh callback now, regardless of dataExpiresAt, and
     * persists the result onto the same record. Returns the updated session,
     * or null when the callback ended it (the record is deleted). Requires
     * dataRefresh to be configured.
     */
    public async refreshSessionData(session: LambderSessionContext): Promise<LambderSessionContext|null>{
        if(!this.dataRefresh) throw new Error("dataRefresh is not configured. Pass dataRefresh to enableDdbSession(...) to enable.");
        if(!session) throw new Error("Invalid session");
        let newData;
        try{
            newData = await this.dataRefresh.refresh(session);
        }catch(err){
            throw new LambderSessionDataRefreshError(err);
        }
        if(newData === null){
            await this.deleteSession(session);
            return null;
        }
        const now = Math.floor(Date.now()/1000);
        session.data = newData;
        session.dataExpiresAt = now + this.dataRefresh.ttlSeconds;
        session.lastAccessedAt = now;
        if(this.enableSlidingExpiration){
            session.expiresAt = now + session.ttlInSeconds;
        }
        await this.ddbPutItem(session);
        return session;
    };

    public isSessionValid(session: any, sessionToken: any, csrfToken: any, skipCsrfTokenCheck = false){
        if(!session) return false;
        if(!sessionToken || typeof sessionToken !== "string") return false;
        // Presented raw secrets are checked against the stored hashes.
        const [ sessionKeyHash, sessionSortKeySecret ] = sessionToken.split(":");
        if(!sessionKeyHash || !sessionSortKeySecret) return false;
        if(!this.constantTimeCompare(String(session[this.partitionKey] ?? ""), sessionKeyHash)) return false;
        if(!this.constantTimeCompare(String(session[this.sortKey] ?? ""), this.hashToken(sessionSortKeySecret))) return false;
        if(!session.csrfTokenHash) return false;
        if(!session.sessionKey) return false;
        if(!session.createdAt) return false;
        if(!session.expiresAt || session.expiresAt < Date.now()/1000) return false;
        if(!skipCsrfTokenCheck){
            if(!csrfToken || typeof csrfToken !== "string") return false;
            if(!this.constantTimeCompare(session.csrfTokenHash, this.hashToken(csrfToken))) return false;
        }
        return true;
    }

    public async deleteSession(session: Record<string, any>): Promise<boolean>{
        await this.ddbDeleteItem({ 
            [this.partitionKey]: session[this.partitionKey],
            [this.sortKey]: session[this.sortKey],
        });
        return true;
    };

    public async deleteSessionAll (session: Record<string, any>): Promise<boolean>{
        await this.ddbDeleteAllByPartitionKey(session[this.partitionKey])
        return true;
    };

    /**
     * Deletes every session created for the given sessionKey (e.g. a user
     * id): "log this subject out everywhere", without needing a fetched
     * session record.
     */
    public async deleteSessionAllByKey (sessionKey: string): Promise<boolean>{
        await this.ddbDeleteAllByPartitionKey(this.sessionUserKeyHasher(sessionKey));
        return true;
    };

    public async regenerateSession(session: LambderSessionContext): Promise<LambderCreatedSession> {
        if(!session) throw new Error("Invalid session");

        // Delete old session
        await this.deleteSession(session);

        // Create new session with same sessionKey and data but new tokens.
        // The data freshness stamp carries over: rotating tokens must not
        // extend how long dataRefresh-managed data may stay unrenewed.
        return await this.createSession(session.sessionKey, session.data, session.ttlInSeconds,
            session.dataExpiresAt !== undefined ? { dataExpiresAt: session.dataExpiresAt } : undefined);
    }
};