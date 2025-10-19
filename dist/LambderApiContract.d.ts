/**
 * Type-safe API Contract System
 *
 * Define your API contract as a TypeScript type to get full type safety
 * across frontend and backend with no runtime overhead.
 *
 * Example:
 *
 * export type MyApiContract = {
 *     getUserById: { input: { userId: string }, output: User },
 *     createUser: { input: CreateUserInput, output: User },
 *     listUsers: { input: void, output: User[] }
 * }
 *
 * Frontend:
 * const caller = new LambderCaller<MyApiContract>({ ... });
 * const user = await caller.api('getUserById', { userId: '123' }); // typed!
 *
 * Backend:
 * const lambder = new Lambder<MyApiContract>({ ... });
 * lambder.addApi('getUserById', async (ctx, resolver) => {
 *     // ctx.apiPayload is typed as { userId: string }
 *     return resolver.api(user); // user is typed as User
 * });
 */
/**
 * Base type for API contracts
 */
export type ApiContract = {
    [apiName: string]: {
        input: any;
        output: any;
    };
};
/**
 * Extract input type from contract for a specific API
 */
export type ApiInput<TContract extends ApiContract, TApiName extends keyof TContract> = TContract[TApiName]['input'];
/**
 * Extract output type from contract for a specific API
 */
export type ApiOutput<TContract extends ApiContract, TApiName extends keyof TContract> = TContract[TApiName]['output'];
