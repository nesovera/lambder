export default class LambderMSW {
    apiPath;
    apiVersion;
    http;
    HttpResponse;
    constructor({ apiPath, apiVersion, }) {
        this.apiPath = apiPath;
        this.apiVersion = apiVersion;
        // Dynamically import MSW - it needs to be installed by the user
        try {
            const msw = require('msw');
            this.http = msw.http;
            this.HttpResponse = msw.HttpResponse;
        }
        catch (err) {
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
    mockApi(apiName, handler, options) {
        return this.http.post(this.apiPath, async ({ request }) => {
            let body;
            try {
                const clonedRequest = request.clone();
                body = await clonedRequest.json();
            }
            catch (parseErr) {
                // If JSON parsing fails, return undefined to let other handlers try
                console.warn("LambderMSW: Failed to parse request body as JSON");
                return;
            }
            // Check if body is valid and has apiName
            if (!body || typeof body.apiName !== 'string') {
                return;
            }
            if (body.apiName !== apiName) {
                return;
            }
            console.log("LambderMSW called for:", body.apiName);
            try {
                // Add artificial delay if specified
                if (options?.delay) {
                    await new Promise(resolve => setTimeout(resolve, options.delay));
                }
                // Call the handler with the payload from the request
                const payload = await handler(body.payload);
                console.log("Matched! Returning payload for:", apiName);
                const response = {
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
            }
            catch (err) {
                // Only handle errors that occur during handler execution for matched APIs
                console.error("Error in LambderMSW handler for", apiName, ":", err);
                const errorResponse = {
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
    mockSessionExpired(apiName) {
        return this.mockApi(apiName, async () => null, { sessionExpired: true });
    }
    /**
     * Mock an API endpoint that returns a version expired error
     */
    mockVersionExpired(apiName) {
        return this.mockApi(apiName, async () => null, { versionExpired: true });
    }
    /**
     * Mock an API endpoint that returns a not authorized error
     */
    mockNotAuthorized(apiName) {
        return this.mockApi(apiName, async () => null, { notAuthorized: true });
    }
    /**
     * Mock an API endpoint that returns an error message
     */
    mockError(apiName, errorMessage) {
        return this.mockApi(apiName, async () => null, { errorMessage });
    }
    /**
     * Mock an API endpoint with a custom message
     */
    mockWithMessage(apiName, handler, message) {
        return this.mockApi(apiName, handler, { message });
    }
}
