import { LambderApiResponse } from './LambderResponseBuilder';
import type { ApiContractShape } from './LambderApiContract';
import type { z } from "zod";
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
type ValidationErrorHandler = (zodError: z.ZodError) => (void | false) | Promise<(void | false)>;
type MessageHandler = (message: any) => void | Promise<void>;
export default class LambderCaller<TContract extends ApiContractShape = any> {
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
    private apiInputValidationErrorHandler?;
    private fetchStartedHandler?;
    private fetchEndedHandler?;
    private sessionTokenCookieKey;
    private sessionCsrfCookieKey;
    constructor({ apiPath, apiVersion, isCorsEnabled, versionExpiredHandler, sessionExpiredHandler, messageHandler, errorMessageHandler, notAuthorizedHandler, errorHandler, fetchStartedHandler, fetchEndedHandler, apiInputValidationErrorHandler, }: {
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
        apiInputValidationErrorHandler?: ValidationErrorHandler;
    });
    setSessionCookieKey(sessionTokenCookieKey: string, sessionCsrfCookieKey: string): void;
    apiRaw<TApiName extends keyof TContract & string = string, TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any>(apiName: TApiName, payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any, options?: {
        headers?: Record<string, any>;
        versionExpiredHandler?: VoidFunction;
        sessionExpiredHandler?: VoidFunction;
        messageHandler?: MessageHandler;
        errorMessageHandler?: MessageHandler;
        apiInputValidationErrorHandler?: ValidationErrorHandler;
        notAuthorizedHandler?: VoidFunction;
        errorHandler?: ErrorHandler;
        fetchStartedHandler?: FetchStartEventHandler;
        fetchEndedHandler?: FetchEndEventHandler;
    }): Promise<LambderApiResponse<TOutput> | null | undefined>;
    api<TApiName extends keyof TContract & string = string, TOutput = TApiName extends keyof TContract ? TContract[TApiName]['output'] : any>(apiName: TApiName, payload?: TApiName extends keyof TContract ? TContract[TApiName]['input'] : any, options?: {
        headers?: Record<string, any>;
        versionExpiredHandler?: VoidFunction;
        sessionExpiredHandler?: VoidFunction;
        messageHandler?: MessageHandler;
        errorMessageHandler?: MessageHandler;
        notAuthorizedHandler?: VoidFunction;
        errorHandler?: ErrorHandler;
        fetchStartedHandler?: FetchStartEventHandler;
        fetchEndedHandler?: FetchEndEventHandler;
    }): Promise<TOutput | null | undefined>;
}
export {};
