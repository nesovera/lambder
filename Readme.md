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
import Lambder from 'lambder';
import { z } from 'zod';
import * as path from 'path';

const lambder = new Lambder({
    apiPath: "/api",
    publicPath: path.resolve(`./public`),
});

// Enable session and CORS
lambder
    .enableDdbSession({
        tableName: "website-session",
        tableRegion: "us-east-1",
        sessionSalt: "CHANGE-THIS-TO-A-SECURE-RANDOM-STRING"
    })
    .enableCors(true);

// Define type-safe APIs with Zod schemas
lambder
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
export type ApiContractType = typeof lambder.ApiContract;

// Export the handler
export const handler = lambder.getHandler();
```

### Adding Routes

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
    // Match all other paths and serve static files from publicPath
    .addRoute("/(.*)", (ctx, res)=>{
        return res.file(ctx.path, {}, "index.html");
    })
    // Set a fallback handler for unmatched routes
    .setRouteFallbackHandler((ctx, res) => {
        return res.status404("Not Found");
    })
    // Set a fallback handler for unmatched APIs
    .setApiFallbackHandler((ctx, res) => {
        return res.api(null, { errorMessage: "API not found" });
    })
    // Handle Zod validation errors for API inputs
    .setApiInputValidationErrorHandler((ctx, res, zodError) => {
        return res.api(null, { errorMessage: zodError.errors });
    })
    // Global error handler
    .setGlobalErrorHandler((err, ctx, res) => {
        console.error("Error:", err);
        return res.raw({ statusCode: 500, body: "Internal Server Error" });
    });
```

### Session-Protected APIs

Use `addSessionApi` for endpoints that require authentication:

```typescript
lambder.addSessionApi("getProfile", {
    input: z.void(),
    output: z.object({ userId: z.string(), username: z.string() })
}, async (ctx, res) => {
    // Session is automatically fetched and validated
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

const lambder = new Lambder({ publicPath: './public' })
    .use(userApi);

export type ApiContractType = typeof lambder.ApiContract;
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
    })
    // Fallback hook - runs when no route/API matches
    .addHook("fallback", async (ctx, res) => {
        // Perform cleanup or logging for unmatched requests
        console.log("No handler matched for:", ctx.path);
    });
```

### Session Management

Enable DynamoDB-based sessions with `enableDdbSession()`. Optional configuration:

```typescript
lambder
    .enableDdbSession({
        tableName: "website-session",
        tableRegion: "us-east-1",
        sessionSalt: "CHANGE-THIS-TO-A-SECURE-RANDOM-STRING",
        enableSlidingExpiration: true // Optional: extend session on each access
    })
    // Optionally customize session cookie names (defaults: LMDRSESSIONTKID, LMDRSESSIONCSTK)
    .setSessionCookieKey("MY_SESSION_TOKEN", "MY_CSRF_TOKEN");
```

#### DynamoDB Session Table Structure

- Primary Key: "pk"
- Sort Key: "sk"
- TTL Key: "expiresAt" (optional, recommended)

See [docs/DYNAMODB_SETUP.md](docs/DYNAMODB_SETUP.md) for detailed setup instructions.

#### Session Controller

Access the session controller with `lambder.getSessionController(ctx)`:

| Method | Description |
|--------|-------------|
| `createSession(sessionKey, data?, ttlInSeconds?)` | Start new session, persist to DDB |
| `fetchSession()` | Fetch & validate existing session (throws if not found) |
| `fetchSessionIfExists()` | Returns session or null |
| `updateSessionData(newData)` | Update session data in DDB |
| `endSession()` | End session, delete from DDB |
| `endSessionAll()` | End all sessions for this sessionKey (all devices) |
| `regenerateSession()` | Regenerate token (use after password change) |

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

The `ctx` object provides access to request data:

| Property | Description | Example |
|----------|-------------|----------|
| `host` | Request host | `"www.example.com"` |
| `path` | Request path | `"/api"` |
| `pathParams` | Path parameters (routes) | `{ userId: "123" }` |
| `method` | HTTP method | `"GET"`, `"POST"` |
| `get` | Query parameters | `{ page: "1" }` |
| `post` | POST body (parsed) | `{ name: "John" }` |
| `cookie` | Cookies | `{ rememberMe: "true" }` |
| `headers` | Request headers | `{ "Content-Type": "..." }` |
| `event` | Raw APIGatewayProxyEvent | - |
| `lambdaContext` | AWS Lambda Context | - |
| `apiName` | API name (for API calls) | `"getUser"` |
| `apiPayload` | Validated input | `{ userId: "123" }` |
| `session` | Session data | Available in `addSessionApi` |

### Resolver Methods

**Header Manipulation** (call before returning response):
- `res.addHeader(key, value)` - Adds a header value (can be called multiple times for same key)
- `res.setHeader(key, value)` - Sets a header (replaces existing values)
- `res.logToApiResponse(data)` - Adds data to logList in API responses (debugging)

**Response Methods**:

| Method | Description |
|--------|-------------|
| `res.raw(param)` | Custom HTTP response |
| `res.json(data, headers?)` | JSON response |
| `res.xml(data)` | XML response (base64 encoded) |
| `res.html(data, headers?)` | HTML response (base64 encoded) |
| `res.redirect(url, statusCode?, headers?)` | Redirect (default: 302) |
| `res.status404(data, headers?)` | 404 Not Found response |
| `res.cors()` | 200 OK with CORS headers (preflight) |
| `res.fileBase64(base64, mimeType, headers?)` | File from base64 content |
| `res.file(path, headers?, fallbackPath?)` | Serve file from public directory |
| `await res.ejsFile(path, pageData, headers?)` | Render EJS file |
| `await res.ejsTemplate(template, pageData, headers?)` | Render EJS template string |
| `res.api(payload, config?, headers?)` | Standardized API response |
| `res.apiBinary(payload, config?, headers?)` | Gzip-compressed API response |

**API Config Options**: `{ notAuthorized, message, errorMessage, versionExpired, sessionExpired, logList }`

**Die Methods**: `res.die.*` - Same as above but immediately returns, skipping `afterRender` hooks.

## Frontend Usage with LambderCaller

LambderCaller is a frontend companion library for Lambder (only 2kb compressed) designed to simplify making type-safe API requests to your Lambder backend.

### Basic Setup with Type Safety

```typescript
import { LambderCaller } from "lambder";
import type { ApiContractType } from "./backend/handler"; // Import the inferred contract type

const lambderCaller = new LambderCaller<ApiContractType>({
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
import type { ApiContractType } from './backend/handler';

const lambderMSW = new LambderMSW<ApiContractType>({
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