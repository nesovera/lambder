export type LambderSessionContext = {
    [x: string]: any;
    sessionToken: string;
    csrfToken: string;
    sessionKey: string;
    data: any;
    createdAt: number;
    expiresAt: number;
    ttlInSeconds: number;
};
export default class LambderSessionManager {
    private tableName;
    private sessionSalt;
    private partitionKey;
    private sortKey;
    private ddbDocumentClient;
    constructor({ tableName, tableRegion, partitionKey, sortKey, sessionSalt, }: {
        tableName: string;
        tableRegion: string;
        partitionKey: string;
        sortKey: string;
        sessionSalt: string;
    });
    private sessionUserKeyHasher;
    private ddbGetItem;
    private ddbPutItem;
    private ddbDeleteItem;
    private ddbQueryAllByPartitionKey;
    private ddbDeleteAllByPartitionKey;
    createSession(sessionKey: string, data?: any, ttlInSeconds?: number): Promise<LambderSessionContext>;
    updateSessionData(session: LambderSessionContext, newData?: any): Promise<LambderSessionContext>;
    getSession(sessionToken: string): Promise<LambderSessionContext | null>;
    isSessionValid(session: any, sessionToken: any, csrfToken: any, skipCsrfTokenCheck?: boolean): boolean;
    deleteSession(session: Record<string, any>): Promise<boolean>;
    deleteSessionAll(session: Record<string, any>): Promise<boolean>;
}
