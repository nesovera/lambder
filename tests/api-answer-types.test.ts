/**
 * Compile-time rules around an API answer and the options that shape one:
 * a null answer names a reason, the exported pipeline binds its guards to
 * its own context, and create() checks the files option one level down.
 * Each @ts-expect-error is the assertion; a directive the compiler finds
 * unused is a failure of the typecheck that runs before this suite.
 */

import { testPublicFiles } from './helpers.js';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../src/core/Lambder.js';
import { LambderApiPipeline } from '../src/api/LambderApiPipeline.js';
import { lambderGuard } from '../src/core/LambderPolicyBuilders.js';
import type { LambderApiCallContext } from '../src/api/LambderApiCallContext.js';

describe('A null API answer names a reason', () => {
    it('refuses res.api(null, {}) on an endpoint whose output is not nullable, and takes any reason', () => {
        const schema = { input: z.object({}), output: z.object({ id: z.string() }) };
        const lambder = initLambder<{ userId: string }>().create({ files: testPublicFiles(), apiPath: '/api' })
            // @ts-expect-error a null answer with no reason reaches the caller as a success whose payload is null
            .addApi('bare', schema, async (_ctx, res) => res.api(null, {}))
            // @ts-expect-error a logList alone is not a reason
            .addApi('logged', schema, async (_ctx, res) => res.api(null, { logList: ['why'] }))
            .addApi('refused', schema, async (_ctx, res) => res.api(null, { notAuthorized: true }))
            .addApi('explained', schema, async (_ctx, res) => res.api(null, { errorMessage: { type: 'warning', content: 'no' }, logList: [] }))
            .addApi('binary', schema, async (_ctx, res) => res.apiBinary(null, { sessionExpired: true }))
            .addApi('answered', schema, async (_ctx, res) => res.api({ id: '1' }));
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
