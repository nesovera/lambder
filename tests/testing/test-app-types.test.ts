/**
 * What the compiler knows about a test app: the contract and the session data
 * type come off the instance, so a visitor's calls are typed the way the
 * app's own frontend caller is, and the two assertions narrow whichever
 * outcome union they are handed. `npm run typecheck` is what makes the
 * @ts-expect-error lines bite; the runtime assertions keep each case honest.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { lambderGuard } from '../../src/core/LambderPolicyBuilders.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import type { LambderApiOutcome } from '../../src/shared/wire/LambderApiOutcome.js';
import type { LambderInvokeOutcome } from '../../src/invoke/LambderInvokeOutcome.js';
import { lambderTestApp, assertApiSuccess, assertApiFailure, type LambderTestApp, type LambderTestVisitor } from '../../src/testing.js';

type SessionData = { userId: string; role: 'admin' | 'member' };

const lambderApp = initLambder<SessionData>().create({
    session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
    guards: {
        signedIn: lambderGuard({ session: true, handler: async () => {} }),
        tenant: lambderGuard({ guardInput: z.object({ tenantId: z.string() }), handler: (_ctx, input) => ({ tenantId: input.tenantId }) }),
    },
});
const server = lambderApp.registerApiGroups(
    lambderApp.defineApiGroup('test', {
        echo: lambderApp.defineApi({ input: z.object({ text: z.string() }), output: z.object({ text: z.string() }) }, async (ctx) => ({ text: ctx.apiPayload.text })),
        me: lambderApp.defineApi({ input: z.object({}), output: z.object({ userId: z.string() }), guards: 'signedIn' }, async (ctx) => ({ userId: ctx.session.data.userId })),
    }),
    lambderApp.defineApiGroup('tenant', {
        current: lambderApp.defineApi({ input: z.object({}), output: z.object({ tenantId: z.string() }), guards: 'tenant' }, async (ctx) => ({ tenantId: ctx.guardData.tenant.tenantId })),
    }),
);

/** The contract as writeApiContract prints it for a large app's clients and tests: plain members. */
type PrintedContract = {
    'test.echo': { input: { text: string }; output: { text: string }; mode: 'public' };
    'test.me': { input: Record<string, never>; output: { userId: string }; mode: 'session'; guards: 'signedIn' };
    'tenant.current': { input: Record<string, never>; output: { tenantId: string }; mode: 'public'; guards: 'tenant'; guardInputs: { tenant: { tenantId: string } } };
};

describe('lambderTestApp: what the instance types', () => {
    it('reads the contract and the session data off the instance', async () => {
        const app = lambderTestApp(server);
        expectTypeOf(app).toEqualTypeOf<LambderTestApp<typeof server.ApiContract, SessionData>>();

        const visitor = app.visitor();
        expectTypeOf(visitor).toEqualTypeOf<LambderTestVisitor<typeof server.ApiContract, SessionData, never>>();
        // The output alone: a failure throws rather than reading as undefined.
        expectTypeOf(await visitor.api('test.echo', { text: 'hi' })).toEqualTypeOf<{ text: string }>();
        expectTypeOf(await visitor.test.echo({ text: 'hi' })).toEqualTypeOf<{ text: string }>();
        expectTypeOf(await visitor.test.echo.outcome({ text: 'hi' })).toEqualTypeOf<Awaited<ReturnType<typeof visitor.caller.test.echo.outcome>>>();
        // The caller underneath is a LambderCaller as any frontend has one, undefined on a failure.
        expectTypeOf(await visitor.caller.api('test.echo', { text: 'hi' })).toEqualTypeOf<{ text: string } | undefined>();
        // @ts-expect-error not an action of this group
        await visitor.test.nope({}).catch(() => {});

        // @ts-expect-error not an API of this contract
        await visitor.apiOutcome('nope', {});
        // @ts-expect-error the payload is the endpoint's input
        await visitor.apiOutcome('test.echo', { text: 42 });
        // @ts-expect-error the session data is the app's
        await app.signIn('ada', { userId: 'ada', role: 'owner' }).catch(() => {});
        // @ts-expect-error a guardInput guard nobody provides is the call's to pass
        await visitor.apiOutcome('tenant.current', {});
        expect(await visitor.api('tenant.current', {}, { guardInputs: { tenant: { tenantId: 'acme' } } })).toEqual({ tenantId: 'acme' });
    });

    it('takes the contract generated for the app\'s clients by name, for an app large enough to have one', async () => {
        const app = lambderTestApp<SessionData, PrintedContract>(server);
        expectTypeOf(app).toEqualTypeOf<LambderTestApp<PrintedContract, SessionData>>();
        expect(await app.visitor().api('test.echo', { text: 'hi' })).toEqual({ text: 'hi' });
    });

    it('requires the provider once a visitor names provided guards, as LambderCaller does', async () => {
        const app = lambderTestApp(server);
        // @ts-expect-error guardInputsProvider is required once guards are named
        app.visitor<'tenant'>();
        // @ts-expect-error and so it is when the options leave it out
        app.visitor<'tenant'>({ host: 'app.test' });

        const visitor = app.visitor<'tenant'>({ guardInputsProvider: () => ({ tenant: { tenantId: 'acme' } }) });
        // A guard the provider covers needs no options argument.
        expect(await visitor.api('tenant.current', {})).toEqual({ tenantId: 'acme' });
        const signedIn = await app.signIn<'tenant'>('ada', { userId: 'ada', role: 'member' }, { guardInputsProvider: () => ({ tenant: { tenantId: 'acme' } }) });
        expect(await signedIn.api('tenant.current', {})).toEqual({ tenantId: 'acme' });
    });
});

describe('assertApiSuccess / assertApiFailure: what they narrow to', () => {
    const outcome = { ok: true, payload: { text: 'hi' }, response: { payload: { text: 'hi' } } } as unknown as LambderApiOutcome<{ text: string }>;
    const refused = { ok: false, reason: 'notAuthorized', response: { payload: null } } as unknown as LambderApiOutcome<{ text: string }>;
    const crashed = { ok: false, reason: 'server', error: new Error('boom') } as unknown as LambderApiOutcome<{ text: string }>;
    const invalid = { ok: false, reason: 'validation', zodError: { name: 'ZodError', message: 'm', issues: [] } } as unknown as LambderApiOutcome<{ text: string }>;

    it('narrows a success to its payload', () => {
        assertApiSuccess(outcome);
        expectTypeOf(outcome.payload).toEqualTypeOf<{ text: string }>();
    });

    it('narrows a named reason to the arm that carries it, including a reason several share one arm with', () => {
        assertApiFailure(invalid, 'validation');
        expectTypeOf(invalid.zodError.issues).toBeArray();

        assertApiFailure(crashed, 'server');
        expectTypeOf(crashed.reason).toEqualTypeOf<'server'>();
        expectTypeOf(crashed.error).toEqualTypeOf<Error>();

        assertApiFailure(refused, 'notAuthorized');
        expectTypeOf(refused.response.payload).toEqualTypeOf<null>();
    });

    it('narrows to the whole failure side when no reason is named', () => {
        const anyFailure = { ...refused } as LambderApiOutcome<{ text: string }>;
        assertApiFailure(anyFailure);
        expectTypeOf(anyFailure.ok).toEqualTypeOf<false>();
    });

    it('refuses a reason the union cannot carry, whichever caller\'s union it is', () => {
        const misspelled = { ...refused } as LambderApiOutcome<{ text: string }>;
        // @ts-expect-error not a LambderApiFailureReason
        expect(() => assertApiFailure(misspelled, 'notAuthorised')).toThrow();

        const invoked = { ok: false, reason: 'payloadTooLarge', error: new Error('x') } as unknown as LambderInvokeOutcome<{ text: string }>;
        // A reason only the invoke caller's union names.
        assertApiFailure(invoked, 'payloadTooLarge');
        expectTypeOf(invoked.reason).toEqualTypeOf<'payloadTooLarge'>();
    });
});
