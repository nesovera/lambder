# Lambder - Serverless NodeJS Web Framework (v2.0)

Lambder is a highly opinionated dynamic serverless framework designed to facilitate the management and implementation of routes and APIs within AWS Lambda functions, specifically tailored for TypeScript projects. It provides a streamlined approach to handling HTTP requests, managing sessions, and defining API routes, making serverless application development more intuitive and structured.

**New in v2.0:** Full type safety with Zod schemas and runtime validation!

## Features

- **Type-Safe APIs with Zod**: Define inputs and outputs with Zod schemas. Get automatic runtime validation and compile-time type inference.
- **Method Chaining**: Build your API contract incrementally with a fluent interface.
- **Simple API & Route Declaration**: Define your APIs and routes using concise and expressive syntax.
- **Session Management**: Built-in session management to secure and personalize user experiences.
- **Flexible Hooks System**: Employ hooks to execute code at different stages of the request lifecycle.
- **Error Handling**: Comprehensive error handling capabilities, including global error handlers and route-specific fallbacks.
- **Seamless Integration**: Designed to work effortlessly with AWS Lambda and API Gateway.

## Installation

```bash
npm install lambder zod
# or
yarn add lambder zod
```

## Backend Usage

### Basic Setup

```typescript
import Lambder, { InferLambderContract } from 'lambder';
import { z } from 'zod';
import * as path from 'path';

const lambder = new Lambder({
    apiPath: "/api",
    publicPath: path.resolve(`./public`),
    // ejsPath: path.resolve(`./ejs-templates`), // Optional
});

// Enable session and CORS - all chainable!
lambder
    .enableDdbSession({
        tableName: "website-session",
        tableRegion: "us-east-1",
        sessionSalt: "CHANGE-THIS-TO-A-SECURE-RANDOM-STRING"
    })
    .enableCors(true);

// Define type-safe APIs with Zod schemas
const app = lambder
    .addApi("getCompanyPage", {
        input: z.object({ companyName: z.string() }),
        output: z.object({ id: z.string(), name: z.string(), description: z.string() })
    }, async ({ apiPayload }, res) => {
        // apiPayload is automatically typed and validated!
        const data = await fetchDataSomehow(apiPayload.companyName);
        return res.api(data); // Return value is type-checked
    })
    .addApi("loginUser", {
        input: z.object({ email: z.string().email(), password: z.string() }),
        output: z.object({ success: z.boolean(), token: z.string().optional() })
    }, async (ctx, res) => {
        const user = await authenticateUser(ctx.apiPayload.email, ctx.apiPayload.password);
        if (!user) {
            return res.api({ success: false });
        }
        
        await lambder.getSessionController(ctx).createSession(user.id);
        return res.api({ success: true, token: "session-token" });
    });

// Export the inferred contract for the frontend
export type AppContract = typeof lambder.ApiContract;

// Export the handler
export const handler = lambder.getHandler();
```

### Adding Routes

Routes are fully chainable for a fluent interface.

```typescript
lambder
    // Define a simple route
    .addRoute("/hello-world", (ctx, res) => {
        return res.html("Hello World");
    })
    // Route with parameters
    .addRoute("/user/:userId", async (ctx, res) => {
        const user = await getUser(ctx.pathParams.userId);
        if(!user) return res.status404("Not found");
        return res.html(`Hello ${user.name}`);
    })
    // Define a regex route
    .addRoute(/\/hello-regex/, (ctx, res) => {
        return res.html("Hello Regex");
    })
    // Function routes allows routing on any context variable
    .addRoute((ctx)=>ctx.path === '/hello-fn-route', (ctx, res) => {
        return res.html("Hello from a function route");
    })
    // Define a simple route that serves an EJS template file
    .addRoute("/product/:productId", async (ctx, res) => {
        const product = await getProduct(ctx.pathParams.productId);
        // Serve the file from ejsPath defined above.
        return await res.ejsFile("productPage.html.ejs", { product });
    })
    // Serve sitemap using an ejs template
    .addRoute("/sitemap", async (ctx, res) => {
        const templateString = `
            <?xml version="1.0" encoding="UTF-8"?>
            <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <%~
                page.urlList.map(url => \`<url><loc>\${url}</loc></url>\`).join("")
            %>
            </urlset>
        `.trim();
        const urlList = await getUrlList();
        return await res.ejsTemplate(templateString, { urlList }, { "Content-Type": ["application/xml; charset=utf-8"]});
    })
    // Match all other paths and serve static files from publicPath
    .addRoute("/(.*)", (ctx, res)=>{
        return res.file(ctx.path, {}, "index.html");
    })
    // Set a fallback handler for unmatched routes
    .setRouteFallbackHandler((ctx, res) => {
        return res.status404("Not Found");
    })
    // Global error handler
    .setGlobalErrorHandler((err, ctx, res) => {
        console.error("Error:", err);
        return res.raw({ statusCode: 500, body: "Internal Server Error" });
    });
```

### Adding APIs

All APIs in v2.0 must use Zod schemas for type safety and runtime validation. Use method chaining for a clean API definition.

```typescript
import { z } from 'zod';

lambder
    // Add a typed API
    .addApi("getUserById", {
        input: z.object({ userId: z.string() }),
        output: z.object({ id: z.string(), name: z.string(), email: z.string() })
    }, async (ctx, res) => {
        // ctx.apiPayload is typed as { userId: string }
        const user = await db.getUser(ctx.apiPayload.userId);
        return res.api(user); // Type-checked against output schema
    })
    // Session-protected API
    .addSessionApi("getProfile", {
        input: z.void(),
        output: z.object({ userId: z.string(), username: z.string() })
    }, async (ctx, res) => {
        // Session is automatically fetched and validated
        // ctx.session.data contains your session data
        return res.api({
            userId: ctx.session.data.userId,
            username: ctx.session.data.username
        });
    });
```

### Modular APIs with .use()

For larger applications, split your APIs into separate modules:

```typescript
// user-api.ts
import { z } from "zod";
import Lambder from "lambder";

export const userApi = <T>(l: Lambder<T>) => {
    return l
        .addApi("getUser", {
            input: z.object({ id: z.string() }),
            output: z.object({ id: z.string(), name: z.string() })
        }, async (ctx, res) => {
            return res.api({ id: ctx.apiPayload.id, name: "User" });
        })
        .addApi("createUser", {
            input: z.object({ name: z.string(), email: z.string() }),
            output: z.object({ id: z.string() })
        }, async (ctx, res) => {
            return res.api({ id: "123" });
        });
};

// index.ts
import { userApi } from "./user-api";

const lambder = new Lambder()
    .use(userApi);

export type AppContract = typeof lambder.ApiContract;
```


### Hooks

Lambder provides hooks to execute code at different stages of the request lifecycle.

```typescript
lambder
    // Before render hook
    .addHook("beforeRender", async (ctx, res) => {
        // Perform actions before rendering
        console.log("Request received:", ctx.path);
        return ctx; // Return modified context or throw an Error
    })
    // After render hook
    .addHook("afterRender", async (ctx, res, response) => {
        // Modify response before sending
        console.log("Response status:", response.statusCode);
        return response;
    });
```

### Session Management

Enable DynamoDB-based session management - fully chainable:

```typescript
// Enable sessions using a DynamoDB session table - chainable!
const lambder = new Lambder({ apiPath: '/api', publicPath: './public' })
    .enableDdbSession({
        tableName: "website-session",
        tableRegion: "us-east-1",
        sessionSalt: "CHANGE-THIS-TO-A-SECURE-RANDOM-STRING",
        enableSlidingExpiration: true // Optional: extend session on each access
    })
    .enableCors(true)
    .addApi(...);
```

#### DynamoDB Session Table Structure

- Primary Key: "pk"
- Sort Key: "sk"
- TTL Key: "expiresAt" (optional, recommended)

See [docs/DYNAMODB_SETUP.md](docs/DYNAMODB_SETUP.md) for detailed setup instructions.

#### Session Controller

After enabling sessions, you can access the session controller:

```typescript
const sessionController = lambder.getSessionController(ctx);

// Available methods:
await sessionController.createSession(sessionKey, data, ttlInSeconds);
// Starts a new session and persists the session data to DDB.

await sessionController.fetchSession();
// Fetch and validate if there is an existing session
// This is automatically done for addSessionRoute and addSessionApi
// Throws if session not found

await sessionController.fetchSessionIfExists();
// Returns session if found, otherwise null

await sessionController.updateSessionData(updatedData);
// Updates the active session's data and persists it to DDB

await sessionController.endSession();
// End session and delete from DDB

await sessionController.endSessionAll();
// Ends and deletes all sessions for this sessionKey across all devices

await sessionController.regenerateSession();
// Regenerates session token (use after password change, etc.)
```

#### Session Examples

```typescript
lambder
    .addApi("createSession", {
        input: z.object({ userId: z.string() }),
        output: z.object({ success: z.boolean() })
    }, async (ctx, res) => {
        // Create a new session
        const userId = ctx.apiPayload.userId;
        await lambder.getSessionController(ctx)
            .createSession(userId, { business: "Session data goes here" });
        
        console.log(ctx.session?.sessionKey); // userId
        console.log(ctx.session?.data?.business); // "Session data goes here"
        
        return res.api({ success: true });
    })
    .addSessionApi("updateSession", {
        input: z.object({ newData: z.string() }),
        output: z.object({ success: z.boolean() })
    }, async (ctx, res) => {
        // Session is automatically fetched
        console.log(ctx.session.sessionKey); // userId
        
        // Update session data
        await lambder.getSessionController(ctx)
            .updateSessionData({ business2: ctx.apiPayload.newData });
        
        console.log(ctx.session.data.business); // undefined
        console.log(ctx.session.data.business2); // newData value
        
        return res.api({ success: true });
    });
```

### EJS Templates

EJS templates have the variables `page` and `partial` available:

- **Template**: The main file called with `await res.ejsFile('template-file')`. Has `page` variable.
- **Partial**: Included from a template with `<%- await include('partial/header.html.ejs', partialData) -%>`. Has both `page` and `partial` variables.

Example template:
```html
<div>
    <%- await include('partial/header.html.ejs', partialData) -%>
    <div>Page Variable: <pre><%~ JSON.stringify(page, null, 2) %></pre></div>
    <%- await include('partial/footer.html.ejs', partialData) -%>
</div>
```

Example partial:
```html
<div>
    <div>Page Variable: <pre><%~ JSON.stringify(page, null, 2) %></pre></div>
    <div>Partial Variable: <pre><%~ JSON.stringify(partial, null, 2) %></pre></div>
</div>
```

### Render Context (ctx) Variables

```typescript
lambder
    .addApi("exampleApi", {
        input: z.object({ value: z.string() }),
        output: z.object({ result: z.string() })
    }, async (ctx, res) => {
        const { 
            host,        // Request host: "www.example.com"
            path,        // Request path: "/api"
            get,         // GET query parameters: { userId: "342" }
            post,        // POST body (parsed): { userId: "342" }
            cookie,      // Cookies: { "rememberMe": "true" }
            headers,     // Request headers
            apiName,     // API name: "exampleApi"
            apiPayload,  // Validated input (same as post.payload)
            session,     // Session (null for addApi, available for addSessionApi)
        } = ctx;
        
        return res.api({ result: ctx.apiPayload.value });
    });
```

### Resolver Methods

Available response methods:

```typescript
return res.raw(param);
// Sends a custom HTTP response. Useful for non-standard responses.

return res.json(data, headers);
// Sends a JSON response with optional headers.

return res.xml(data);
// Sends an XML response (base64 encoded).

return res.html(data, headers); 
// Sends an HTML response (base64 encoded).

return res.status301(url, headers); 
// Redirects to the specified URL with a 301 status code.

return res.status404(data, headers); 
// Sends a 404 Not Found response.

return res.cors(); 
// Sends a 200 OK response with CORS headers (for preflight requests).

return res.fileBase64(fileBase64, mimeType, headers); 
// Sends a file response from base64 content.

return res.file(filePath, headers, fallbackFilePath); 
// Serves a file from the public directory.

return await res.ejsFile(filePath, pageData, headers); 
// Renders and serves an EJS file.

return await res.ejsTemplate(template, pageData, headers); 
// Renders and serves an EJS template string.

return res.api(payload, config, headers); 
// Sends a standardized API response for use with LambderCaller.
// Config: { notAuthorized, message, errorMessage, versionExpired, sessionExpired }

// res.die.* - Same as res.* but immediately returns and skips afterRender hooks
return res.die.json(data, headers); 
return res.die.api(payload, config, headers);
// ... etc
```

## Frontend Usage with LambderCaller

LambderCaller is a frontend companion library for Lambder (only 2kb compressed) designed to simplify making type-safe API requests to your Lambder backend.

### Basic Setup with Type Safety

```typescript
import { LambderCaller } from "lambder";
import type { AppContract } from "./backend/handler"; // Import the inferred contract type

const lambderCaller = new LambderCaller<AppContract>({
    apiPath: "/api",
    isCorsEnabled: false,
    fetchStartedHandler: ({ fetchParams, activeFetchList }) => {
        console.log("API Called:", fetchParams.apiName);
    },
    fetchEndedHandler: ({ fetchParams, fetchResult, activeFetchList }) => {
        console.log("Ongoing calls:", activeFetchList.length);
    },
    errorMessageHandler: (message) => {
        console.error("LambderCaller:", message);
    },
});

// Fully typed API calls!
const user = await lambderCaller.api("getCompanyPage", { companyName: "Acme" });
// TypeScript knows:
// - Available API names (autocomplete)
// - Required input type
// - Expected output type
```

### How Type Safety Works

1. **Backend**: Chain your APIs and export the inferred contract
```typescript
// backend/handler.ts
import Lambder from 'lambder';
import { z } from 'zod';

const lambder = new Lambder({ apiPath: '/api' })
    .addApi('getUser', {
        input: z.object({ userId: z.string() }),
        output: z.object({ id: z.string(), name: z.string() })
    }, async (ctx, res) => {
        return res.api({ id: ctx.apiPayload.userId, name: "John" });
    });

export type AppContract = typeof lambder.ApiContract;
export const handler = lambder.getHandler();
```

2. **Frontend**: Import the **type** (not the code) and use it
```typescript
// frontend/api.ts
import { LambderCaller } from 'lambder';
import type { AppContract } from '../backend/handler'; // Type-only import

const lambderCaller = new LambderCaller<AppContract>({ apiPath: '/api' });

// ✅ Fully typed - TypeScript knows all APIs and their input/output types
const user = await lambderCaller.api('getUser', { userId: '123' });
```

### Benefits

✅ **No Manual Type Definitions** - Types are inferred from your Zod schemas  
✅ **Single Source of Truth** - API contract comes from your backend code  
✅ **Runtime Validation** - Zod validates inputs automatically  
✅ **Compile-Time Safety** - TypeScript catches errors before runtime  
✅ **Autocomplete** - IDE suggests available APIs as you type  
✅ **Zero Overhead** - Type-only imports, no runtime code bloat  

📖 **[Read the Quick Start Guide](docs/TYPE_SAFE_QUICK_START.md)** for more details and examples!

## Testing with LambderMSW

LambderMSW provides seamless integration with [MSW (Mock Service Worker)](https://mswjs.io/) for testing your APIs with full type safety.

```typescript
import { LambderMSW } from 'lambder';
import { setupServer } from 'msw/node';
import type { AppContract } from './backend/handler';

const lambderMSW = new LambderMSW<AppContract>({
    apiPath: '/api',
});

const handlers = [
    // Mock API with full type safety! ✨
    lambderMSW.mockApi('getUser', async (payload) => {
        // payload is typed based on your Zod schema
        return {
            id: payload.userId,
            name: 'John Doe',
            email: 'john@example.com'
        };
    }),
    
    // Simulate delays and custom responses
    lambderMSW.mockApi('createUser', async (payload) => {
        return { id: '123', name: payload.name, email: payload.email };
    }, { 
        delay: 500,
        message: 'User created successfully'
    }),
    
    // Mock session expired
    lambderMSW.mockSessionExpired('protectedApi'),
];

const server = setupServer(...handlers);
```

📖 **[Read the LambderMSW Guide](docs/LAMBDER_MSW.md)** for complete testing documentation!

## Contributing

Contributions are welcome! Especially for documentation. If you have an idea for an improvement or have found a bug, please open an issue or submit a pull request.

## License

This project is licensed under the [MIT License](LICENSE).