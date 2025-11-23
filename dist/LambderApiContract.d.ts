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
}>;
/**
 * Helper type for merging new API into existing contract during chaining
 */
export type MergeContract<Old, Name extends string, In, Out> = Old & {
    [K in Name]: {
        input: In;
        output: Out;
    };
};
