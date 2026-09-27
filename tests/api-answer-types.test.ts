/**
 * Compile-time rules around an API answer and the options that shape one:
 * a handler answers with its declared output alone, the exported pipeline
 * binds its guards to its own context, and create() checks the files option
 * one level down. Each @ts-expect-error is the assertion; a directive the
 * compiler finds unused is a failure of the typecheck that runs before this
 * suite.
 */

import { testPublicFiles } from './helpers.js';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../src/core/Lambder.js';
import { refuse } from '../src/shared/wire/LambderApiRefusal.js';
import { LambderApiPipeline } from '../src/api/LambderApiPipeline.js';
import { lambderGuard } from '../src/core/LambderPolicyBuilders.js';
import type { LambderApiCallContext } from '../src/api/LambderApiCallContext.js';

describe('An API handler answers with its output or refuses', () => {
    it('takes the declared output, refuses null where the output is not nullable, and has no response builder to write a reason on', () => {
        const schema = { input: z.object({}), output: z.object({ id: z.string() }) };
        const lambder = initLambder<{ userId: string }>().create({ files: testPublicFiles(), apiPath: '/api' })
            // @ts-expect-error null is not the declared output; a reason for not answering is a refusal
            .addApi('bare', schema, async (_ctx) => null)
            // @ts-expect-error the handler has no response builder: refuse() is the one way to say no
            .addApi('built', schema, async (_ctx, res) => res.api(null, { notAuthorized: true }))
            .addApi('refused', schema, async (_ctx) => refuse('No.', { notAuthorized: true }))
            .addApi('answered', schema, async (_ctx) => ({ id: '1' }))
            .addApi('nullable', { input: z.object({}), output: z.object({ id: z.string() }).nullable() }, async (_ctx) => null);
        expect(lambder).toBeDefined();
    });
});

describe('A returned answer keeps its literals', () => {
    it('checks a literal field against the output from every branch, arrays included, and refuses one outside it', () => {
        const output = z.object({ status: z.enum(['open', 'closed']), reason: z.enum(['sold-out', 'too-late']).nullable(), aisles: z.array(z.string()) });
        const lambder = initLambder().create({ files: testPublicFiles(), apiPath: '/api' })
            .addApi('store.status', { input: z.object({ hour: z.number() }), output }, async (ctx) => {
                if(ctx.apiPayload.hour < 9) return { status: 'closed', reason: 'too-late', aisles: [] };
                return { status: 'open', reason: null, aisles: ['produce', 'bakery'] };
            })
            .addApi('store.statusSync', { input: z.object({ hour: z.number() }), output }, (ctx) => ({ status: ctx.apiPayload.hour < 9 ? 'closed' : 'open', reason: null, aisles: ['deli'] }))
            // @ts-expect-error a status the output does not declare
            .addApi('store.statusWrong', { input: z.object({}), output }, async (_ctx) => ({ status: 'ajar', reason: null, aisles: [] }));
        expect(lambder).toBeDefined();
    });
});

describe('The exported pipeline binds its guards to its own context', () => {
    it('refuses a guard whose handler reads a context the pipeline does not run on', () => {
        // The same rule as the rate-limit binding: a guard built for the
        // server would read ctx.ip as undefined on a bare context, and then
        // refuse or authorize everything.
        type BareContext = LambderApiCallContext<{ role: string }>;
        new LambderApiPipeline<BareContext, { role: string }>({
            // @ts-expect-error the guard wants the server's render context, which this pipeline does not run on
            guards: { fromServer: lambderGuard({ handler: (ctx) => ctx.ip }) },
        });
        expect(() => new LambderApiPipeline<BareContext, { role: string }>({
            guards: { own: { handler: (ctx: BareContext) => ctx.guardData } },
        })).not.toThrow();
    });
});

describe('create() checks the files option one level down', () => {
    it('refuses a misspelled memoryCache on the object form, and takes the real shape', () => {
        // @ts-expect-error memoryCach is not a files option
        initLambder().create({ files: { source: testPublicFiles(), memoryCach: false }, apiPath: '/api' });
        expect(() => initLambder().create({ files: { source: testPublicFiles(), memoryCache: false }, apiPath: '/api' })).not.toThrow();
        expect(() => initLambder().create({ files: testPublicFiles(), apiPath: '/api' })).not.toThrow();
    });
});
