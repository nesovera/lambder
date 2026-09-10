/**
 * The API contract a chained app exposes as `typeof lambder.ApiContract`:
 * what each entry carries (input, output, guardInputs, guards), and what a
 * client may hold the server to with `satisfies`. Most of the value here is
 * type-level, so `npm run typecheck` (tsconfig.tests.json) is what makes the
 * @ts-expect-error lines and expectTypeOf assertions bite; the runtime
 * expectations pin the declarations to what the engine actually runs.
 */

import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import Lambder, { initLambder } from '../src/core/Lambder.js';
import { LambderLocalFileSource } from '../src/core/LambderFiles.js';
import { lambderGuard } from '../src/policies/LambderApiGuards.js';
import type { LambderGuardMetaMap } from '../src/policies/LambderApiGuards.js';
import LambderCaller from '../src/client/LambderCaller.js';
import type { ApiContractShape } from '../src/shared/LambderApiContract.js';
import { createApiEvent, createMockContext } from './helpers.js';

type Permission = 'USERS.MANAGE' | 'USERS.VIEW' | 'BILLING.MANAGE';

/** The guard map the app-shaped instances below declare from. */
const guards = {
    /** Parameterized: the API names the permission it needs. */
    orgPermission: lambderGuard({
        handler: async (_ctx, _payload, _res, permission: Permission) => ({ permission }),
    }),
    /** guardInput mode: the value travels beside the payload, in options.guardInputs. */
    captcha: lambderGuard({
        guardInput: z.object({ token: z.string().min(3) }),
        handler: async () => {},
    }),
    /** Check-only, paramless. */
    notBanned: lambderGuard({ handler: async () => {} }),
    /** Session-only no-op: the session itself is the whole authorization. */
    sessionOnly: lambderGuard({ session: true, handler: async () => {} }),
} as const;

const createApp = () => initLambder<{ userId: string }>().create({
    files: new LambderLocalFileSource({ root: './public' }),
    apiPath: '/api',
    guards,
});

const testSchema = { input: z.object({ value: z.string() }), output: z.object({ result: z.string() }) };

describe('ApiContract - the guards option on the contract', () => {
    it('carries the declared guards option verbatim, in each of its three forms', () => {
        const app = createApp()
            .addApi('single', { ...testSchema, guards: 'notBanned' }, async (_ctx, res) => res.api({ result: 'ok' }))
            .addApi('list', { ...testSchema, guards: ['notBanned', 'captcha'] }, async (_ctx, res) => res.api({ result: 'ok' }))
            .addApi('map', { ...testSchema, guards: { orgPermission: 'USERS.MANAGE' } }, async (_ctx, res) => res.api({ result: 'ok' }));

        type Contract = typeof app.ApiContract;

        // The literal survives: not widened to string, string[] or Permission.
        expectTypeOf<Contract['single']['guards']>().toEqualTypeOf<'notBanned'>();
        expectTypeOf<Contract['list']['guards']>().toEqualTypeOf<readonly ['notBanned', 'captcha']>();
        expectTypeOf<Contract['map']['guards']>().toEqualTypeOf<{ readonly orgPermission: 'USERS.MANAGE' }>();

        // Input and output stay where they were.
        expectTypeOf<Contract['single']['input']>().toEqualTypeOf<{ value: string }>();
        expectTypeOf<Contract['single']['output']>().toEqualTypeOf<{ result: string }>();

        // The field exists for `typeof` only: it is declared, never assigned.
        expect(app.ApiContract).toBeUndefined();
    });

    it('an API that declares no guards has no guards entry at all', () => {
        const app = createApp()
            .addApi('open', testSchema, async (_ctx, res) => res.api({ result: 'ok' }));

        type Contract = typeof app.ApiContract;

        expectTypeOf<Contract['open']>().not.toHaveProperty('guards');
        expectTypeOf<Contract['open']>().not.toHaveProperty('guardInputs');
        // @ts-expect-error an unguarded API has nothing to read here
        type _NoGuards = Contract['open']['guards'];
    });

    it('a guardInput-mode guard lands on both guardInputs and guards', () => {
        const app = createApp()
            .addApi('contact', { ...testSchema, guards: { captcha: true, orgPermission: 'BILLING.MANAGE' } },
                async (_ctx, res) => res.api({ result: 'ok' }));

        type Entry = (typeof app.ApiContract)['contact'];

        // What the client must send stays the guard's own input shape...
        expectTypeOf<Entry['guardInputs']>().toEqualTypeOf<{ captcha: { token: string } }>();
        // ...and what the API declared stays readable beside it.
        expectTypeOf<Entry['guards']>().toEqualTypeOf<{ readonly captcha: true, readonly orgPermission: 'BILLING.MANAGE' }>();
    });

    it('session APIs carry their guards too, including on a requireSessionApiGuards instance', () => {
        const app = initLambder<{ userId: string }>().create({
            files: new LambderLocalFileSource({ root: './public' }),
            apiPath: '/api',
            guards,
            requireSessionApiGuards: true,
        })
            .addSessionApi('me', { ...testSchema, guards: 'sessionOnly' }, async (_ctx, res) => res.api({ result: 'ok' }))
            .addSessionApi('users.list', { ...testSchema, guards: { orgPermission: 'USERS.VIEW' } }, async (_ctx, res) => res.api({ result: 'ok' }));

        type Contract = typeof app.ApiContract;

        expectTypeOf<Contract['me']['guards']>().toEqualTypeOf<'sessionOnly'>();
        expectTypeOf<Contract['users.list']['guards']>().toEqualTypeOf<{ readonly orgPermission: 'USERS.VIEW' }>();
    });

    it('a declaration names only the guards it declared: guardData and guardInputs do not widen to the whole map', () => {
        // The map form is a union over "this name required, the rest optional",
        // so a declaration could in principle be inferred as the CONSTRAINT
        // (every declarable name) rather than the literal. If it ever were,
        // ctx.guardData would claim guards that never ran and the contract
        // would demand guardInputs the call does not need, both silently.
        createApp().addApi('narrow', { ...testSchema, guards: { orgPermission: 'USERS.VIEW' } }, async (ctx, res) => {
            expectTypeOf<typeof ctx.guardData>().toEqualTypeOf<{ orgPermission: { permission: Permission } }>();
            // captcha is declarable here and was not declared: it must not appear.
            expectTypeOf<typeof ctx.guardData>().not.toHaveProperty('captcha');
            return res.api({ result: ctx.guardData.orgPermission.permission });
        });

        const app = createApp()
            .addApi('narrowContract', { ...testSchema, guards: { orgPermission: 'USERS.VIEW' } }, async (_ctx, res) => res.api({ result: 'ok' }));
        // No declared guardInput guard, so the contract asks the client for nothing.
        expectTypeOf<(typeof app.ApiContract)['narrowContract']>().not.toHaveProperty('guardInputs');
    });

    it('guards survive plugin composition through .use()', () => {
        const usersPlugin = <T>(lambder: Lambder<T, {}, any, LambderGuardMetaMap<typeof guards>, any, any>) =>
            lambder.addApi('users.remove', { ...testSchema, guards: { orgPermission: 'USERS.MANAGE' } },
                async (_ctx, res) => res.api({ result: 'ok' }));

        const app = createApp().use(usersPlugin);
        type Contract = typeof app.ApiContract;

        expectTypeOf<Contract['users.remove']['guards']>().toEqualTypeOf<{ readonly orgPermission: 'USERS.MANAGE' }>();
    });
});

describe('ApiContract - pinning a client-side needs map to the declarations', () => {
    const app = createApp()
        .addApi('users.list', { ...testSchema, guards: { orgPermission: 'USERS.VIEW' } }, async (_ctx, res) => res.api({ result: 'ok' }))
        .addApi('users.remove', { ...testSchema, guards: { orgPermission: 'USERS.MANAGE' } }, async (_ctx, res) => res.api({ result: 'ok' }))
        .addApi('billing.pay', { ...testSchema, guards: { orgPermission: 'BILLING.MANAGE', captcha: true } }, async (_ctx, res) => res.api({ result: 'ok' }))
        .addApi('ping', testSchema, async (_ctx, res) => res.api({ result: 'ok' }));

    type Contract = typeof app.ApiContract;
    /** What the server itself says the API needs; never for an API that declares no such guard. */
    type PermissionNeededBy<K extends keyof Contract> =
        Contract[K] extends { guards: { orgPermission: infer N } } ? N : never;
    /** The client's own map of "what does this API need", pinned to the declarations above. */
    type NeedsMap = { [K in keyof Contract]?: PermissionNeededBy<K> };

    it('a needs map that agrees with the server compiles and stays a plain value', () => {
        const NEEDS = {
            'users.list': 'USERS.VIEW',
            'users.remove': 'USERS.MANAGE',
            'billing.pay': 'BILLING.MANAGE',
        } as const satisfies NeedsMap;

        expect(NEEDS['users.remove']).toBe('USERS.MANAGE');
        expectTypeOf<(typeof NEEDS)['users.remove']>().toEqualTypeOf<'USERS.MANAGE'>();
    });

    it('a needs map that disagrees with the server does not compile', () => {
        const NEEDS = {
            'users.list': 'USERS.VIEW',
            // @ts-expect-error the server declares USERS.MANAGE for this API
            'users.remove': 'USERS.VIEW',
        } as const satisfies NeedsMap;

        expect(NEEDS['users.remove']).toBe('USERS.VIEW');
    });

    it('an API that declares no such guard cannot be claimed to need one', () => {
        const NEEDS = {
            // @ts-expect-error 'ping' declares no orgPermission guard, so nothing satisfies never
            ping: 'USERS.VIEW',
        } as const satisfies NeedsMap;

        expect(NEEDS.ping).toBe('USERS.VIEW');
    });

    it('an API name the server never registered does not compile', () => {
        const NEEDS = { 'users.destroy': 'USERS.MANAGE' } as const;
        // @ts-expect-error no API by this name is registered
        const _pinned: NeedsMap = NEEDS;

        expect(NEEDS['users.destroy']).toBe('USERS.MANAGE');
    });

    it('an exhaustive map has to grow when a guarded API is added', () => {
        type GuardedApis = {
            [K in keyof Contract]: Contract[K] extends { guards: { orgPermission: any } } ? K : never
        }[keyof Contract];
        type ExhaustiveNeeds = { [K in GuardedApis]: PermissionNeededBy<K> };

        const NEEDS = {
            'users.list': 'USERS.VIEW',
            'users.remove': 'USERS.MANAGE',
            'billing.pay': 'BILLING.MANAGE',
        } as const satisfies ExhaustiveNeeds;

        const INCOMPLETE = {
            'users.list': 'USERS.VIEW',
            'users.remove': 'USERS.MANAGE',
        } as const;
        // @ts-expect-error billing.pay is guarded and missing from the map
        const _pinned: ExhaustiveNeeds = INCOMPLETE;

        expect(Object.keys(NEEDS)).toHaveLength(3);
        expect(Object.keys(INCOMPLETE)).toHaveLength(2);
        // The unguarded API never enters the exhaustive list.
        expectTypeOf<GuardedApis>().toEqualTypeOf<'users.list' | 'users.remove' | 'billing.pay'>();
    });
});

describe('ApiContract - the added guards entry changes nothing for consumers', () => {
    const app = createApp()
        .addApi('open', testSchema, async (_ctx, res) => res.api({ result: 'ok' }))
        .addApi('guarded', { ...testSchema, guards: { orgPermission: 'USERS.MANAGE' } }, async (_ctx, res) => res.api({ result: 'ok' }))
        .addApi('captchaed', { ...testSchema, guards: 'captcha' }, async (_ctx, res) => res.api({ result: 'ok' }));

    type Contract = typeof app.ApiContract;

    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        fetchMock = vi.fn(async () => ({
            ok: true, status: 200, statusText: 'OK',
            text: async () => JSON.stringify({ apiVersion: '1', payload: { result: 'ok' } }),
        }));
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('the contract still satisfies ApiContractShape', () => {
        expectTypeOf<Contract>().toExtend<ApiContractShape>();
    });

    it('call options still follow guardInputs only: a guard with no client input adds no argument', async () => {
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false });

        // Declaring guards does not, by itself, make the options argument mandatory.
        await caller.api('open', { value: 'x' });
        await caller.api('guarded', { value: 'x' });
        // A guardInput-mode guard still does.
        await caller.api('captchaed', { value: 'x' }, { guardInputs: { captcha: { token: 'abc' } } });
        // @ts-expect-error the captcha token cannot be omitted
        void caller.api('captchaed', { value: 'x' }).catch(() => {});

        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('the guards declaration is type-only: nothing about it reaches the wire', async () => {
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false });

        await caller.api('guarded', { value: 'x' });
        const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as any).body as string);

        expect(body.apiName).toBe('guarded');
        expect(body.payload).toEqual({ value: 'x' });
        // The declaration lives on the type, not in the envelope: the client
        // sends nothing about it, and the server reads its own registration.
        expect('guards' in body).toBe(false);
        expect('guardInputs' in body).toBe(false);
    });
});

describe('ApiContract - the declaration is what runs', () => {
    it('the param the contract records is the param the guard receives', async () => {
        let sawPermission: Permission | null = null;
        const app = initLambder().create({
            files: new LambderLocalFileSource({ root: './public' }),
            apiPath: '/api',
            guards: {
                orgPermission: lambderGuard({
                    handler: async (_ctx, _payload, _res, permission: Permission) => { sawPermission = permission; },
                }),
            },
        })
            .addApi('users.remove', { ...testSchema, guards: { orgPermission: 'USERS.MANAGE' } },
                async (_ctx, res) => res.api({ result: 'removed' }));

        type Declared = (typeof app.ApiContract)['users.remove']['guards']['orgPermission'];
        expectTypeOf<Declared>().toEqualTypeOf<'USERS.MANAGE'>();

        const result = await app.render(
            createApiEvent({ apiName: 'users.remove', payload: { value: 'x' } }),
            createMockContext(),
        );

        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body || '{}').payload).toEqual({ result: 'removed' });
        // The literal on the contract and the value handed to the guard are the same declaration.
        expect(sawPermission).toBe('USERS.MANAGE' satisfies Declared);
    });
});
