/**
 * Lambder API Contract System
 *
 * Contracts are built via method chaining and inferred using typeof lambder.ApiContract
 */

/**
 * Base shape for API contracts - used by LambderCaller and LambderMSW
 */
export type ApiContractShape = Record<string, {
    input: any;
    output: any;
    /** Present when the API declares guardInput-mode guards: guard name -> value the client must send via options.guardInputs. */
    guardInputs?: any;
}>;

/** Envelope flags/channels the server may set beside (or instead of) the payload. */
export type LambderApiResponseConfig = {
    versionExpired?: boolean;
    sessionExpired?: boolean;
    notAuthorized?: boolean;
    message?: any;
    errorMessage?: any;
    logList?: any[];
}

/** The API wire envelope both sides speak: res.api() emits it, LambderCaller parses it. */
export type LambderApiResponse<T> = LambderApiResponseConfig & {
    apiVersion?: string | null;
    payload?: T | null;
}

/**
 * Helper type for merging new API into existing contract during chaining
 */
export type MergeContract<Old, Name extends string, In, Out, GuardInputs = never> =
    Old & { [K in Name]: [GuardInputs] extends [never]
        ? { input: In, output: Out }
        : { input: In, output: Out, guardInputs: GuardInputs } };
