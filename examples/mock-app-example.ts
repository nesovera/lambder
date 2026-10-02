/**
 * LambderMockApp example: a typed contract served from mock handlers over
 * the real API pipeline, in development and in tests.
 *
 * In an app the contract is a type-only import from the backend
 * (`import type { ApiContractType, SessionData } from "./backend/handler"`),
 * which is the whole point: the server's schemas never reach the browser
 * bundle. It is written out here so this file compiles as it stands, which is
 * what keeps the example honest.
 */

import { z } from "zod";
import { initLambderMock, lambderMockConsoleLogger, LambderCookieJar, refuse } from "../src/mock.js";
import { LambderCaller } from "../src/client.js";

// ---------------------------------------------------------------------------
// 0. What the backend exports: the contract type and the session data
// ---------------------------------------------------------------------------

type Permission = "ORDERS.CREATE" | "ORDERS.VIEW";

type SessionData = {
    userId: string;
    staffRoles: { storeId: string; permissions: Permission[] }[];
};

type ApiContractType = {
    "user.get": { input: { userId: string }; output: { id: string; name: string }; mode: "public"; refusals: { "app/not-found": {} } };
    "account.login": { input: { email: string }; output: { ok: boolean }; mode: "public"; rateLimit: "authPerIp" };
    "account.logout": { input: {}; output: { ok: boolean }; mode: "session"; guards: "signedIn" };
    "order.create": {
        input: { qty: number };
        output: { orderId: string; storeId: string; qty: number };
        mode: "session";
        // The codes the server declares for it, its guard's included.
        refusals: { "app/not-staff": {} };
        guards: { staffPermission: Permission };
        guardInputs: { staffPermission: { storeId: string } };
        idempotency: true;
    };
    "admin.exportOrders": { input: { month: string }; output: unknown; mode: "public" };
};

// ---------------------------------------------------------------------------
// 1. The mock app: the same subsystems the server has, over memory stores
// ---------------------------------------------------------------------------

const mock = initLambderMock<ApiContractType, SessionData>();

export const mockApp = mock.create({
    apiVersion: "1.0.0",
    latency: { min: 20, max: 80 },
    sessions: true,
    idempotency: true,
    rateLimits: { policies: { authPerIp: { perMin: 5, per: "ip" } } },
    guards: {
        // One mock guard per guard name the contract declares; the compiler
        // checks the map against the contract.
        staffPermission: mock.guard({
            guardInput: z.object({ storeId: z.string() }),
            session: true,
            handler: (ctx, { storeId }, permission: Permission) => {
                const role = ctx.session.data.staffRoles.find((r) => r.storeId === storeId);
                if (!role) refuse("You are not on this store's staff.", { code: "app/not-staff", notAuthorized: true });
                if (!role.permissions.includes(permission)) refuse("Not allowed.", { notAuthorized: true });
                return role;
            },
        }),
        signedIn: mock.guard({ session: true, handler: () => {} }),
    },
});

// ---------------------------------------------------------------------------
// 2. The registry: one slice per module, name-first entries
// ---------------------------------------------------------------------------

const users = [{
    id: "u1",
    email: "ada@example.com",
    name: "Ada",
    staffRoles: [{ storeId: "store-1", permissions: ["ORDERS.CREATE"] as Permission[] }],
}];

export const userMocks = mockApp.apiSlice(
    mockApp.api("user.get", async (ctx) => {
        const user = users.find((u) => u.id === ctx.payload.userId);
        // Typed to the endpoint's declared codes; `return` lets the compiler narrow `user` below.
        if (!user) return ctx.refuse("No such user.", { code: "app/not-found" });
        return { id: user.id, name: user.name };
    }),
    mockApp.api("account.login", { rateLimit: "authPerIp", handler: async ({ payload, sessionController }) => {
        const user = users.find((u) => u.email === payload.email) ?? refuse("Wrong email or password.");
        await sessionController.createSession(user.id, { userId: user.id, staffRoles: user.staffRoles });
        return { ok: true };
    } }),
    // Its session guard, restated, is what makes the entry a session endpoint, as on the server.
    mockApp.api("account.logout", { guards: "signedIn", handler: async ({ sessionController }) => { await sessionController.endSession(); return { ok: true }; } }),
);

export const orderMocks = mockApp.apiSlice(
    mockApp.api("order.create", {
        guards: { staffPermission: "ORDERS.CREATE" },   // pinned to the server's declaration
        idempotency: true,
        handler: async ({ payload, guardData }) => ({ orderId: "o_1", storeId: guardData.staffPermission.storeId, ...payload }),
    }),
    mockApp.notMocked("admin.exportOrders", "operator endpoint, no client calls it"),
);

// Exhaustive over the contract: a missing endpoint or one mocked twice is a compile error.
mockApp.register(userMocks, orderMocks);

// ---------------------------------------------------------------------------
// 3. In the browser, at boot, behind the app's own dev guard
// ---------------------------------------------------------------------------

export const caller = new LambderCaller<ApiContractType>({ apiPath: "/api", apiVersion: "1.0.0" });

export const attachMocksInDevelopment = (isDevelopment: boolean) => {
    if (!isDevelopment) return;
    mockApp.attach(caller);
    mockApp.subscribe("console", lambderMockConsoleLogger({ payloads: true }));
};

// ---------------------------------------------------------------------------
// 4. In tests: one caller per browser, sessions in cookie jars, failures on demand
// ---------------------------------------------------------------------------

export const exampleTest = async () => {
    const jar = new LambderCookieJar();
    await mockApp.signIn("u1", { userId: "u1", staffRoles: users[0]!.staffRoles }, { jar });
    const clerk = new LambderCaller<ApiContractType>({ apiPath: "/api", transport: mockApp.transport({ cookies: jar }) });

    // The contract declares idempotency for this endpoint, so the call owes a key.
    const order = await clerk.api("order.create", { qty: 2 }, { guardInputs: { staffPermission: { storeId: "store-1" } }, idempotencyKey: "order-2f8c41d6e9a7" });
    console.log(order);   // { orderId: "o_1", storeId: "store-1", qty: 2 }

    mockApp.failNext("order.create", "network");
    const outcome = await clerk.apiOutcome("order.create", { qty: 2 }, { guardInputs: { staffPermission: { storeId: "store-1" } }, idempotencyKey: "order-9b3e07a5c4d1" });
    console.log(outcome.ok ? "ok" : outcome.reason);   // "network"

    console.log(mockApp.calls.at(-1)?.outcome);   // "injected"
    mockApp.reset();
};
