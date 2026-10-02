/**
 * Other modules writeApiSchemas reads, each under its own export: the shop
 * with one schema moved, a source holding what JSON Schema cannot represent,
 * and one holding every kind of schema the file carries only in part.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createShopApp } from './shop.js';

/** The shop with a customer's name allowed longer: its order schema moved, every other one as it was. */
export const widerNames = createShopApp({ nameMax: 60 });

/** A receipt whose output holds a Date, which JSON Schema cannot represent and which is neither a refinement nor a transform. */
export const datedReceipts = {
    apiSchemaEntries: () => ({
        'receipts.get': { input: z.object({ receiptId: z.string() }), output: z.object({ total: z.number(), issuedAt: z.date() }) },
    }),
};

/** Every kind of schema the file carries only in part, one field each, in both directions. */
export const partlyCarried = {
    apiSchemaEntries: () => ({
        'tickets.book': {
            input: z.object({
                refined: z.string().refine((value) => value !== 'sold out'),
                checked: z.object({ row: z.string() }).superRefine(() => {}),
                custom: z.custom<string>((value) => typeof value === 'string'),
                transformed: z.string().transform((value) => value.length),
                preprocessed: z.preprocess((value) => String(value), z.string()),
                piped: z.string().pipe(z.string().min(2)),
                coded: z.codec(z.string(), z.number(), { decode: Number, encode: String }),
                trimmed: z.string().trim(),
                coerced: z.coerce.number(),
                coercedDate: z.coerce.date(),
                caught: z.string().catch('general admission'),
                computedId: z.string().default(() => randomUUID()),
                emptyList: z.array(z.string()).default(() => []),
            }),
            output: z.object({
                refined: z.string().refine((value) => value !== 'sold out'),
                transformed: z.string().transform((value) => value.toUpperCase()),
                piped: z.string().pipe(z.string().min(2)),
                trimmed: z.string().trim(),
                coerced: z.coerce.number(),
                caught: z.string().catch('general admission'),
            }),
        },
    }),
};

/** Strings whose checks zod writes in a form the mock would read back as another: regex flags, a URL's rules, a guid, an email under its own pattern, an emoji, two patterns at once. */
export const stringChecks = {
    apiSchemaEntries: () => ({
        'stores.register': {
            input: z.object({
                code: z.string().regex(/^[a-z]{3}$/i),
                name: z.string().regex(/^\p{L}+$/u),
                sku: z.string().regex(/^[A-Z]/).regex(/\d$/),
                website: z.httpUrl(),
                receiptId: z.guid(),
                contact: z.email({ pattern: z.regexes.unicodeEmail }),
                badge: z.emoji(),
            }),
            output: z.object({ storeId: z.string() }),
        },
    }),
};
