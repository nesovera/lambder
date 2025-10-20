# LambderMSW - Mock Service Worker Integration

LambderMSW provides seamless integration with [MSW (Mock Service Worker)](https://mswjs.io/) for testing your Lambder APIs. It allows you to mock API endpoints with full type safety when using TypeScript API contracts.

## Installation

First, install MSW as a dev dependency:

```bash
npm install msw --save-dev
# or
yarn add msw --dev
```

## Basic Setup

```typescript
import { LambderMSW } from 'lambder';
import { setupServer } from 'msw/node';

// Create an MSW instance
const lambderMSW = new LambderMSW({
    apiPath: '/secure',  // Must match your Lambder backend apiPath
});

// Create mock handlers
const handlers = [
    lambderMSW.mockApi('getUserById', async (payload) => {
        return {
            id: payload.userId,
            name: 'John Doe',
            email: 'john@example.com'
        };
    }),
    
    lambderMSW.mockApi('createUser', async (payload) => {
        return {
            id: '123',
            name: payload.name,
            email: payload.email
        };
    })
];

// Setup MSW server
const server = setupServer(...handlers);

// Start server before tests
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

## Type-Safe Mocking

When using TypeScript API contracts, LambderMSW provides full type safety:

```typescript
// shared/apiContract.ts
import type { ApiContract } from 'lambder';

export type MyApiContract = ApiContract<{
    getUserById: { 
        input: { userId: string }, 
        output: { id: string, name: string, email: string } 
    },
    createUser: { 
        input: { name: string, email: string }, 
        output: { id: string, name: string, email: string } 
    }
}>;

// test/setup.ts
import { LambderMSW } from 'lambder';
import type { MyApiContract } from '../shared/apiContract';

const lambderMSW = new LambderMSW<MyApiContract>({
    apiPath: '/secure',
    apiVersion: '1.0.0'
});

// Now mockApi is fully typed! ✨
const handler = lambderMSW.mockApi('getUserById', async (payload) => {
    // payload is automatically typed as { userId: string }
    // Return value is type-checked against output type
    return {
        id: payload.userId,
        name: 'John Doe',
        email: 'john@example.com'
    };
});
```

## API Reference

### `new LambderMSW(options)`

Creates a new LambderMSW instance.

**Parameters:**
- `apiPath` (string): The API endpoint path (must match your Lambder backend)
- `apiVersion` (string, optional): API version to include in responses

### `mockApi(apiName, handler, options?)`

Mock an API endpoint with a custom handler.

**Parameters:**
- `apiName` (string): Name of the API to mock
- `handler` (function): Async or sync function that returns the mock payload
  - Input: API payload from the request
  - Output: The mocked response payload
- `options` (object, optional):
  - `versionExpired` (boolean): Simulate version expired error
  - `sessionExpired` (boolean): Simulate session expired error
  - `notAuthorized` (boolean): Simulate not authorized error
  - `message` (any): Custom message to include in response
  - `errorMessage` (any): Error message to include in response
  - `logList` (array): Array of log entries
  - `delay` (number): Artificial delay in milliseconds to simulate network latency

**Returns:** MSW RequestHandler

**Example:**
```typescript
lambderMSW.mockApi('getCompanyPage', async (payload) => {
    return {
        companyName: payload.companyName,
        description: 'Mock company description',
        employees: 100
    };
}, {
    delay: 500,  // Simulate 500ms network delay
    message: 'Data fetched successfully'
});
```

### `mockSessionExpired(apiName)`

Mock an API that returns a session expired error.

**Parameters:**
- `apiName` (string): Name of the API to mock

**Example:**
```typescript
lambderMSW.mockSessionExpired('getProtectedData');
```

### `mockVersionExpired(apiName)`

Mock an API that returns a version expired error.

**Parameters:**
- `apiName` (string): Name of the API to mock

**Example:**
```typescript
lambderMSW.mockVersionExpired('getUserProfile');
```

### `mockNotAuthorized(apiName)`

Mock an API that returns a not authorized error.

**Parameters:**
- `apiName` (string): Name of the API to mock

**Example:**
```typescript
lambderMSW.mockNotAuthorized('deleteUser');
```

### `mockError(apiName, errorMessage)`

Mock an API that returns a custom error message.

**Parameters:**
- `apiName` (string): Name of the API to mock
- `errorMessage` (string): The error message to return

**Example:**
```typescript
lambderMSW.mockError('submitOrder', 'Payment processing failed');
```

### `mockWithMessage(apiName, handler, message)`

Mock an API with a custom success message.

**Parameters:**
- `apiName` (string): Name of the API to mock
- `handler` (function): Handler function that returns the mock payload
- `message` (any): Custom message to include in response

**Example:**
```typescript
lambderMSW.mockWithMessage('updateProfile', async (payload) => {
    return { userId: payload.userId, updated: true };
}, 'Profile updated successfully');
```

## Complete Testing Example

```typescript
// test/api.test.ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { LambderMSW } from 'lambder';
import { LambderCaller } from 'lambder';
import type { MyApiContract } from '../shared/apiContract';

// Setup MSW
const lambderMSW = new LambderMSW<MyApiContract>({
    apiPath: '/secure',
    apiVersion: '1.0.0'
});

const handlers = [
    lambderMSW.mockApi('getUserById', async (payload) => {
        if (payload.userId === '123') {
            return {
                id: '123',
                name: 'John Doe',
                email: 'john@example.com'
            };
        }
        return null;
    }),
    
    lambderMSW.mockApi('createUser', async (payload) => {
        return {
            id: Math.random().toString(),
            name: payload.name,
            email: payload.email
        };
    }, { delay: 100 }),  // Simulate 100ms delay
    
    lambderMSW.mockSessionExpired('getProtectedData'),
    
    lambderMSW.mockError('failingApi', 'Something went wrong')
];

const server = setupServer(...handlers);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Setup LambderCaller
const caller = new LambderCaller<MyApiContract>({
    apiPath: '/secure',
    isCorsEnabled: false
});

describe('User APIs', () => {
    it('should fetch user by id', async () => {
        const result = await caller.api('getUserById', { userId: '123' });
        
        expect(result).toEqual({
            id: '123',
            name: 'John Doe',
            email: 'john@example.com'
        });
    });
    
    it('should create a new user', async () => {
        const result = await caller.api('createUser', {
            name: 'Jane Smith',
            email: 'jane@example.com'
        });
        
        expect(result?.name).toBe('Jane Smith');
        expect(result?.email).toBe('jane@example.com');
        expect(result?.id).toBeDefined();
    });
    
    it('should handle session expired', async () => {
        try {
            await caller.api('getProtectedData', {});
            // Should not reach here
            expect(true).toBe(false);
        } catch (error: any) {
            expect(error.sessionExpired).toBe(true);
        }
    });
    
    it('should handle errors', async () => {
        try {
            await caller.api('failingApi', {});
            // Should not reach here
            expect(true).toBe(false);
        } catch (error: any) {
            expect(error.errorMessage).toBe('Something went wrong');
        }
    });
});
```

## Browser Testing

LambderMSW also works in browser environments with MSW's browser integration:

```typescript
// test/browser-setup.ts
import { setupWorker } from 'msw/browser';
import { LambderMSW } from 'lambder';
import type { MyApiContract } from '../shared/apiContract';

const lambderMSW = new LambderMSW<MyApiContract>({
    apiPath: '/secure'
});

const handlers = [
    lambderMSW.mockApi('getUserById', async (payload) => {
        return {
            id: payload.userId,
            name: 'John Doe',
            email: 'john@example.com'
        };
    })
];

const worker = setupWorker(...handlers);

// Start the worker
worker.start();
```

## Advanced Usage

### Dynamic Mock Responses

```typescript
lambderMSW.mockApi('searchUsers', async (payload) => {
    const { query, limit } = payload;
    
    // Return different responses based on input
    if (query === 'admin') {
        return [{
            id: '1',
            name: 'Admin User',
            role: 'admin'
        }];
    }
    
    return Array.from({ length: limit }, (_, i) => ({
        id: `${i}`,
        name: `User ${i}`,
        role: 'user'
    }));
});
```

### Simulating Network Conditions

```typescript
// Slow network
lambderMSW.mockApi('slowApi', async () => {
    return { data: 'slow response' };
}, { delay: 3000 });  // 3 second delay

// Intermittent failures
let callCount = 0;
lambderMSW.mockApi('flakeyApi', async () => {
    callCount++;
    if (callCount % 3 === 0) {
        throw new Error('Random failure');
    }
    return { success: true };
});
```

### Override Handlers Per Test

```typescript
it('should handle specific user', async () => {
    // Override the default handler for this test
    server.use(
        lambderMSW.mockApi('getUserById', async (payload) => {
            return {
                id: payload.userId,
                name: 'Special User',
                email: 'special@example.com'
            };
        })
    );
    
    const result = await caller.api('getUserById', { userId: '999' });
    expect(result?.name).toBe('Special User');
});
```

## Benefits

✅ **Type Safety** - Full TypeScript support with API contracts  
✅ **Simple API** - Intuitive methods matching Lambder's API structure  
✅ **Flexible** - Mock success, errors, delays, and custom responses  
✅ **Isolated** - Tests run without real backend dependencies  
✅ **Fast** - No network calls, instant test execution  
✅ **Realistic** - Simulate real-world scenarios (delays, errors, etc.)  

## Troubleshooting

### MSW Not Found Error

If you see "MSW (Mock Service Worker) is required", make sure MSW is installed:

```bash
npm install msw --save-dev
```

### Handler Not Matching

LambderMSW matches handlers based on the `apiName` in the request body. Make sure:
1. Your `apiPath` matches between backend, frontend, and mocks
2. The API name string matches exactly
3. Handlers are registered before making requests

### Console Warnings

LambderMSW logs matching information to console for debugging. To see these logs:
- Check browser console for "LambderMSW called for:" messages
- Verify "Matched!" appears when handler should execute

## See Also

- [MSW Documentation](https://mswjs.io/)
- [Type-Safe Quick Start](./TYPE_SAFE_QUICK_START.md)
- [Lambder Main Documentation](../Readme.md)
