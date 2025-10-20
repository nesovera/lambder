import type { ApiContractShape } from './LambderApiContract';
type RequestHandler = any;
type MockApiOptions = {
    versionExpired?: boolean;
    sessionExpired?: boolean;
    notAuthorized?: boolean;
    message?: any;
    errorMessage?: any;
    logList?: any[];
    delay?: number;
};
export default class LambderMSW<TContract extends ApiContractShape = any> {
    private apiPath;
    private apiVersion?;
    private http;
    private HttpResponse;
    constructor({ apiPath, apiVersion, }: {
        apiPath: string;
        apiVersion?: string;
    });
    /**
     * Mock an API endpoint with MSW
     * @param apiName - The name of the API to mock
     * @param handler - Function that returns the mock payload
     * @param options - Additional response options (session expired, version expired, etc.)
     *
     * Note: TypeScript will check that the return type is assignable to the output type,
     * but due to structural typing, extra properties are allowed. Enable strict checks
     * in your tsconfig.json with "noUncheckedIndexedAccess" and "exactOptionalPropertyTypes"
     * for better type safety.
     */
    mockApi<TApiName extends keyof TContract>(apiName: TApiName, handler: (payload?: TContract[TApiName]['input']) => Promise<TContract[TApiName]['output']> | TContract[TApiName]['output'], options?: MockApiOptions): RequestHandler;
    /**
     * Mock an API endpoint that returns a session expired error
     */
    mockSessionExpired<TApiName extends keyof TContract>(apiName: TApiName): RequestHandler;
    /**
     * Mock an API endpoint that returns a version expired error
     */
    mockVersionExpired<TApiName extends keyof TContract>(apiName: TApiName): RequestHandler;
    /**
     * Mock an API endpoint that returns a not authorized error
     */
    mockNotAuthorized<TApiName extends keyof TContract>(apiName: TApiName): RequestHandler;
    /**
     * Mock an API endpoint that returns an error message
     */
    mockError<TApiName extends keyof TContract>(apiName: TApiName, errorMessage: string): RequestHandler;
    /**
     * Mock an API endpoint with a custom message
     */
    mockWithMessage<TApiName extends keyof TContract>(apiName: TApiName, handler: (payload?: TContract[TApiName]['input']) => Promise<TContract[TApiName]['output']> | TContract[TApiName]['output'], message: any): RequestHandler;
}
export {};
