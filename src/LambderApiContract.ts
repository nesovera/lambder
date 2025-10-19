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
 * 
 * Use this as a constraint when defining your API contract:
 * 
 * export type MyApiContract = {
 *     echo: { input: { message: string }, output: { echo: string } }
 * } satisfies ApiContract;
 * 
 * Or for backward compatibility without satisfies:
 * 
 * export type MyApiContract = ApiContract & {
 *     echo: { input: { message: string }, output: { echo: string } }
 * }
 */
export type ApiContractShape = Record<string, {
    input: any;
    output: any;
}>

export type ApiContract<T extends ApiContractShape> = T;

/**
 * Extract input type from contract for a specific API
 */
export type ApiInput<
    TContract extends ApiContractShape,
    TApiName extends keyof TContract
> = TContract[TApiName]['input'];

/**
 * Extract output type from contract for a specific API
 */
export type ApiOutput<
    TContract extends ApiContractShape,
    TApiName extends keyof TContract
> = TContract[TApiName]['output'];
