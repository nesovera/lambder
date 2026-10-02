/**
 * A shop whose endpoints carry every kind of schema writeApiSchemas writes
 * and the mock rebuilds: strings with lengths and formats, numbers with
 * ranges, enums, optional and defaulted fields, nested objects, arrays,
 * unions, strict, loose and recursive objects, records, tuples,
 * intersections, and a refinement and a transform, which the file cannot
 * carry. The build tests write its schemas from this module; the mock tests
 * run the mock beside it.
 */

import { z } from 'zod';
import { initLambder } from '../../../src/core/Lambder.js';

export type Category = { name: string; children: Category[] };
const categorySchema: z.ZodType<Category, Category> = z.object({ name: z.string().min(1), children: z.array(z.lazy(() => categorySchema)) });

const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'] as const;

const placeOrderInputOf = (nameMax: number) => z.object({
    customer: z.object({ name: z.string().min(2).max(nameMax), email: z.email() }),
    items: z.array(z.object({ sku: z.string().regex(/^[A-Z]{3}-\d{3}$/), quantity: z.number().int().min(1).max(10) })).min(1).max(5),
    delivery: z.enum(['pickup', 'courier']),
    note: z.string().max(200).optional(),
    giftWrap: z.boolean().default(false),
    payment: z.discriminatedUnion('method', [
        z.object({ method: z.literal('card'), last4: z.string().length(4) }),
        z.object({ method: z.literal('voucher'), code: z.string().min(6) }),
    ]),
});

export const placeOrderOutput = z.object({
    orderNumber: z.string(),
    status: z.enum(['placed', 'held']),
    total: z.number().nonnegative(),
    lines: z.array(z.object({ sku: z.string(), quantity: z.number().int() })),
    courierNote: z.string().default('Leave it with the doorman'),
});

const searchInput = z.object({
    query: z.union([z.string().min(2), z.object({ near: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }) })]),
    limit: z.number().int().min(1).max(50).default(10),
    openNow: z.boolean().optional(),
});

const searchOutput = z.object({
    query: z.union([z.string(), z.object({ near: z.object({ lat: z.number(), lng: z.number() }) })]),
    limit: z.number(),
    stores: z.array(z.object({ name: z.string(), borough: z.enum(BOROUGHS) })),
});

const openTicketInput = z.object({
    subject: z.string().trim().min(3),
    seat: z.string().refine((seat) => /^[A-Z]\d{1,2}$/.test(seat), 'A seat is a row letter and a number, such as C12'),
    guests: z.number().int().min(1).max(4).default(1),
});

const openTicketOutput = z.object({
    ticketId: z.string(),
    seat: z.string().transform((seat) => seat.toUpperCase()),
    guests: z.number(),
});

const updateProductInput = z.object({
    product: z.strictObject({ sku: z.string(), title: z.string().min(1) }),
    attributes: z.record(z.string(), z.object({ value: z.string(), unit: z.string().optional() })),
    dimensions: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
    tags: z.looseObject({ season: z.enum(['spring', 'summer', 'fall', 'winter']) }),
    category: categorySchema,
    price: z.intersection(z.object({ amount: z.number().min(0) }), z.object({ currency: z.enum(['USD']) })),
    discontinuedAt: z.iso.datetime().nullable(),
});

const updateProductOutput = z.object({
    product: z.object({ sku: z.string(), title: z.string() }),
    category: categorySchema,
    tags: z.looseObject({ season: z.string() }),
});

/** The stores a search finds, each carrying a field the output does not declare. */
export const STORES = [
    { name: 'Hudson Yards', borough: 'Manhattan' as const, leaseEnds: '2031-06-30' },
    { name: 'Atlantic Terminal', borough: 'Brooklyn' as const, leaseEnds: '2029-01-31' },
];

/**
 * The answer to an order, as a store builds it from its own rows: the
 * declared fields, and a cost per line and a note the output schema does not
 * declare, which the server's parse drops.
 */
export const orderAnswerOf = (payload: { items: readonly { sku: string; quantity: number }[]; delivery: 'pickup' | 'courier' }) => {
    const answer = {
        orderNumber: `NYC-${payload.items.length}`,
        status: payload.delivery === 'courier' ? 'held' as const : 'placed' as const,
        total: payload.items.reduce((sum, item) => sum + item.quantity * 12.5, 0),
        lines: payload.items.map((item) => ({ ...item, unitCost: 12.5 })),
        internalNote: 'checked by the night shift',
    };
    return answer;
};

/** The shop, built afresh; `nameMax` moves the order schema, which is how a test makes the generated file stale. */
export const createShopApp = (options: { nameMax?: number } = {}) => {
    const app = initLambder().create({ apiPath: '/api', apiVersion: '1' });
    const { defineApi } = app;
    return app.registerApiGroups(
        app.defineApiGroup('orders', {
            place: defineApi({ input: placeOrderInputOf(options.nameMax ?? 40), output: placeOrderOutput }, async (ctx) => orderAnswerOf(ctx.apiPayload)),
        }),
        app.defineApiGroup('stores', {
            search: defineApi({ input: searchInput, output: searchOutput }, async (ctx) => {
                const answer = { query: ctx.apiPayload.query, limit: ctx.apiPayload.limit, stores: STORES.slice(0, ctx.apiPayload.limit) };
                return answer;
            }),
        }),
        app.defineApiGroup('tickets', {
            open: defineApi({ input: openTicketInput, output: openTicketOutput }, async (ctx) => ({ ticketId: 'T-1', seat: ctx.apiPayload.seat, guests: ctx.apiPayload.guests })),
        }),
        app.defineApiGroup('catalog', {
            update: defineApi({ input: updateProductInput, output: updateProductOutput }, async (ctx) => {
                const answer = { product: ctx.apiPayload.product, category: ctx.apiPayload.category, tags: ctx.apiPayload.tags };
                return answer;
            }),
        }),
    );
};

export const shopApp = createShopApp();
export default shopApp;

export type ShopContract = typeof shopApp.ApiContract;
