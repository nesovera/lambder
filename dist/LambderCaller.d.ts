import { LambderApiResponse } from './LambderResponseBuilder';
type VoidFunction = () => void | Promise<void>;
type FetchTracker = {
    apiName: string;
    done: boolean;
    fetchEndCalled: boolean;
};
type EventHandlerFetchParams = {
    apiName: string;
    payload?: any;
    headers?: Record<string, any>;
};
type FetchStartEventHandler = (params: {
    fetchParams: EventHandlerFetchParams;
    activeFetchList: FetchTracker[];
}) => void | Promise<void>;
type FetchEndEventHandler = (params: {
    fetchParams: EventHandlerFetchParams;
    fetchResult: any;
    activeFetchList: FetchTracker[];
}) => void | Promise<void>;
type ErrorHandler = (err: Error) => void | Promise<void>;
type MessageHandler = (message: any) => void | Promise<void>;
export default class LambderCaller {
    private isCorsEnabled;
    private apiPath;
    private apiVersion?;
    fetchTrackerList: FetchTracker[];
    isLoading: boolean;
    private versionExpiredHandler?;
    private sessionExpiredHandler?;
    private messageHandler?;
    private errorMessageHandler?;
    private notAuthorizedHandler?;
    private errorHandler?;
    private fetchStartedHandler?;
    private fetchEndedHandler?;
    private sessionTokenCookieKey;
    private sessionCsrfCookieKey;
    constructor({ apiPath, apiVersion, isCorsEnabled, versionExpiredHandler, sessionExpiredHandler, messageHandler, errorMessageHandler, notAuthorizedHandler, errorHandler, fetchStartedHandler, fetchEndedHandler, }: {
        apiPath: string;
        apiVersion?: string;
        isCorsEnabled: boolean;
        versionExpiredHandler?: VoidFunction;
        sessionExpiredHandler?: VoidFunction;
        messageHandler?: MessageHandler;
        errorMessageHandler?: MessageHandler;
        notAuthorizedHandler?: VoidFunction;
        errorHandler?: ErrorHandler;
        fetchStartedHandler?: FetchStartEventHandler;
        fetchEndedHandler?: FetchEndEventHandler;
    });
    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string): void;
    apiRaw<T = any>(apiName: string, payload?: any, options?: {
        headers?: Record<string, any>;
        versionExpiredHandler?: VoidFunction;
        sessionExpiredHandler?: VoidFunction;
        messageHandler?: MessageHandler;
        errorMessageHandler?: MessageHandler;
        notAuthorizedHandler?: VoidFunction;
        errorHandler?: ErrorHandler;
        fetchStartedHandler?: FetchStartEventHandler;
        fetchEndedHandler?: FetchEndEventHandler;
    }): Promise<LambderApiResponse<T> | null | undefined>;
    api<T = any>(...params: Parameters<typeof LambderCaller.prototype.apiRaw>): Promise<T | null | undefined>;
}
export {};
