# Output Type Enforcement - Implementation Summary

## Problem
The type system was only enforcing input types for `ctx.apiPayload`, but not enforcing that the output returned by `resolver.api()` matched the contract's output type.

## Solution
Made the following components generic to propagate type information:

### 1. LambderResponseBuilder
- Added generic parameter: `LambderResponseBuilder<TContract extends ApiContractShape = any>`
- The `api()` method now uses the generic type for type checking

### 2. LambderResolver
- Added generic parameters: `LambderResolver<TContract extends ApiContractShape = any, TApiName extends keyof TContract & string = any>`
- Overrides the `api()` method to enforce output type: `api(payload: ApiOutput<TContract, TApiName> | null, ...)`
- The `die.api()` method also enforces the output type through the interface

### 3. Lambder addApi/addSessionApi
- Updated type signatures to pass `LambderResolver<TContract, TApiName>` to the action function
- Now both methods enforce:
  - ✅ Input type via `ctx.apiPayload: TContract[TApiName]['input']`
  - ✅ Output type via `resolver.api(payload: TContract[TApiName]['output'] | null)`

## Type Flow
```
Contract Definition
    ↓
Lambder<TContract>
    ↓
addApi<TApiName>(apiName, actionFn)
    ↓
actionFn(ctx: LambderRenderContext<Input>, resolver: LambderResolver<TContract, TApiName>)
    ↓
resolver.api(payload: Output | null)
    ↓
Type validation at compile time!
```

## What's Enforced Now

### Input Types (already working)
```typescript
lambder.addApi('getUserById', async (ctx, resolver) => {
    ctx.apiPayload.userId; // ✅ TypeScript knows this is string
});
```

### Output Types (NEW!)
```typescript
lambder.addApi('getUserById', async (ctx, resolver) => {
    const user = { id: "123", name: "John", age: 30 };
    return resolver.api(user); // ✅ TypeScript validates user matches User type
    
    // return resolver.api("wrong"); // ❌ TypeScript error!
});
```

## Features
- ✅ Works with `resolver.api()`
- ✅ Works with `resolver.die.api()`
- ✅ Works with `addApi()`
- ✅ Works with `addSessionApi()`
- ✅ Supports nullable outputs (`output: User | null`)
- ✅ Supports complex nested types
- ✅ Supports arrays
- ✅ Supports primitive types
- ✅ Zero runtime overhead - all validation is at compile time
- ✅ Backward compatible - untyped APIs still work

## Files Changed
1. `src/LambderResponseBuilder.ts` - Made generic, imported ApiContractShape
2. `src/LambderResolver.ts` - Made generic, added typed `api()` override
3. `src/Lambder.ts` - Updated addApi/addSessionApi type signatures
4. `docs/TYPE_SAFE_QUICK_START.md` - Updated documentation with output type examples

## Examples Created
1. `examples/test-output-type-enforcement.ts` - Unit test for type enforcement
2. `examples/output-type-enforcement-example.ts` - Comprehensive demonstration

## Testing
All existing examples and tests compile without errors:
- ✅ `examples/simplified-typed-api-example.ts`
- ✅ `tests/type-safety.test.ts`
- ✅ No TypeScript compilation errors in project

## Backward Compatibility
The changes are fully backward compatible:
- Untyped usage still works: `new Lambder({ ... })` without generic
- Typed usage is opt-in: `new Lambder<MyContract>({ ... })`
- Existing code continues to work unchanged
