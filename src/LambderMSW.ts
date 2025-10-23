import type { ApiContractShape } from './LambderApiContract';
import type { LambderApiResponse } from './LambderResponseBuilder';

// MSW types - these will be resolved at runtime when msw is installed
type RequestHandler = any;

type MockApiOptions = {
    versionExpired?: boolean;
    sessionExpired?: boolean;
    notAuthorized?: boolean;
    message?: any;
    errorMessage?: any;
    logList?: any[];
    delay?: number; // Add artificial delay to simulate network latency
};

// Extended response type that includes apiVersion
type MockApiResponse<T> = {
    apiVersion?: string;
} & LambderApiResponse<T>;

export default class LambderMSW<TContract extends ApiContractShape = any> {
    private apiPath: string;
    private apiVersion?: string;
    private http: any;
    private HttpResponse: any;

    constructor({
        apiPath,
        apiVersion,
    }: {
        apiPath: string;
        apiVersion?: string;
    }) {
        this.apiPath = apiPath;
        this.apiVersion = apiVersion;
        
        // Dynamically import MSW - it needs to be installed by the user
        try {
            const msw = require('msw');
            this.http = msw.http;
            this.HttpResponse = msw.HttpResponse;
        } catch (err) {
            throw new Error('MSW (Mock Service Worker) is required. Install it with: npm install msw --save-dev');
        }
    }

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
    mockApi<TApiName extends keyof TContract>(
        apiName: TApiName,
        handler: (payload?: TContract[TApiName]['input']) => Promise<TContract[TApiName]['output']> | TContract[TApiName]['output'],
        options?: MockApiOptions
    ): RequestHandler {
        return this.http.post(this.apiPath, async ({ request }: any) => {
            let body: any;
            
            try {
                const clonedRequest = request.clone();
                body = await clonedRequest.json();
            } catch (parseErr) {
                // If JSON parsing fails, return undefined to let other handlers try
                console.warn("LambderMSW: Failed to parse request body as JSON");
                return;
            }
            
            // Check if body is valid and has apiName
            if (!body || typeof body.apiName !== 'string') { return; }
            if (body.apiName !== apiName) { return; }
            
            console.log("LambderMSW called for:", body.apiName);
            
            try {
                // Add artificial delay if specified
                if (options?.delay) {
                    await new Promise(resolve => setTimeout(resolve, options.delay));
                }

                // Call the handler with the payload from the request
                const payload = await handler(body.payload as TContract[TApiName]['input']);
                
                console.log("Matched! Returning payload for:", apiName);

                const response: MockApiResponse<TContract[TApiName]['output']> = {
                    apiVersion: this.apiVersion,
                    payload,
                    ...(options?.versionExpired ? { versionExpired: options.versionExpired } : {}),
                    ...(options?.sessionExpired ? { sessionExpired: options.sessionExpired } : {}),
                    ...(options?.notAuthorized ? { notAuthorized: options.notAuthorized } : {}),
                    ...(options?.message ? { message: options.message } : {}),
                    ...(options?.errorMessage ? { errorMessage: options.errorMessage } : {}),
                    ...(options?.logList?.length ? { logList: options.logList } : {}),
                };

                return this.HttpResponse.json(response);
            } catch (err: any) {
                // Only handle errors that occur during handler execution for matched APIs
                console.error("Error in LambderMSW handler for", apiName, ":", err);
                
                const errorResponse: MockApiResponse<null> = {
                    apiVersion: this.apiVersion,
                    payload: null,
                    errorMessage: err.message || "Unknown error",
                };

                return this.HttpResponse.json(errorResponse, { status: 500 });
            }
        });
    }

    /**
     * Mock an API endpoint that returns a session expired error
     */
    mockSessionExpired<TApiName extends keyof TContract>(
        apiName: TApiName
    ): RequestHandler {
        return this.mockApi(
            apiName,
            async () => null as any,
            { sessionExpired: true }
        );
    }

    /**
     * Mock an API endpoint that returns a version expired error
     */
    mockVersionExpired<TApiName extends keyof TContract>(
        apiName: TApiName
    ): RequestHandler {
        return this.mockApi(
            apiName,
            async () => null as any,
            { versionExpired: true }
        );
    }

    /**
     * Mock an API endpoint that returns a not authorized error
     */
    mockNotAuthorized<TApiName extends keyof TContract>(
        apiName: TApiName
    ): RequestHandler {
        return this.mockApi(
            apiName,
            async () => null as any,
            { notAuthorized: true }
        );
    }

    /**
     * Mock an API endpoint that returns an error message
     */
    mockError<TApiName extends keyof TContract>(
        apiName: TApiName,
        errorMessage: string
    ): RequestHandler {
        return this.mockApi(
            apiName,
            async () => null as any,
            { errorMessage }
        );
    }

    /**
     * Mock an API endpoint with a custom message
     */
    mockWithMessage<TApiName extends keyof TContract>(
        apiName: TApiName,
        handler: (payload?: TContract[TApiName]['input']) => Promise<TContract[TApiName]['output']> | TContract[TApiName]['output'],
        message: any
    ): RequestHandler {
        return this.mockApi(apiName, handler, { message });
    }
}

