# Lambder - Serverless NodeJS Web Framework

Lambder is a highly opinionated dynamic serverless framework designed to facilitate the management and implementation of routes and APIs within AWS Lambda functions, specifically tailored for TypeScript projects. It provides a streamlined approach to handling HTTP requests, managing sessions, and defining API routes, making serverless application development more intuitive and structured.

## Features

- **Simple API & Route Declaration**: Define your APIs and routes using concise and expressive syntax.
- **Session Management**: Built-in session management to secure and personalize user experiences.
- **Flexible Hooks System**: Employ hooks to execute code at different stages of the request lifecycle, enabling fine-grained control over the application flow.
- **Error Handling**: Comprehensive error handling capabilities, including global error handlers and route-specific fallbacks.
- **Seamless Integration**: Designed to work effortlessly with AWS Lambda and API Gateway, providing a straightforward path to deploy serverless applications.

## Installation

To include Lambder in your TypeScript project, you can install it using npm or yarn. First, ensure that you have TypeScript set up in your project.

```bash
npm install lambder
# or
yarn add lambder
```

## Backend Usage

### Basic Setup

```typescript
import Lambder from 'lambder';
import * as path from 'path';

const lambder = new Lambder({
    apiPath: "/secure",
    publicPath: path.resolve(`./public`),
    // ejsPath: path.resolve(`./ejs-templates`),
});


// Enable session
lambder.enableDdbSession({
    tableName: "website-session", // DynamoDB Table Name
    tableRegion: "us-east-1", // DynamoDB Table Region
    sessionSalt: "8p6Vt+4b1w3N8d/dcJ47QF3DRkp9koFg0G" // Change salt
});

// Enable Cors
lambder.enableCors(true);

// Define a simple api
lambder.addApi("getCompanyPage", async ({ apiPayload }, res) => {
    const companyName = apiPayload.companyName;
    const data = await fetchDataSomehow(companyName);
    return res.api(data);
});

// Start a session from an API
lambder.addApi("loginUser", async (ctx, res) => {
    const user = await fetchUserData();
    await lambder.getSessionController(ctx).createSession(user.id);
    return res.api({ success: true });
});

// Define a simple route
lambder.addRoute("/hello-world", (ctx, res) => {
    return res.html("Hello World");
});

// Route with parameters
lambder.addRoute("/user/:userId", async (ctx, res) => {
    const user = await getUser(ctx.pathParams.userId);
    if(!user) return res.status404("Not found");

    return res.html(`Hello ${user.name}`);
});

// Define a regex route
lambder.addRoute(/\/hello-regex/, (ctx, res) => {
    return res.html("Hello Regex");
});

// Function routes allows routing on any context variable.
lambder.addRoute((ctx)=>ctx.path === '/hello-fn-route', (ctx, res) => {
    return res.html("Hello from a function route");
});

// Define a simple route that serves an EJS template file
lambder.addRoute("/product/:productId", (ctx, res) => {
    const product = await getProduct(ctx.pathParams.productId);
    // Serve the file from ejsPath defined above.
    return await res.ejsFile("productPage.html.ejs", { product });
});

// Serve sitemap using an ejs template.
lambder.addRoute("/sitemap", (ctx, res) => {
    const templateString = `
        <?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <%~
            page.urlList.map(url => `<url><loc>${url}</loc></url>`).join("")
        %>
        </urlset>
    `.trim();
    const urlList = [];
    return await  res.ejsTemplate(templateString, { urlList }, { "Content-Type": ["application/xml; charset=utf-8"]});
});


// Match all other paths and serve static files from publicPath, if not found, serve index.html
lambder.addRoute("/(.*)", (ctx, res)=>{
    return res.file(ctx.path, {}, "index.html");
});


// Set a fallback handler for unmatched routes
lambder.setRouteFallbackHandler((ctx, res) => {
    return res.status404("Not Found");
});

// Global error handler
lambder.setGlobalErrorHandler((err, ctx, res) => {
    console.error("Error:", err);
    return res.status500("Internal Server Error");
});

export const handler = (event, context) => {
    return lambder.render(event, context);
};
```



### Adding APIs

For more details on route matching, please check [path-to-regexp](https://www.npmjs.com/package/path-to-regexp) package.
```typescript
// Add routes
lambder.addRoute(pathAsString, async (ctx, res) => {});
lambder.addRoute(pathAsRegex, async (ctx, res) => {});
lambder.addRoute(matchFunction, async (ctx, res) => {});

// Add apis
lambder.addApi(apiNameAsString, async (ctx, res) => {});
lambder.addApi(apiNameAsRegex, async (ctx, res) => {});
lambder.addApi(matchFunction, async (ctx, res) => {});

// Add only session accessible routes
lambder.addSessionRoute(pathAsString, async (ctx, res) => {});
lambder.addSessionRoute(pathAsRegex, async (ctx, res) => {});
lambder.addSessionRoute(matchFunction, async (ctx, res) => {});

// Add only session accessible apis
lambder.addSessionApi(apiNameAsString, async (ctx, res) => {});
lambder.addSessionApi(apiNameAsRegex, async (ctx, res) => {});
lambder.addSessionApi(matchFunction, async (ctx, res) => {});

```


```typescript
// Define a simple api
lambder.addApi("getCompanyPage", async (ctx, res) => {
    const { 
        host, path, get, post, cookie, headers, 
        apiName, apiPayload
    } = ctx;
    const companyName = apiPayload.companyName;
    const data = await fetchDataSomehow(companyName);
    return res.api(data);
});
```

```typescript
// Define an only session accessible api
lambder.addSessionApi("getCompanyPage", async (ctx, res) => {
    const { 
        host, path, get, post, cookie, headers, 
        session, apiName, apiPayload
    } = ctx;
    
    const companyName = session.data.companyName;
    const data = await fetchDataSomehow(companyName);
    return res.api(data);
});
```



### Adding Routes
```typescript
// Route with parameters
lambder.addRoute("/user/:userId", async (ctx, res) => {
    const user = await getUser(ctx.pathParams.userId);
    if(!user) return res.status404("Not found");

    return res.html(`Hello ${user.name}`);
});
```


### Adding Hooks

```typescript
// Before render hook example
lambder.addHook("beforeRender", async (ctx, res) => {
    // Perform actions before rendering
    return ctx; // Return modified context or throw an Error
});
```


### Add Module

```typescript
lambder.addModule(async (lambder: Lambder): Promise<void> => {
    // lambder.addHook(...)
    // lambder.addRoute(...)
});
```

### Session Management

You can enable session tracking by:

```typescript
// Enable sessions using a dynamodb session table
lambder.enableDdbSession({
    tableName: "website-session", // DynamoDB Table Name
    tableRegion: "us-east-1", // DynamoDB Table Region
    sessionSalt: "8p6Vt+4b1w3N8d/dcJ47QF3DRkp9koFg0G" // Change salt
});
```
#### DynamoDB Session Table Structure: 

Session system is enabled by storing data in a DynamoDB session table.

- Primary Key: "pk"
- Sort Key: "sk"
- TTL Key: "expiresAt" (optional)

#### Session Controller

After you enable the session, you can access to the session controller:

```typescript
    // Create session controller:
    const sessionController = lambder.getSessionController(ctx);

    // Type for sessionController 
    sessionController: {
        async createSession(sessionKey, data, ttlInSeconds): session
        // Starts a new session and persists the session data to DDB.

        async fetchSession(): session
        // Fetch and validate if there is an existing session
        // This is automatically done for addSessionRoute and addSessionApi
        // Throws if session not found

        async fetchSessionIfExists(): session|null 
        // Runs fetchSession and returns the session if found. Otherwise return null

        async updateSessionData(updatedData): updatedSession
        // Updates the active sessions data and persist it to ddb.

        async endSession(): 
        // End session and delete from DDB.

        async endSessionAll(): 
        // Ends and deletes all registered sessions for this sessionKey across all devices
    }
    */
```



#### Session Examples
```typescript
lambder.addApi("getCompanyPage", async (ctx, res) => {
    
    // createSession: Start a new session
    const userId = "37234";
    await lambder.getSessionController(ctx)
        .createSession(userId, { "business": "Session data goes here"  });
    console.log(ctx.session?.sessionKey); // "37234"
    console.log(ctx.session?.data?.business); // "Session data goes here"

    // fetchSession: Fetch and validate if there is an existing session
    // This is automatically done for addSessionRoute and addSessionApi
    await lambder.getSessionController(ctx).fetchSession();
    console.log(ctx.session?.sessionKey); // "37234"
    
    // updateSessionData: Updates the active sessions data and persist it to ddb.
    await lambder.getSessionController(ctx)
        .updateSessionData({ "business2": "Session data updated"  });
    console.log(ctx.session?.sessionKey); // "37234"
    console.log(ctx.session?.data?.business); // undefined
    console.log(ctx.session?.data?.business2); // "Session data updated"
    
    // endSession: Ends the session and removes it from ddb
    await lambder.getSessionController(ctx).endSession(); // End session
    console.log(ctx.session?.sessionKey); // undefined
    console.log(ctx.session?.data?.business); // undefined
    
    // endSessionAll: Ends all registered sessions for this user in all devices.
    await lambder.getSessionController(ctx).endSessionAll(); 
    console.log(ctx.session?.sessionKey); // undefined
    console.log(ctx.session?.data?.business); // undefined

});
```

### EJS Templates: 

EJS templates have the variables `page` and `partial` available:

A template is the main file that you call with `await res.ejsFile('template-file')`. Templates will have `page` variable available.
A partial is included from a template, like `<%- await include('partial/header.html.ejs', partialData) -%>` will have `page` and `partial` variables available.

An example template:
```html
<div>
    <%- await include('partial/header.html.ejs', partialData) -%>
    <div>Page Variable: <pre><%~ JSON.stringify(page, null, 2) %></pre></div>
    <%- await include('partial/footer.html.ejs', partialData) -%>
</div>
```
An example partial:
```html
<div>
    <div>Page Variable: <pre><%~ JSON.stringify(page, null, 2) %></pre></div>
    <div>Partial Variable: <pre><%~ JSON.stringify(partial, null, 2) %></pre></div>
</div>
```

### Project Structure: 

Add your imports to index.ts:
```typescript
lambder.importModule(import("api.user.js"));
```

User related functions can now be added to api.user.ts:
```typescript
import type Lambder from "lambder";

export default (lambder: Lambder): void => {
    // lambder.addApi(...)
    // lambder.addApi(...)
};
```

Note: importModule is just a wrapper for addModule. `lambder.importModule(import("api.user.js"));` is same as `lambder.addModule((await import("api.user.js")).default);`

### Render Context (ctx) Variables
```typescript
lambder.addApi("getCompanyName", async (ctx, res) => {
    const { 
        host, // Request host. Exp: "www.example.com"
        path, // Request path. Exp: "/index.html" or "/user/342"
        get, // Get request query in JSON format. Exp: { userId: 342 }
        post, // Post request body after JSON parsed. Exp: { userId: 342 }
        cookie, // Cookies in an object. Exp: { "rememberMe": "true" }
        headers, // Request Headers in an object. Exp: { "User-Agent": "....", ... }
        apiName, // In this function it would return "getCompanyName"
        apiPayload, // Same as post.payload 
        session, // Stores session. Only available in addSessionRoute and addSessionApi, otherwise null.
    } = ctx;
    return res.json({});
});
```

### Resolver Methods

```typescript
lambder.addApi("getCompanyName", async (ctx, res) => {
    return res.raw(param);
    // Sends a custom HTTP response defined by the param object. 
    // Useful for sending non-standard responses.
    return res.json(data, headers);
    // Sends a JSON response with the specified data and optional headers. 
    // It sets the Content-Type header to application/json.

    return res.xml(data);
    // Sends an XML response with the given data. 
    // Automatically encodes the response in base64 and sets 
    // the Content-Type header to application/xml.

    return res.html(data, headers); 
    // Sends an HTML response containing the provided data with optional headers. 
    // The response is base64 encoded, and the Content-Type header is set to text/html.

    return res.status301(url, headers); 
    // Redirects the client to the specified url with a 301 status code and optional headers. 
    // Useful for permanent redirections.

    return res.status404(data, headers); 
    // Sends a 404 Not Found response with custom data and optional headers. 
    // The response is base64 encoded, and the Content-Type header is set to text/html.

    return res.cors(); 
    // Sends a 200 OK response with CORS headers enabled. 
    // This is typically used in response to a preflight request in a CORS scenario.

    return res.fileBase64(fileBase64, mimeType, headers); 
    // Sends a file response with the content provided in base64 format,
    //   the specified mimeType, and optional headers.

    return res.file(filePath, headers, fallbackFilePath); 
    // Serves a file from the server's public directory, with optional headers. 
    // If the file is not found and a fallbackFilePath is provided, 
    //   attempts to serve the fallback file. 
    //   Returns a JSON error if neither file is found.

    return res.ejsFile(filePath, pageData, headers); 
    // Renders and serves an ejs file from the server's ejs directory, with optional headers.
    //   Returns a JSON error if file is not found.

    return res.ejsTemplate(template, pageData, headers); 
    // Renders and serves an ejs template string, with optional headers.

    return res.api(payload, { notAuthorized, message, errorMessage }, headers); 
    // This function works together with the LambderCaller from the frontend.
    // Sends a standardized API response including the payload and status 
    //    flags like versionExpired, sessionExpired, notAuthorized, along with 
    //    optional messages and headers. 
 
    // res.die.* 
    // Acts the same as res.* but will:
    //  - Immediately return the value.
    //  - Skip the afterRender hooks.

    return res.die.raw(param); 
    return res.die.json(data, headers); 
    return res.die.xml(data); 
    return res.die.html(data, headers); 
    return res.die.status301(url, headers); 
    return res.die.status404(data, headers); 
    return res.die.cors(); 
    return res.die.fileBase64(fileBase64, mimeType, headers); 
    return await res.die.file(filePath, headers, fallbackFilePath); 
    return await res.die.ejsFile(filePath, pageData, headers); 
    return await res.die.ejsTemplate(template, pageData, headers); 
    return res.die.api(payload, { versionExpired, sessionExpired, notAuthorized, message, errorMessage }, headers); 
});
```

## Frontend Usage with LambderCaller

LambderCaller is a frontend companion library for Lambder, it is only 2kb compressed, and designed to simplify making API requests to your Lambder backend services. 

### Installing LambderCaller

LambderCaller is included in the same `lambder` package. Ensure you have `lambder` available in your frontend project.

### Basic Setup

Begin by initializing LambderCaller with your API configuration. This setup assumes your project structure accommodates a place for initiating and configuring API handlers, possibly within a dedicated JavaScript module or directly in your main application file.

```javascript
import { LambderCaller } from "lambder";

const lambderCaller = new LambderCaller({
    isCorsEnabled: false,
    apiPath: "/secure", // Your Lambder API endpoint, must be the same as in your backend
    fetchStartedHandler: ({ fetchParams, activeFetchList }) => {
        // When any api call starts
        console.log("API Called:", fetchParams.apiName);
    },
    fetchEndedHandler: ({ fetchParams, fetchResult, activeFetchList }) => {
        // When any api call ends
        console.log("Ongoing api call count:", activeFetchList.length);
    },
    errorMessageHandler: (message) => {
        console.error("LambderCaller:", message); // Handle error messages
    },
});


const loadPageData = async () => {
    try {
        const response = await lambderCaller.api("getCompanyPage", {
            companyName: "example", // Pass necessary parameters for your API call
        });
    } catch (error) {
        console.error("Failed to fetch page data:", error);
    }
};
```

## Type-Safe APIs (Optional)

Want compile-time type checking for your APIs? It's incredibly simple!

### 1. Define Your API Contract

```typescript
// shared/apiContract.ts
import type { ApiContract } from 'lambder';

export type MyApiContract = ApiContract<{
    getUserById: { input: { userId: string }, output: User },
    createUser: { input: CreateUserInput, output: User },
    listUsers: { input: void, output: User[] }
}>;
```

### 2. Backend - Pass Type to Constructor

```typescript
import Lambder from 'lambder';
import type { MyApiContract } from './shared/apiContract';

const lambder = new Lambder<MyApiContract>({ publicPath: './public', apiPath: '/api' });

// Now addApi is type-safe!
lambder.addApi('getUserById', async (ctx, resolver) => {
    // ctx.apiPayload is automatically typed as { userId: string } ✨
    const user = await db.getUser(ctx.apiPayload.userId);
    return resolver.api(user);
});
```

### 3. Frontend - Pass Type to Constructor

```typescript
import { LambderCaller } from 'lambder';
import type { MyApiContract } from './shared/apiContract';

const caller = new LambderCaller<MyApiContract>({ apiPath: '/api', isCorsEnabled: false });

// Now api() is type-safe with full autocomplete! ✨
const user = await caller.api('getUserById', { userId: '123' });
//                             ↑ IDE shows all available APIs
//                                            ↑ Type-checked input
// user is typed as User | null | undefined
```

### Benefits

✅ **Simple** - Just pass type to constructor, that's it!  
✅ **Autocomplete** - IDE suggests available APIs as you type  
✅ **Type Safety** - Inputs and outputs are fully typed  
✅ **No Wrappers** - Use existing `api()` and `addApi()` methods  
✅ **Opt-In** - Add when you want, skip when you don't  
✅ **Zero Overhead** - Pure TypeScript types, no runtime code  

📖 **[Read the Quick Start Guide](docs/TYPE_SAFE_QUICK_START.md)** for more details and examples!

## Testing with LambderMSW

LambderMSW provides seamless integration with [MSW (Mock Service Worker)](https://mswjs.io/) for testing your APIs. It works perfectly with type-safe API contracts!

```typescript
import { LambderMSW } from 'lambder';
import { setupServer } from 'msw/node';
import type { MyApiContract } from './shared/apiContract';

const lambderMSW = new LambderMSW<MyApiContract>({
    apiPath: '/api',
});

const handlers = [
    // Mock API with full type safety! ✨
    lambderMSW.mockApi('getUserById', async (payload) => {
        return {
            id: payload.userId,
            name: 'John Doe',
            email: 'john@example.com'
        };
    }),
    
    // Mock errors, delays, and more
    lambderMSW.mockApi('createUser', async (payload) => {
        return { id: '123', ...payload };
    }, { delay: 500 }),
    
    lambderMSW.mockSessionExpired('protectedApi'),
];

const server = setupServer(...handlers);
```

📖 **[Read the LambderMSW Guide](docs/LAMBDER_MSW.md)** for complete testing documentation!

## Contributing

Contributions are welcome! Especially for documentation. If you have an idea for an improvement or have found a bug, please open an issue or submit a pull request.

## License

This project is licensed under the [MIT License](LICENSE).