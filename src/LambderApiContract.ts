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

/**
 * Helper type for merging new API into existing contract during chaining
 */
export type MergeContract<Old, Name extends string, In, Out, GuardInputs = never> =
    Old & { [K in Name]: [GuardInputs] extends [never]
        ? { input: In, output: Out }
        : { input: In, output: Out, guardInputs: GuardInputs } };
