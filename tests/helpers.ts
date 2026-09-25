import { LambderLocalFileSource } from '../src/stores/LambderLocalFileSource.js';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import {
    DynamoDBClient,
    UpdateItemCommand,
    PutItemCommand,
    GetItemCommand,
    DeleteItemCommand,
    type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyEventV2, Context } from 'aws-lambda';
import type { LambderHttpResponse } from '../src/core/LambderResponse.js';
import { lambderTestApp } from '../src/testing.js';

/**
 * A stranger's browser in front of an app under test, for the tests whose
 * subject is what the app does (routing, hooks, handlers, refusals) rather
 * than the wire: a request goes in the way a consumer's test sends one, and
 * the answer comes back decoded. The tests about the wire itself (event
 * parsing, response finalization, compression, the two gateway formats) build
 * their events by hand with the functions below, because the event is what
 * they test.
 */
export const browse = (lambder: Parameters<typeof lambderTestApp>[0], options: { host?: string; headers?: Record<string, string> } = {}) =>
    lambderTestApp(lambder).visitor(options);

/** Decode a finalized response body: base64-aware, gzip-unaware (tests opt out of gzip by not sending Accept-Encoding). */
export const decodeBody = (result: { body: string | null, isBase64Encoded?: boolean }): string => {
    if(!result.body) return '';
    return result.isBase64Encoded ? Buffer.from(result.body, 'base64').toString() : result.body;
};

/** Decode a gzipped, base64-encoded response body. */
export const gunzipBody = (result: { body: string | null }): string =>
    gunzipSync(Buffer.from(result.body || '', 'base64')).toString('utf8');

/** Decode a Brotli-compressed, base64-encoded response body. */
export const brotliBody = (result: { body: string | null }): string =>
    brotliDecompressSync(Buffer.from(result.body || '', 'base64')).toString('utf8');

export const createMockEvent = (
    reqPath: string,
    overrides: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent => ({
    body: null,
    headers: { Host: 'localhost' },
    multiValueHeaders: {},
    httpMethod: 'GET',
    isBase64Encoded: false,
    path: reqPath,
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
    ...overrides,
});

/**
 * The address the gateway reports for an API event unless a test names its
 * own. A fixed one, because `per: "ip"` counters key off it: with no source
 * IP, every caller in the suite would share the empty-string counter, and a
 * per-caller limit would look the same as a global one.
 */
export const DEFAULT_GATEWAY_SOURCE_IP = '203.0.113.7';

/**
 * A POST to the API path carrying the request envelope. `body` is the whole
 * envelope, so a test can send `payload` plainly, send a compressed
 * `payloadGz` pair, or add guardInputs/idempotencyKey beside it. `sourceIp`
 * is the address the gateway observed (requestContext.identity.sourceIp),
 * which is what ctx.ip reads: a request header cannot name it, since the
 * server trusts none by default.
 */
export const createApiEvent = (
    body: Record<string, unknown>,
    overrides: Partial<APIGatewayProxyEvent> & { sourceIp?: string } = {},
): APIGatewayProxyEvent => {
    const { sourceIp = DEFAULT_GATEWAY_SOURCE_IP, headers, ...eventOverrides } = overrides;
    return createMockEvent('/api', {
        body: JSON.stringify(body),
        httpMethod: 'POST',
        // An API call is JSON, the way every Lambder caller sends one; a test
        // that wants another content type names its own.
        headers: { Host: 'localhost', 'Content-Type': 'application/json', ...headers },
        requestContext: { identity: { sourceIp } } as APIGatewayProxyEvent['requestContext'],
        ...eventOverrides,
    });
};

/** An API Gateway HTTP API (payload v2) event: the shape a Function URL or HTTP API delivers. */
export const createMockEventV2 = (
    reqPath: string,
    overrides: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 => ({
    version: '2.0',
    routeKey: '$default',
    rawPath: reqPath,
    rawQueryString: '',
    headers: { host: 'localhost' },
    requestContext: {
        accountId: '1',
        apiId: 'api',
        domainName: 'localhost',
        domainPrefix: '',
        http: { method: 'GET', path: reqPath, protocol: 'HTTP/1.1', sourceIp: '9.9.9.9', userAgent: 'test' },
        requestId: 'r',
        routeKey: '$default',
        stage: '$default',
        time: '',
        timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
});

export const createMockContext = (): Context => ({
    callbackWaitsForEmptyEventLoop: false,
    functionName: 'test',
    functionVersion: '1',
    invokedFunctionArn: 'arn',
    memoryLimitInMB: '128',
    awsRequestId: '123',
    logGroupName: 'group',
    logStreamName: 'stream',
    getRemainingTimeInMillis: () => 1000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
});

export type { LambderHttpResponse };


// ---------------------------------------------------------------------------
// An in-memory DynamoDB, shared by the policy tests and the store-conformance
// suite: enough of the API for the limiter's conditional ADD counters and the
// idempotency store's conditional put, get and delete.
// ---------------------------------------------------------------------------

type Item = Record<string, AttributeValue>;

const conditionalFailure = (): Error =>
    Object.assign(new Error("conditional request failed"), { name: "ConditionalCheckFailedException" });

/**
 * In-memory DynamoDB covering the limiter's ADD counters and the idempotency
 * put/get/delete, with DynamoDB's own condition semantics: an attribute the
 * condition names but the item does not carry makes a comparison false, not
 * true and not zero, which is what decides whether a record with no readable
 * expiry is claimable or immortal.
 */
export class MemoryDdb extends DynamoDBClient {
    readonly items = new Map<string, Item>();
    failAll = false;

    constructor(){
        super({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
    }

    async send(command: any): Promise<any> {
        if(this.failAll) throw new Error("ddb down");
        const input = command.input;
        const keyOf = (key: any) => `${key.pk.S}|${key.sk.S}`;

        if(command instanceof UpdateItemCommand){
            const k = keyOf(input.Key);
            const existing = this.items.get(k);
            const count = existing ? Number(existing.count?.N ?? 0) : 0;
            const limit = Number(input.ExpressionAttributeValues[":limit"].N);
            if(existing && count >= limit) throw conditionalFailure();
            this.items.set(k, {
                pk: input.Key.pk, sk: input.Key.sk,
                count: { N: String(count + 1) },
                expiresAt: existing?.expiresAt ?? input.ExpressionAttributeValues[":expiresAt"],
            });
            return {};
        }
        if(command instanceof PutItemCommand){
            const k = keyOf(input.Item);
            const existing = this.items.get(k);
            const nowOf = () => Number(input.ExpressionAttributeValues?.[":now"]?.N ?? Math.floor(Date.now() / 1000));
            // DynamoDB evaluates a comparison whose operand path is missing,
            // or whose stored value is not a number, as FALSE. Reading a
            // missing expiresAt as 0 (expired) would give the opposite answer
            // and hide a claim condition that refuses such an item for ever.
            const expiryPassed = (item: Item | undefined, now: number): boolean => {
                const expiresAt = Number(item?.expiresAt?.N);
                return Number.isFinite(expiresAt) && expiresAt <= now;
            };
            if(input.ConditionExpression?.includes("attribute_not_exists(pk)") && existing){
                const now = nowOf();
                const claimable = (input.ConditionExpression.includes("attribute_not_exists(expiresAt)") && existing.expiresAt === undefined)
                    || expiryPassed(existing, now);
                // ALL_OLD hands the item that refused the write back with the
                // failure, as DynamoDB does.
                if(!claimable) throw Object.assign(conditionalFailure(), input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" ? { Item: { ...existing } } : {});
            }
            // Matched by clause rather than by whole-string equality: an
            // exact-string match would silently become an unconditional write
            // the moment the store's expression changed, which is the one
            // failure a double like this must not have.
            if(input.ConditionExpression?.includes("ownerToken = :owner")){
                if(existing?.ownerToken?.S !== input.ExpressionAttributeValues?.[":owner"]?.S) throw conditionalFailure();
            }
            if(input.ConditionExpression?.includes("expiresAt > :now")){
                const now = nowOf();
                const live = Number.isFinite(Number(existing?.expiresAt?.N)) && Number(existing?.expiresAt?.N) > now;
                if(!live) throw conditionalFailure();
            }
            this.items.set(k, input.Item);
            return {};
        }
        if(command instanceof GetItemCommand){
            return { Item: this.items.get(keyOf(input.Key)) };
        }
        if(command instanceof DeleteItemCommand){
            const existing = this.items.get(keyOf(input.Key));
            if(input.ConditionExpression?.includes("ownerToken = :owner")){
                if(existing?.ownerToken?.S !== input.ExpressionAttributeValues?.[":owner"]?.S) throw conditionalFailure();
            }
            if(input.ConditionExpression?.includes("#state = :pending")){
                if(existing?.[input.ExpressionAttributeNames["#state"]]?.S !== input.ExpressionAttributeValues?.[":pending"]?.S) throw conditionalFailure();
            }
            this.items.delete(keyOf(input.Key));
            return {};
        }
        throw new Error("MemoryDdb: unhandled command " + command?.constructor?.name);
    }
}

// ---------------------------------------------------------------------------
// An in-memory DynamoDB DOCUMENT client, for the stores that speak lib-dynamodb
// rather than the low-level client: plain JS values, no AttributeValue wrapping.
// Enough of the API for the session store's get, put, delete, partition query
// and conditional update, so one conformance suite can drive the DynamoDB
// session store beside the in-memory one.
// ---------------------------------------------------------------------------

/**
 * Keyed by the table's own key attribute NAMES, which the store configures, so
 * this double works whichever names a test gives it.
 */
export class MemoryDdbDocument {
    readonly items = new Map<string, Record<string, any>>();
    failAll = false;

    constructor(private readonly partitionKey = "pk", private readonly sortKey = "sk"){}

    private keyOf(source: Record<string, any>): string {
        return `${String(source[this.partitionKey])}|${String(source[this.sortKey])}`;
    }

    async send(command: any): Promise<any> {
        if(this.failAll) throw new Error("ddb down");
        const input = command?.input ?? {};
        const name = command?.constructor?.name ?? "";

        if(name.startsWith("Put")){
            if(!this.conditionHolds(input, this.items.get(this.keyOf(input.Item)))) throw this.conditionalFailure();
            this.items.set(this.keyOf(input.Item), { ...input.Item });
            return {};
        }
        if(name.startsWith("Get")){
            const item = this.items.get(this.keyOf(input.Key));
            return item ? { Item: { ...item } } : {};
        }
        if(name.startsWith("Delete")){
            const key = this.keyOf(input.Key);
            const removed = this.items.get(key);
            this.items.delete(key);
            return removed && input.ReturnValues === "ALL_OLD" ? { Attributes: { ...removed } } : {};
        }
        if(name.startsWith("Query")){
            // Only the shape the session store sends: one partition, equality.
            const partitionAttribute = input.ExpressionAttributeNames?.["#pk"] ?? this.partitionKey;
            const wanted = input.ExpressionAttributeValues?.[":pv"];
            const Items = [...this.items.values()]
                .filter((item) => item[partitionAttribute] === wanted)
                .map((item) => ({ ...item }));
            return { Items };
        }
        if(name.startsWith("Update")){
            const key = this.keyOf(input.Key);
            const existing = this.items.get(key);
            // attribute_exists on the sort key is how the store asks "is this
            // record still here", and a missing record must fail the condition
            // rather than create a stub.
            // A refusal hands back the item it found when asked to, as DynamoDB
            // does, so the store can tell a moved record from a missing one.
            if(!this.conditionHolds(input, existing)){
                throw Object.assign(this.conditionalFailure(), existing && input.ReturnValuesOnConditionCheckFailure === "ALL_OLD" ? { Item: { ...existing } } : {});
            }
            const names = input.ExpressionAttributeNames ?? {};
            const values = input.ExpressionAttributeValues ?? {};
            const updated: Record<string, any> = { ...(existing ?? input.Key) };
            const expression: string = input.UpdateExpression ?? "";
            const clauseOf = (keyword: string) => new RegExp(`${keyword}\\s+(.*?)(?=\\s+(?:SET|REMOVE|ADD)\\s|$)`).exec(expression)?.[1];
            const setClause = clauseOf("SET");
            const removeClause = clauseOf("REMOVE");
            const addClause = clauseOf("ADD");
            if(!setClause && !removeClause && !addClause) throw new Error("MemoryDdbDocument: unsupported UpdateExpression " + expression);
            for(const assignment of setClause?.split(",") ?? []){
                const [attribute, value] = assignment.split("=").map((part) => part.trim());
                updated[names[attribute!] ?? attribute!] = values[value!];
            }
            // ADD on a number: an absent attribute counts from zero.
            for(const addition of addClause?.split(",") ?? []){
                const [attribute, value] = addition.trim().split(/\s+/);
                const target = names[attribute!] ?? attribute!;
                updated[target] = (updated[target] ?? 0) + values[value!];
            }
            for(const attribute of removeClause?.split(",").map((part) => part.trim()) ?? []){
                delete updated[names[attribute] ?? attribute];
            }
            this.items.set(key, updated);
            return {};
        }
        throw new Error("MemoryDdbDocument: unhandled command " + name);
    }

    /** The condition shapes the session store writes: attribute_exists, attribute_not_exists and equality, joined by AND. */
    private conditionHolds(input: Record<string, any>, existing: Record<string, any> | undefined): boolean {
        const condition: string | undefined = input.ConditionExpression;
        if(!condition) return true;
        const names = input.ExpressionAttributeNames ?? {};
        const values = input.ExpressionAttributeValues ?? {};
        return condition.split(/\s+AND\s+/).every((clause) => {
            const exists = /^attribute_exists\((#\w+)\)$/.exec(clause);
            if(exists) return existing !== undefined && existing[names[exists[1]!] ?? exists[1]!] !== undefined;
            const absent = /^attribute_not_exists\((#\w+)\)$/.exec(clause);
            if(absent) return existing === undefined || existing[names[absent[1]!] ?? absent[1]!] === undefined;
            const equal = /^(#\w+)\s*=\s*(:\w+)$/.exec(clause);
            if(equal) return existing !== undefined && existing[names[equal[1]!] ?? equal[1]!] === values[equal[2]!];
            throw new Error("MemoryDdbDocument: unsupported ConditionExpression " + condition);
        });
    }

    private conditionalFailure(): Error {
        return Object.assign(new Error("conditional request failed"), { name: "ConditionalCheckFailedException" });
    }
}

/**
 * The file source every server test builds its instance on. The directory
 * is never read by these tests (they exercise routes and APIs, not files),
 * so one factory stands in for the same literal in every describe block.
 */
export const testPublicFiles = (): LambderLocalFileSource => new LambderLocalFileSource({ root: './public' });
