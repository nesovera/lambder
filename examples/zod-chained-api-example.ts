/**
 * Zod endpoints as values: each one declared with the instance's defineApi,
 * gathered into a named group the way an api module exports it, and every
 * group registered in one call, whose result carries the contract a
 * frontend imports as a type.
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

// 2. Create the instance. It registers nothing yet: its defineApi and
//    defineApiGroup are what the api modules import, and every endpoint they
//    declare is typed against this instance's options.
const lambderApp = initLambder().create({
    files: new LambderLocalFileSource({ root: "./public" }),
    apiPath: "/api",
});
const { defineApi, defineApiGroup } = lambderApp;

// 3. An api module: one group of endpoints. Each is named group.action,
//    called at /api/users/{action}, and reached from a caller as
//    `caller.users.get(input)`.
export const userApis = defineApiGroup("users", {
    get: defineApi({
        input: z.object({ userId: z.string() }),
        output: UserSchema,
    }, async (ctx) => {
        // ctx.apiPayload is typed as { userId: string }
        const { userId } = ctx.apiPayload;

        // The handler returns its output: checked against UserSchema at
        // compile time, and parsed through it before it is sent.
        return {
            id: userId,
            name: "John Doe",
            email: "john@example.com",
        };
    }),
    create: defineApi({
        input: CreateUserSchema,
        output: UserSchema,
    }, async (ctx) => {
        // ctx.apiPayload is typed as { name: string, email: string }
        const { name, email } = ctx.apiPayload;

        return {
            id: "123",
            name,
            email,
        };
    }),
});

// 4. Another module. A group is a value that needs the instance's defineApi
//    and nothing of the other groups, so modules never import each other.
export const authApis = defineApiGroup("auth", {
    login: defineApi({
        input: z.object({ username: z.string(), password: z.string() }),
        output: z.object({ token: z.string() }),
    }, async () => ({ token: "abc-123" })),
});

// 5. Register every group in one call. What it returns is the instance typed
//    with the whole contract: users.get, users.create and auth.login.
const lambder = lambderApp.registerApiGroups(userApis, authApis);

// 6. Export the inferred contract type for frontend use. A caller built on it
//    reaches each endpoint by its group,
//    `await new LambderCaller<ApiContractType>({ apiPath: "/api" }).users.get({ userId: "1" })`,
//    or by its name, `caller.api("users.get", { userId: "1" })`.
export type ApiContractType = typeof lambder.ApiContract;

export const handler = lambder.getHandler();
