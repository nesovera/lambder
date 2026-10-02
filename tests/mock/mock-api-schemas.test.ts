/**
 * The mock created with the generated schemas module (writeApiSchemas)
 * beside the server it was generated from, in the adapter conformance
 * suite's style (tests/api/conformance.test.ts): the same call through the
 * real server and through the mock, the status, envelope and outcome
 * compared. With the module the mock refuses what the server refuses and
 * drops what the server drops; without it, it does neither, as before.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import LambderCaller from '../../src/client/LambderCaller.js';
import { lambderHandlerTransport } from '../../src/invoke/lambderHandlerTransport.js';
import type { LambderApiTransport } from '../../src/shared/transport/LambderApiTransport.js';
import { initLambderMock } from '../../src/mock/LambderMockApp.js';
import { LambderMockApiSchemas } from '../../src/mock/LambderMockApiSchemas.js';
import { LambderApiOutputValidationError } from '../../src/api/LambderApiOutputValidationError.js';
import { apiSchemas } from '../fixtures/schema-app/apiSchemas.generated.js';
import { createShopApp, orderAnswerOf, STORES, type ShopContract } from '../fixtures/schema-app/shop.js';

type Observed = { status: number; envelope: unknown };

const observing = (transport: LambderApiTransport, sink: Observed[]): LambderApiTransport => async (request) => {
    const answer = await transport(request);
    const text = await answer.text();
    sink.push({ status: answer.status, envelope: JSON.parse(text) });
    return { ...answer, text: async () => text, json: async () => JSON.parse(text) };
};

/** The answer to an invalid input both sides give when the app words it itself. */
const checkFieldRefusal = (zodError: z.ZodError) => ({ refusal: `Check ${zodError.issues[0]?.path.join('.')}.` });

/**
 * The mock of the shop: each handler what the server's does, written against
 * the contract. `withSchemas` gives it the generated module.
 */
const createShopMock = (options: { withSchemas: boolean; invalidInputRefusal?: boolean }) => {
    const mock = initLambderMock<ShopContract>();
    const mockApp = mock.create({
        apiVersion: '1',
        revealHandlerErrors: false,
        ...(options.withSchemas ? { apiSchemas } : {}),
        ...(options.invalidInputRefusal ? { onInvalidInput: (zodError: z.ZodError) => ({ config: checkFieldRefusal(zodError) }) } : {}),
    });
    mockApp.register(mockApp.apiSlice(
        // The courier note is the output schema's default to fill, as it is
        // on the server; the contract types a mock handler's answer as the
        // client receives it, so the handler that leaves it to the schema
        // says so.
        mockApp.api('orders.place', async ({ payload }) => orderAnswerOf(payload) as unknown as ShopContract['orders.place']['output']),
        mockApp.api('stores.search', async ({ payload }) => {
            // The limit is optional in the contract and filled by the parse,
            // the server's or, with the module, the mock's.
            const answer = { query: payload.query, limit: payload.limit as number, stores: STORES.slice(0, payload.limit) };
            return answer;
        }),
        mockApp.api('tickets.open', async ({ payload }) => ({ ticketId: 'T-1', seat: payload.seat, guests: payload.guests ?? 1 })),
        mockApp.api('catalog.update', async ({ payload }) => {
            const answer = { product: payload.product, category: payload.category, tags: payload.tags };
            return answer;
        }),
    ));
    return mockApp;
};

/** The server and the mock side by side, a caller each, and what each observed. */
const createSides = (options: { withSchemas?: boolean; invalidInputRefusal?: boolean } = {}) => {
    const server = createShopApp();
    if(options.invalidInputRefusal) server.setApiInputValidationErrorHandler((_ctx, res, zodError) => res.apiRefusal(checkFieldRefusal(zodError)));
    const mockApp = createShopMock({ withSchemas: options.withSchemas ?? true, invalidInputRefusal: options.invalidInputRefusal });
    const observed = { server: [] as Observed[], mock: [] as Observed[] };
    return {
        mockApp,
        observed,
        server: new LambderCaller<ShopContract>({ apiPath: '/api', isCorsEnabled: false, apiVersion: '1', transport: observing(lambderHandlerTransport(server.getHandler()), observed.server) }),
        mock: new LambderCaller<ShopContract>({ apiPath: '/api', isCorsEnabled: false, apiVersion: '1', transport: observing(mockApp.transport(), observed.mock) }),
    };
};

type Sides = ReturnType<typeof createSides>;

/** One call on each side, and what each side observed, the outcome's reason included. */
const bothSides = async <K extends keyof ShopContract & string>(sides: Sides, apiName: K, payload: unknown) => {
    // Untyped here on purpose: the matrix posts what the contract does not allow.
    const serverOutcome = await (sides.server as LambderCaller<any>).apiOutcome(apiName, payload);
    const mockOutcome = await (sides.mock as LambderCaller<any>).apiOutcome(apiName, payload);
    const reasonOf = (outcome: typeof serverOutcome) => outcome.ok ? 'ok' : outcome.reason;
    return {
        server: { ...sides.observed.server.at(-1)!, reason: reasonOf(serverOutcome) },
        mock: { ...sides.observed.mock.at(-1)!, reason: reasonOf(mockOutcome) },
    };
};

/** Runs the call on both sides and asserts they answered alike, and answers what they answered. */
const same = async <K extends keyof ShopContract & string>(sides: Sides, apiName: K, payload: unknown) => {
    const { server, mock } = await bothSides(sides, apiName, payload);
    expect(mock).toEqual(server);
    return server;
};

/** The paths of a validation answer's issues. */
const issuePathsOf = (observed: Observed) => (observed.envelope as { zodError: { issues: { path: unknown[] }[] } }).zodError.issues.map((issue) => issue.path.join('.'));

/**
 * Runs the call on both sides and asserts both refused it as invalid input
 * alike: the status, the outcome, the answer's shape, on the same field. The
 * issue list itself is zod's reading of each schema, and the rebuilt one
 * reads a few shapes in other words (a discriminated union as a union, a
 * format beside its pattern as two issues).
 */
const sameRefusal = async <K extends keyof ShopContract & string>(sides: Sides, apiName: K, payload: unknown) => {
    const { server, mock } = await bothSides(sides, apiName, payload);
    const shapeOf = (observed: Observed & { reason: string }) => ({
        status: observed.status,
        reason: observed.reason,
        error: (observed.envelope as { error?: unknown }).error,
        field: issuePathsOf(observed)[0]!.split('.')[0],
    });
    expect(shapeOf(mock)).toEqual(shapeOf(server));
    expect(shapeOf(server)).toMatchObject({ status: 422, reason: 'validation', error: 'Input validation failed' });
    return { server, mock };
};

const validOrder = {
    customer: { name: 'Ada Park', email: 'ada@example.com' },
    items: [{ sku: 'TEA-101', quantity: 2 }],
    delivery: 'pickup',
    payment: { method: 'card', last4: '4242' },
};

const validProduct = {
    product: { sku: 'MUG-12', title: 'Brooklyn mug' },
    attributes: { color: { value: 'blue' } },
    dimensions: [9, 9, 11],
    tags: { season: 'fall' },
    category: { name: 'Kitchen', children: [{ name: 'Mugs', children: [] }] },
    price: { amount: 14, currency: 'USD' },
    discontinuedAt: null,
};

describe('A mock given the generated schemas answers as the server does', () => {
    it('a valid call: the same answer, what the output does not declare dropped and its default filled', async () => {
        const answer = await same(createSides(), 'orders.place', validOrder);
        expect(answer).toMatchObject({ status: 200, reason: 'ok' });
        expect(answer.envelope).toEqual({
            apiVersion: '1',
            payload: { orderNumber: 'NYC-1', status: 'placed', total: 25, lines: [{ sku: 'TEA-101', quantity: 2 }], courierNote: 'Leave it with the doorman' },
        });
    });

    it('refuses a length, a pattern, a range, an enum, a missing field and an array bound with the same answer, issues included', async () => {
        const sides = createSides();
        const cases: unknown[] = [
            { ...validOrder, customer: { ...validOrder.customer, name: 'A' } },
            { ...validOrder, customer: { ...validOrder.customer, name: 'A'.repeat(41) } },
            { ...validOrder, items: [{ sku: 'tea-101', quantity: 2 }] },
            { ...validOrder, items: [{ sku: 'TEA-101', quantity: 11 }] },
            { ...validOrder, items: [{ sku: 'TEA-101', quantity: 1.5 }] },
            { ...validOrder, items: [] },
            { ...validOrder, delivery: 'drone' },
            { ...validOrder, customer: undefined },
            { ...validOrder, note: 'x'.repeat(201) },
        ];
        for(const payload of cases){
            const answer = await same(sides, 'orders.place', payload);
            expect(answer).toMatchObject({ status: 422, reason: 'validation' });
        }
    });

    it('refuses a bad format and a bad union branch with the same answer on the same field, in zod\'s words for each schema', async () => {
        const sides = createSides();
        const email = await sameRefusal(sides, 'orders.place', { ...validOrder, customer: { ...validOrder.customer, email: 'ada at example' } });
        expect(new Set(issuePathsOf(email.mock))).toEqual(new Set(['customer.email']));
        await sameRefusal(sides, 'orders.place', { ...validOrder, payment: { method: 'voucher', code: 'SHORT' } });
        await sameRefusal(sides, 'orders.place', { ...validOrder, payment: { method: 'card', last4: '42' } });
        await sameRefusal(sides, 'orders.place', { ...validOrder, payment: { method: 'cash' } });
    });

    it('hands the handler the payload as the server\'s parse leaves it: defaults filled, undeclared keys dropped', async () => {
        const sides = createSides();
        const filled = await same(sides, 'stores.search', { query: 'tea' });
        expect(filled.envelope).toMatchObject({ payload: { query: 'tea', limit: 10 } });

        const stripped = await same(sides, 'stores.search', { query: { near: { lat: 40.71, lng: -74.0, label: 'office' }, radius: 3 }, limit: 1, debug: true });
        expect(stripped.envelope).toEqual({ apiVersion: '1', payload: { query: { near: { lat: 40.71, lng: -74.0 } }, limit: 1, stores: [{ name: 'Hudson Yards', borough: 'Manhattan' }] } });

        expect(await same(sides, 'stores.search', { query: { near: { lat: 91, lng: 0 } } })).toMatchObject({ status: 422 });
        expect(await same(sides, 'stores.search', { query: 't' })).toMatchObject({ status: 422 });
    });

    it('keeps strict, loose, record, tuple, recursive, intersected and nullable shapes as the server does', async () => {
        const sides = createSides();
        const updated = await same(sides, 'catalog.update', {
            ...validProduct,
            attributes: { color: { value: 'blue', hex: '#00f' } },
            tags: { season: 'fall', shelf: 'B4' },
            category: { name: 'Kitchen', note: 'dropped', children: [{ name: 'Mugs', children: [], note: 'dropped too' }] },
            price: { amount: 14, currency: 'USD', taxed: true },
        });
        expect(updated.envelope).toEqual({
            apiVersion: '1',
            payload: { product: { sku: 'MUG-12', title: 'Brooklyn mug' }, category: { name: 'Kitchen', children: [{ name: 'Mugs', children: [] }] }, tags: { season: 'fall', shelf: 'B4' } },
        });

        for(const payload of [
            { ...validProduct, product: { ...validProduct.product, owner: 'ops' } },
            { ...validProduct, dimensions: [9, 9, -1] },
            { ...validProduct, category: { name: 'Kitchen', children: [{ name: '', children: [] }] } },
            { ...validProduct, price: { amount: 14, currency: 'EUR' } },
            { ...validProduct, attributes: { color: { unit: 'rgb' } } },
        ]){
            expect(await same(sides, 'catalog.update', payload)).toMatchObject({ status: 422, reason: 'validation' });
        }
        // A tuple short of its length, and a nullable date-time: refused alike, in zod's words for each.
        await sameRefusal(sides, 'catalog.update', { ...validProduct, dimensions: [9, 9] });
        await sameRefusal(sides, 'catalog.update', { ...validProduct, discontinuedAt: 'last tuesday' });
        expect(await same(sides, 'catalog.update', { ...validProduct, discontinuedAt: '2026-03-01T09:00:00Z' })).toMatchObject({ status: 200 });
    });

    it('answers a bad input as the app words it, where the server sets its handler and the mock states it', async () => {
        const refused = await same(createSides({ invalidInputRefusal: true }), 'orders.place', { ...validOrder, delivery: 'drone' });
        expect(refused).toMatchObject({ status: 200, reason: 'refusal' });
        expect(refused.envelope).toMatchObject({ refusal: { content: 'Check delivery.' } });
    });

    it('does not carry a refinement or a transform, the ones the writer lists', async () => {
        const sides = createSides();
        // The refinement on the seat: the server refuses it, the mock lets it through.
        const refined = await bothSides(sides, 'tickets.open', { subject: 'Window seat', seat: 'zz' });
        expect([refined.server.reason, refined.mock.reason]).toEqual(['validation', 'ok']);
        // The rewrite on the subject (trim) and the transform on the output seat.
        const transformed = await bothSides(sides, 'tickets.open', { subject: '   ab   ', seat: 'c12' });
        expect([transformed.server.reason, transformed.mock.reason]).toEqual(['validation', 'ok']);
        // Everything else about the endpoint still holds.
        expect(await same(sides, 'tickets.open', { subject: 'Window seat', seat: 'C12', guests: 5 })).toMatchObject({ status: 422 });
    });

    it('refuses a handler\'s answer the output schema rejects, as the server crashes on its own', async () => {
        const mockApp = createShopMock({ withSchemas: true });
        mockApp.override('orders.place', async () => ({ orderNumber: 'NYC-1', status: 'lost' } as never));
        const caller = new LambderCaller<ShopContract>({ apiPath: '/api', isCorsEnabled: false, apiVersion: '1', transport: mockApp.transport() });
        const outcome = await caller.apiOutcome('orders.place', validOrder as never);
        expect(outcome).toMatchObject({ ok: false, reason: 'server', status: 500 });
        expect(mockApp.calls.at(-1)?.error).toBeInstanceOf(LambderApiOutputValidationError);
    });

    it('without the module, behaves as before: a bad input reaches the handler and an answer goes out as returned', async () => {
        const sides = createSides({ withSchemas: false });
        const { server, mock } = await bothSides(sides, 'orders.place', { ...validOrder, customer: { ...validOrder.customer, name: 'A' } });
        expect([server.reason, mock.reason]).toEqual(['validation', 'ok']);
        expect(mock.envelope).toMatchObject({ payload: { internalNote: 'checked by the night shift', lines: [{ sku: 'TEA-101', quantity: 2, unitCost: 12.5 }] } });
    });
});

describe('The apiSchemas option', () => {
    it('applies an entry\'s own input schema after the server\'s, on what the server\'s leaves', async () => {
        const mockApp = initLambderMock<ShopContract>().create({ apiSchemas });
        const seen: unknown[] = [];
        mockApp.registerPartial(mockApp.apiSlice(mockApp.api('tickets.open', {
            // The seat refinement, restated where a test exercises it.
            input: z.object({ subject: z.string(), seat: z.string().regex(/^[A-Z]\d{1,2}$/), guests: z.number().optional() }),
            handler: async ({ payload }) => { seen.push(payload); return { ticketId: 'T-1', seat: payload.seat, guests: payload.guests ?? 0 }; },
        })));
        const caller = new LambderCaller<ShopContract>({ apiPath: '/api', isCorsEnabled: false, transport: mockApp.transport() });

        expect(await caller.apiOutcome('tickets.open', { subject: 'Window seat', seat: 'zz' })).toMatchObject({ ok: false, reason: 'validation' });
        expect(await caller.apiOutcome('tickets.open', { subject: 'ab', seat: 'C12' })).toMatchObject({ ok: false, reason: 'validation' });
        expect(await caller.apiOutcome('tickets.open', { subject: 'Window seat', seat: 'C12', extra: true } as never)).toMatchObject({ ok: true });
        // The server's default filled and the undeclared key dropped before the entry's own schema ran.
        expect(seen).toEqual([{ subject: 'Window seat', seat: 'C12', guests: 1 }]);
    });

    it('refuses an entry the table does not hold when it registers, naming the writer', () => {
        const { 'tickets.open': _dropped, ...stale } = apiSchemas;
        const mockApp = initLambderMock<ShopContract>().create({ apiSchemas: stale as typeof apiSchemas });
        expect(() => mockApp.api('tickets.open', async () => ({ ticketId: 'T-1', seat: 'C12', guests: 1 }))).toThrow(
            'LambderMockApp: "tickets.open" has no entry in the apiSchemas table given to create(). The table predates this endpoint: regenerate it with writeApiSchemas.',
        );
    });

    it('takes the generated module as it is, and refuses at compile time one that predates an endpoint', () => {
        initLambderMock<ShopContract>().create({ apiSchemas });
        const { 'tickets.open': _dropped, ...stale } = apiSchemas;
        // @ts-expect-error the table has no entry for tickets.open
        initLambderMock<ShopContract>().create({ apiSchemas: stale });
    });
});

describe('LambderMockApiSchemas', () => {
    const table = {
        'stores.search': apiSchemas['stores.search'],
        'stores.broken': { input: { if: { type: 'string' }, then: { minLength: 2 } }, output: { type: 'object', properties: {} } },
        'stores.marked': { input: { type: 'string', 'x-lambder-strip-unknown-keys': true }, output: true },
    };

    it('rebuilds a schema on the first parse that reaches it, once', () => {
        const schemas = new LambderMockApiSchemas(table);
        // Taken at registration, rebuilt only when parsed.
        const broken = schemas.inputOf('stores.broken');
        expect(() => broken.parse('ok')).toThrow('LambderMockApp: the input schema of "stores.broken" in the apiSchemas table could not be rebuilt.');
        // The schemas of the other APIs are untouched by it.
        expect(schemas.inputOf('stores.search').parse({ query: 'tea' })).toEqual({ query: 'tea', limit: 10 });
        expect(schemas.parseOutput('stores.search', { query: 'tea', limit: 1, stores: [], extra: 1 })).toEqual({ query: 'tea', limit: 1, stores: [] });
    });

    it('parses an answer as the server does, the error the server crashes with when it is rejected', () => {
        const schemas = new LambderMockApiSchemas(table);
        expect(() => schemas.parseOutput('stores.search', { query: 'tea' })).toThrow(LambderApiOutputValidationError);
    });

    it('refuses a mark on a schema that is not an object: a table writeApiSchemas did not write', () => {
        const schemas = new LambderMockApiSchemas(table);
        expect(() => schemas.inputOf('stores.marked').parse('C12')).toThrow(expect.objectContaining({
            cause: expect.objectContaining({ message: expect.stringMatching(/a "string" schema is marked to drop unknown keys, which only an object can/) }),
        }));
    });
});
