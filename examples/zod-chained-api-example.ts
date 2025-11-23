import { z } from "zod";
import Lambder from "../src/index.js";

// 1. Define reusable schemas
const UserSchema = z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().email(),
});

const CreateUserSchema = z.object({
    name: z.string(),
    email: z.string().email(),
});

// 2. Initialize Lambder and chain APIs
const lambder = new Lambder({ 
    publicPath: "./public",
    apiPath: "/api" 
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

// 3. Export the inferred contract type for Frontend
export type AppContract = typeof lambder.ApiContract;

// 4. Modular example using .use()
const authApi = <T>(l: Lambder<T>) => {
    return l.addApi("login", {
        input: z.object({ username: z.string(), password: z.string() }),
        output: z.object({ token: z.string() })
    }, async (ctx, resolver) => {
        return resolver.api({ token: "abc-123" });
    });
};

const lambderWithAuth = lambder.use(authApi);

export type AuthContract = typeof lambderWithAuth.ApiContract;
