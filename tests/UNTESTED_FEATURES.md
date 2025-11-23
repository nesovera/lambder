# Untested Features in Lambder

This document lists features that currently lack test coverage.

## ✅ Currently Tested Features

Based on existing test files:

1. **Type Safety** (`type-safety.test.ts`)
   - LambderCaller type inference
   - Lambder API type safety
   - Input/output type enforcement
   - Complex type patterns
   - Type inference from contracts

2. **Session Management** (`session.test.ts`)
   - Session creation, fetching, updating, deletion
   - Session regeneration
   - Session security (CSRF, validation)
   - Session type safety
   - Sliding expiration

3. **Output Type Runtime** (`output-type-runtime.test.ts`)
   - Runtime validation of API outputs
   - Zod schema enforcement at runtime
   - API response format validation

4. **Plugin System** (`use-plugin.test.ts`)
   - Basic plugin usage
   - Multiple plugin chaining
   - Plugin type accumulation
   - Nested plugins
   - Plugin reusability

## ❌ Untested Features (Needs Test Coverage)

### 1. Routes (`addRoute`, `addSessionRoute`)
**Priority: HIGH**

- [x] Basic route matching (string paths)
- [ ] Path parameter extraction (e.g., `/user/:userId`)
- [ ] RegExp route matching
- [ ] Function-based conditional routing
- [ ] Session-protected routes (`addSessionRoute`)
- [ ] Route priority/ordering
- [ ] Wildcard routes

**Suggested test file:** `tests/routes.test.ts`

### 2. Hooks System
**Priority: HIGH**

- [ ] `beforeRender` hook execution
- [ ] `afterRender` hook execution
- [ ] `fallback` hook execution
- [ ] `created` hook execution
- [ ] Hook priority ordering
- [ ] Multiple hooks of same type
- [ ] Hook error handling
- [ ] Context modification in hooks
- [ ] Response modification in hooks

**Suggested test file:** `tests/hooks.test.ts`

### 3. Error Handling
**Priority: HIGH**

- [ ] `setGlobalErrorHandler` functionality
- [ ] Error handling with context available
- [ ] Error handling with null context
- [ ] Custom error responses
- [ ] Error in API handlers
- [ ] Error in route handlers
- [ ] Error in hooks
- [ ] Error log accumulation

**Suggested test file:** `tests/error-handling.test.ts`

### 4. Fallback Handlers
**Priority: MEDIUM**

- [ ] `setRouteFallbackHandler` for unmatched routes
- [ ] `setApiFallbackHandler` for unmatched APIs
- [ ] Default fallback behavior (no handler set)
- [ ] Fallback handler with custom responses

**Suggested test file:** `tests/fallback-handlers.test.ts`

### 5. Response Methods (LambderResolver/LambderResponseBuilder)
**Priority: MEDIUM**

- [x] `res.api()` - tested in output-type-runtime
- [ ] `res.json()`
- [ ] `res.html()`
- [ ] `res.xml()`
- [ ] `res.raw()`
- [ ] `res.file()` with fallback
- [ ] `res.fileBase64()`
- [ ] `res.ejsFile()`
- [ ] `res.ejsTemplate()`
- [ ] `res.status301()` (redirects)
- [ ] `res.status404()`
- [ ] `res.cors()`
- [ ] `res.die.*` methods (skip afterRender hooks)
- [ ] Custom headers in responses
- [ ] `setHeader()` and `addHeader()` in context

**Suggested test file:** `tests/response-methods.test.ts`

### 6. CORS Support
**Priority: MEDIUM**

- [ ] `enableCors(true)` functionality
- [ ] CORS headers in responses
- [ ] OPTIONS request handling (preflight)
- [ ] CORS disabled behavior

**Suggested test file:** `tests/cors.test.ts`

### 7. API Version Management
**Priority: MEDIUM**

- [ ] Setting `apiVersion` in constructor
- [ ] Version mismatch detection
- [ ] Version expired response
- [ ] Client version validation
- [ ] Version header handling

**Suggested test file:** `tests/api-versioning.test.ts`

### 8. Context Variables
**Priority: LOW**

- [ ] `ctx.host` extraction
- [ ] `ctx.path` extraction
- [ ] `ctx.pathParams` for route parameters
- [ ] `ctx.get` (query parameters)
- [ ] `ctx.post` (POST body parsing)
- [ ] `ctx.cookie` parsing
- [ ] `ctx.headers` access
- [ ] `ctx.event` (raw Lambda event)
- [ ] `ctx.lambdaContext` (raw Lambda context)
- [ ] Base64 encoded body handling
- [ ] URL-encoded form data parsing

**Suggested test file:** `tests/context-extraction.test.ts`

### 9. LambderCaller Features
**Priority: MEDIUM**

- [x] Basic API calls - tested in type-safety
- [ ] `apiRaw()` method
- [ ] `fetchStartedHandler` callback
- [ ] `fetchEndedHandler` callback
- [ ] `errorMessageHandler` callback
- [ ] `activeFetchList` tracking
- [ ] Error response handling
- [ ] Session expired handling
- [ ] Version expired handling
- [ ] Not authorized handling
- [ ] Custom headers in requests
- [ ] CORS mode handling

**Suggested test file:** `tests/lambder-caller.test.ts`

### 10. LambderMSW Features
**Priority: MEDIUM**

- [ ] `mockApi()` basic functionality
- [ ] `mockSessionExpired()` helper
- [ ] `mockNotAuthorized()` helper
- [ ] `mockVersionExpired()` helper
- [ ] Custom mock options (delay, message, errorMessage)
- [ ] Type safety in mocks
- [ ] Multiple API mocks
- [ ] Mock priority/ordering

**Suggested test file:** `tests/lambder-msw.test.ts`

### 11. EJS Template Rendering
**Priority: LOW**

- [ ] `res.ejsFile()` rendering
- [ ] `res.ejsTemplate()` rendering
- [ ] Template `page` variable
- [ ] Partial `partial` variable
- [ ] `include()` function in templates
- [ ] Template error handling
- [ ] Custom headers with EJS

**Suggested test file:** `tests/ejs-templates.test.ts`

### 12. File Serving
**Priority: LOW**

- [ ] Static file serving with `res.file()`
- [ ] Fallback file (e.g., index.html)
- [ ] MIME type detection
- [ ] Base64 file responses
- [ ] File not found handling
- [ ] Public path configuration

**Suggested test file:** `tests/file-serving.test.ts`

### 13. Utility Methods
**Priority: LOW**

- [ ] `lambder.utils.*` methods
- [ ] `getSessionController()` helper
- [ ] `getResponseBuilder()` helper
- [ ] `getHandler()` export

**Suggested test file:** `tests/utilities.test.ts`

### 14. Edge Cases & Integration
**Priority: LOW**

- [ ] Multiple simultaneous requests
- [ ] Race conditions in session management
- [ ] Large payload handling
- [ ] Invalid JSON in request body
- [ ] Missing required fields
- [ ] Empty/null payloads
- [ ] Very long session data
- [ ] Malformed Lambda events

**Suggested test file:** `tests/edge-cases.test.ts`

## Test Coverage Priorities

### Must Have (Before v2.0 stable)
1. Routes and path parameters
2. Hooks system
3. Error handling
4. Response methods (at least common ones)

### Should Have (Before v2.1)
1. CORS support
2. API versioning
3. LambderCaller edge cases
4. Fallback handlers

### Nice to Have (Future releases)
1. EJS templates
2. File serving
3. Edge cases and stress testing
4. Integration tests

## How to Run Tests

```bash
# Run all tests
npm run test

# Run specific test file
npm run test -- tests/routes.test.ts

# Run tests in watch mode
npm run test -- --watch

# Run tests with coverage
npm run test -- --coverage
```
