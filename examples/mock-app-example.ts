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
    memberships: { organizationId: string; permissions: Permission[] }[];
};

type ApiContractType = {
    "user.get": { input: { userId: string }; output: { id: string; name: string }; mode: "public" };
    "login": { input: { email: string }; output: { ok: boolean }; mode: "public"; rateLimit: "authPerIp" };
    "logout": { input: {}; output: { ok: boolean }; mode: "session"; guards: "sessionOnly" };
    "order.create": {
        input: { qty: number };
        output: { orderId: string; organizationId: string; qty: number };
        mode: "session";
        guards: { orgPermission: Permission };
        guardInputs: { orgPermission: { organizationId: string } };
        idempotency: true;
    };
    "admin.runSignedQuery": { input: { sql: string }; output: unknown; mode: "public" };
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
        orgPermission: mock.guard({
            guardInput: z.object({ organizationId: z.string() }),
            session: true,
            handler: (ctx, { organizationId }, permission: Permission) => {
                const member = ctx.session.data.memberships.find((m) => m.organizationId === organizationId);
                if (!member) refuse("You do not belong to this organization.", { code: "app/not-a-member", notAuthorized: true });
                if (!member.permissions.includes(permission)) refuse("Not allowed.", { notAuthorized: true });
                return member;
            },
        }),
        sessionOnly: mock.guard({ session: true, handler: () => {} }),
    },
});

// ---------------------------------------------------------------------------
// 2. The registry: one slice per module, name-first entries
// ---------------------------------------------------------------------------

const users = [{
    id: "u1",
    email: "ada@example.com",
    name: "Ada",
    memberships: [{ organizationId: "org1", permissions: ["ORDERS.CREATE"] as Permission[] }],
}];

export const userMocks = mockApp.apiSlice(
    mockApp.publicApi("user.get", async ({ payload }) => {
        const user = users.find((u) => u.id === payload.userId) ?? refuse("No such user.", { code: "app/not-found" });
        return { id: user.id, name: user.name };
    }),
    mockApp.publicApi("login", { rateLimit: "authPerIp", handler: async ({ payload, sessions }) => {
        const user = users.find((u) => u.email === payload.email) ?? refuse("Wrong email or password.");
        await sessions.createSession(user.id, { userId: user.id, memberships: user.memberships });
        return { ok: true };
    } }),
    mockApp.sessionApi("logout", { guards: "sessionOnly", handler: async ({ sessions }) => { await sessions.endSession(); return { ok: true }; } }),
);

export const orderMocks = mockApp.apiSlice(
    mockApp.sessionApi("order.create", {
        guards: { orgPermission: "ORDERS.CREATE" },   // pinned to the server's declaration
        idempotency: true,
        handler: async ({ payload, guardData }) => ({ orderId: "o_1", organizationId: guardData.orgPermission.organizationId, ...payload }),
    }),
    mockApp.notMocked("admin.runSignedQuery", "operator endpoint, no client calls it"),
);

// Exhaustive over the contract: a missing endpoint or one mocked twice is a compile error.
mockApp.register(userMocks, orderMocks);

// ---------------------------------------------------------------------------
// 3. In the browser, at boot, behind the app's own dev guard
// ---------------------------------------------------------------------------

export const caller = new LambderCaller<ApiContractType>({ apiPath: "/api", isCorsEnabled: false, apiVersion: "1.0.0" });

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
    await mockApp.signIn("u1", { userId: "u1", memberships: users[0]!.memberships }, { jar });
    const signedIn = new LambderCaller<ApiContractType>({ apiPath: "/api", isCorsEnabled: false, transport: mockApp.transport({ cookies: jar }) });

    // The contract declares idempotency for this endpoint, so the call owes a key.
    const order = await signedIn.api("order.create", { qty: 2 }, { guardInputs: { orgPermission: { organizationId: "org1" } }, idempotencyKey: "order-2f8c41d6" });
    console.log(order);   // { orderId: "o_1", organizationId: "org1", qty: 2 }

    mockApp.failNext("order.create", "network");
    const outcome = await signedIn.apiOutcome("order.create", { qty: 2 }, { guardInputs: { orgPermission: { organizationId: "org1" } }, idempotencyKey: "order-9b3e07a5" });
    console.log(outcome.ok ? "ok" : outcome.reason);   // "network"

    console.log(mockApp.calls.at(-1)?.outcome);   // "injected"
    mockApp.reset();
};
