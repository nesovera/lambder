import crypto from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

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


export default class LambderSessionManager{
    private tableName: string;
    private sessionSalt: string;
    private partitionKey: string;
    private sortKey: string;
    private ddbDocumentClient: DynamoDBDocumentClient;

    constructor(
        {
            tableName, tableRegion,
            partitionKey, sortKey,
            sessionSalt,
        }: {
            tableName: string, tableRegion: string,
            partitionKey: string, sortKey: string,
            sessionSalt: string,
        }
    ){
        this.tableName = tableName;
        this.sessionSalt = sessionSalt;
        this.partitionKey = partitionKey;
        this.sortKey = sortKey;

        const ddbClient = new DynamoDBClient({ region: tableRegion });
        this.ddbDocumentClient = DynamoDBDocumentClient.from(ddbClient);
    }

    private sessionUserKeyHasher(password:string){
        return crypto.createHash("sha256")
                     .update(`${password}${this.sessionSalt}`)
                     .digest("hex");
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
        ttlInSeconds:number = 30*24*60*60
    ): Promise<LambderSessionContext> {
        const sessionKeyHash = this.sessionUserKeyHasher(sessionKey);
        const sessionSortKey = crypto.randomBytes(32).toString("hex");
        const sessionToken = `${sessionKeyHash}:${sessionSortKey}`;
        const csrfToken = crypto.randomBytes(8).toString("hex");
        const createdAt = Math.floor(Date.now()/1000);
        const expiresAt = Number(createdAt) + Number(ttlInSeconds);
    
        const session = {
            [this.partitionKey]: sessionKeyHash, 
            [this.sortKey]: sessionSortKey,
            sessionToken, csrfToken,
            sessionKey, data, 
            createdAt, expiresAt, ttlInSeconds
        };
        await this.ddbPutItem(session);
        return session;
    }

    public async updateSessionData(
        session: LambderSessionContext,
        newData?: any
    ): Promise<LambderSessionContext> {
        if(!session) throw new Error("Invalid session");
        session.data = newData;
        await this.ddbPutItem(session);
        return session;
    }

    public async getSession(sessionToken: string): Promise<LambderSessionContext|null>{
        const [ sessionKeyHash, sessionSortKey ] = sessionToken.split(":");
        if(!sessionKeyHash || !sessionSortKey) return null;
        try{
            let session = await this.ddbGetItem({ 
                [this.partitionKey]: sessionKeyHash, 
                [this.sortKey]: sessionSortKey
            });
            if(!session) throw new Error("Session not found");
            if(!session.sessionToken || session.sessionToken !== sessionToken) throw new Error("Not found: session.sessionToken");
            if(!session.csrfToken) throw new Error("Not found: session.csrfToken");
            if(!session.sessionKey) throw new Error("Not found: session.sessionKey");
            if(!session.createdAt) throw new Error("Not found: session.createdAt");
            if(!session.expiresAt || session.expiresAt < Date.now()/1000) throw new Error("Not found: session.expiresAt");
            return session;
        }catch(err){
            return null;
        }
    };

    public isSessionValid(session: any, sessionToken: any, csrfToken: any, skipCsrfTokenCheck = false){
        if(!session) return false;
        if(!sessionToken || typeof sessionToken !== "string") return false;
        if(session.sessionToken !== sessionToken) return false;
        if(!session.csrfToken) return false;
        if(!session.sessionKey) return false;
        if(!session.createdAt) return false;
        if(!session.expiresAt || session.expiresAt < Date.now()/1000) return false;
        if(!skipCsrfTokenCheck){
            if(!csrfToken || typeof csrfToken !== "string") return false;
            if(session.csrfToken !== csrfToken) return false;
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
};