import Cookies from 'js-cookie';
import { LambderApiResponse } from './LambderResponseBuilder';
import type { ApiContractShape } from './LambderApiContract';

type VoidFunction = ()=>void|Promise<void>;
type FetchTracker = { apiName: string, done: boolean, fetchEndCalled: boolean };
type EventHandlerFetchParams = { 
    apiName: string, 
    payload?: any, 
    headers?: Record<string, any>
};

type FetchStartEventHandler = (params: { 
    fetchParams: EventHandlerFetchParams, 
    activeFetchList: FetchTracker[],
})=>void|Promise<void>;

type FetchEndEventHandler = (params: { 
    fetchParams: EventHandlerFetchParams, 
    fetchResult: any,
    activeFetchList: FetchTracker[],
})=>void|Promise<void>;

type ErrorHandler = (err: Error) => void|Promise<void>;
type MessageHandler = (message:any) => void|Promise<void>;

export default class LambderCaller<TContract extends ApiContractShape = any> {
    private isCorsEnabled: boolean;
    private apiPath: string;
    private apiVersion?: string; 

    fetchTrackerList: FetchTracker[] = [];
    isLoading: boolean = false;

    private versionExpiredHandler?: VoidFunction;
    private sessionExpiredHandler?: VoidFunction;

    private messageHandler?: MessageHandler;
    private errorMessageHandler?: MessageHandler;
    private notAuthorizedHandler?: VoidFunction;
    private errorHandler?: ErrorHandler;
    
    private fetchStartedHandler?: FetchStartEventHandler;
    private fetchEndedHandler?: FetchEndEventHandler;

    private sessionTokenCookieKey = "LMDRSESSIONTKID";
    private sessionCsrfCookieKey = "LMDRSESSIONCSTK";

    constructor(
        { 
            apiPath, apiVersion, 
            isCorsEnabled = false, 
            versionExpiredHandler, sessionExpiredHandler, 
            messageHandler, errorMessageHandler,
            notAuthorizedHandler, errorHandler,
            fetchStartedHandler, fetchEndedHandler,
        }: 
        { 
            apiPath: string,
            apiVersion?: string,
            isCorsEnabled: boolean, 
            versionExpiredHandler?: VoidFunction, 
            sessionExpiredHandler?: VoidFunction, 
            messageHandler?: MessageHandler,
            errorMessageHandler?: MessageHandler,
            notAuthorizedHandler?: VoidFunction, 
            errorHandler?: ErrorHandler, 
            fetchStartedHandler?: FetchStartEventHandler, 
            fetchEndedHandler?: FetchEndEventHandler,
        }
    ){
        this.apiPath = apiPath ?? "/api";
        this.apiVersion = apiVersion;
        this.isCorsEnabled = isCorsEnabled;

        this.versionExpiredHandler = versionExpiredHandler;
        this.sessionExpiredHandler = sessionExpiredHandler;

        this.messageHandler = messageHandler;
        this.errorMessageHandler = errorMessageHandler;
        this.notAuthorizedHandler = notAuthorizedHandler;
        this.errorHandler = errorHandler;
        
        this.fetchStartedHandler = fetchStartedHandler; 
        this.fetchEndedHandler = fetchEndedHandler;

    };

    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string){
        this.sessionTokenCookieKey = sessionTokenCookieKey;
        this.sessionCsrfCookieKey = sessionCsrfCookieKey;
    }
    
    async apiRaw<
        TApiName extends keyof TContract & string = string,
        TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any
    >(
        apiName: TApiName,
        payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any,
        options?: {
            headers?: Record<string, any>
            versionExpiredHandler?: VoidFunction, 
            sessionExpiredHandler?: VoidFunction, 
            messageHandler?: MessageHandler,
            errorMessageHandler?: MessageHandler,
            notAuthorizedHandler?: VoidFunction, 
            errorHandler?: ErrorHandler, 
            fetchStartedHandler?: FetchStartEventHandler, 
            fetchEndedHandler?: FetchEndEventHandler,
        }
    ): Promise<LambderApiResponse<TOutput>|null|undefined>{
        const headers = options?.headers;
        const fetchTracker: FetchTracker = { apiName, done: false, fetchEndCalled: false };
        try {
            this.fetchTrackerList.push(fetchTracker);
            if(this.fetchStartedHandler) await this.fetchStartedHandler({
                fetchParams: { apiName, payload, headers, },
                activeFetchList: this.fetchTrackerList.filter(v=>!v.done)
            });
            const version = this.apiVersion;
            const token = Cookies.get(this.sessionCsrfCookieKey) || "";
            const siteHost = window.location.hostname;
            let data = await fetch(this.apiPath, {
                method: 'POST', mode: 'same-origin', cache: 'no-cache',
                credentials: 'same-origin', redirect: 'follow', referrerPolicy: 'origin',
                headers: { 'Content-Type': 'application/json', ...(headers || {}) },
                body: JSON.stringify({ apiName, version, token, siteHost, payload, }),
            }).then(async (res)=>{
                if(res.status >= 500) throw new Error("Request failed: " + res.status + " - " + res.statusText);
                if(res.headers.get("Content-Type")?.includes("application/lambder-json-stream")){ 
                    const decompressed = res.json();
                    return decompressed;
                }else{
                    return res.json();
                }
            }) as LambderApiResponse<TOutput>;
            fetchTracker.done = true;
            if(this.fetchEndedHandler){
                fetchTracker.fetchEndCalled = true;
                await this.fetchEndedHandler({
                    fetchParams: { apiName, payload, headers },
                    fetchResult: data,
                    activeFetchList: this.fetchTrackerList.filter(v=>!v.done),
                });
            }
            if(data && data.logList?.length){
                for(const record of data.logList){
                    console.log("LogToApiResponse:", record);
                }
            }
            if(data && data.versionExpired){
                if(this.versionExpiredHandler){
                    await this.versionExpiredHandler();
                }else if(this.errorHandler){
                    await this.errorHandler(new Error("Version Expired; Please refresh;"));
                }
                return null;
            }
            if(data && data.sessionExpired){ 
                Cookies.set(this.sessionTokenCookieKey, '', { expires: -1 });
                Cookies.set(this.sessionCsrfCookieKey, '', { expires: -1 });
                if(this.sessionExpiredHandler){
                    await this.sessionExpiredHandler();
                }else if(this.errorHandler){
                    await this.errorHandler(new Error("Version Expired; Please refresh;"));
                }
                return null;
            }
            if(data && data.notAuthorized){
                if(this.notAuthorizedHandler){
                    await this.notAuthorizedHandler();
                }else if(this.errorHandler){
                    await this.errorHandler(new Error("Not Authorized;"));
                }
                return null;
            }
            if(data && data.message && this.messageHandler){
                await this.messageHandler(data.message);
            }
            if(data && data.errorMessage && this.errorMessageHandler){
                await this.errorMessageHandler(data.errorMessage);
            }
            return data;
        }catch(err){
            const wrappedError = err instanceof Error ? err : new Error("Error: " + String(err));
            fetchTracker.done = true;
            if(!fetchTracker.fetchEndCalled && this.fetchEndedHandler){
                await this.fetchEndedHandler({
                    fetchParams: { apiName, payload, headers, },
                    fetchResult: wrappedError,
                    activeFetchList: this.fetchTrackerList.filter(v=>!v.done)
                });
            }
            if(this.errorHandler){ this.errorHandler(wrappedError); }
            return null;
        }
    };
    
    // Use the same type for api but adjust the return type
    async api<
        TApiName extends keyof TContract & string = string,
        TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any
    >(
        apiName: TApiName,
        payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any,
        options?: {
            headers?: Record<string, any>
            versionExpiredHandler?: VoidFunction, 
            sessionExpiredHandler?: VoidFunction, 
            messageHandler?: MessageHandler,
            errorMessageHandler?: MessageHandler,
            notAuthorizedHandler?: VoidFunction, 
            errorHandler?: ErrorHandler, 
            fetchStartedHandler?: FetchStartEventHandler, 
            fetchEndedHandler?: FetchEndEventHandler,
        }
    ): Promise<TOutput|null|undefined> {
        const result = await this.apiRaw<TApiName, TOutput>(apiName, payload, options);
        return result?.payload;
    }

}
