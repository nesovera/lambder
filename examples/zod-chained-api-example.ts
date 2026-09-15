/**
 * Chained Zod APIs: one declaration that starts at creation and accumulates a
 * contract, plus the `use()` plugin shape an api module takes.
 *
 * The instance comes from `initLambder().create({...})` rather than from
 * `new Lambder({...})`: type arguments are all-or-nothing per call in
 * TypeScript, so passing one to the constructor widens the inferred policy and
 * guard types, and the curried creator is what lets every one of them be
 * inferred from the options. `initLambder<SessionData>()` fixes the session
 * data type first when there is one; this sketch keeps no sessions, so it
 * takes none.
 */

import { z } from "zod";
import { initLambder, LambderLocalFileSource } from "../src/index.js";

// 1. Define reusable schemas
const UserSchema = z.object({
    id: z.string(),
    name: z.string(),
    email: z.email(),
});

const CreateUserSchema = z.object({
    name: z.string(),
    email: z.email(),
});

// 2. Create the instance and chain the APIs onto the creation call. Every
//    registration returns an instance carrying the contract so far, so calling
//    addApi as its own statement would discard what the contract accumulated
//    onto and leave `typeof lambder.ApiContract` empty.
const lambder = initLambder().create({
    files: new LambderLocalFileSource({ root: "./public" }),
    apiPath: "/api",
})
    .addApi("getUser", {
        input: z.object({ userId: z.string() }),
        output: UserSchema
    }, async (ctx, resolver) => {
        // ctx.apiPayload is typed as { userId: string }
        const { userId } = ctx.apiPayload;

        return resolver.api({
            id: userId,
            name: "John Doe",
            email: "john@example.com"
        });
    })
    .addApi("createUser", {
        input: CreateUserSchema,
        output: UserSchema
    }, async (ctx, resolver) => {
        // ctx.apiPayload is typed as { name: string, email: string }
        const { name, email } = ctx.apiPayload;

        return resolver.api({
            id: "123",
            name,
            email
        });
    });

// 3. Export the inferred contract type for frontend use
export type ApiContractType = typeof lambder.ApiContract;

// 4. Modular example using .use(). An api module takes the app's own type, so
//    the contract it adds to is the one the app has accumulated so far.
type ChainedApiLambder = typeof lambder;

const authApi = (moduleLambder: ChainedApiLambder) => {
    return moduleLambder.addApi("login", {
        input: z.object({ username: z.string(), password: z.string() }),
        output: z.object({ token: z.string() })
    }, async (ctx, resolver) => {
        return resolver.api({ token: "abc-123" });
    });
};

const _lambderWithAuth = lambder.use(authApi);

export type AuthContract = typeof _lambderWithAuth.ApiContract;
