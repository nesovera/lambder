/**
 * The API contract an app's registered groups expose as `typeof lambder.ApiContract`:
 * what each entry carries (input, output, guardInputs, guards), and what a
 * client may hold the server to with `satisfies`. Most of the value here is
 * type-level, so `npm run typecheck` (tsconfig.tests.json) is what makes the
 * @ts-expect-error lines and expectTypeOf assertions bite; the runtime
 * expectations pin the declarations to what the engine actually runs.
 */

import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import Lambder, { initLambder } from '../../src/core/Lambder.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import { lambderGuard } from '../../src/core/LambderPolicyBuilders.js';
import LambderCaller from '../../src/client/LambderCaller.js';
import type { LambderApiContractShape, LambderContractKeysWithGuard, LambderJsonOf } from '../../src/shared/wire/LambderApiContract.js';
import { createApiEvent, createMockContext, testPublicFiles } from '../helpers.js';

type Permission = 'USERS.MANAGE' | 'USERS.VIEW' | 'BILLING.MANAGE';

/** The guard map the app-shaped instances below declare from. */
const guards = {
    /** Parameterized: the API names the permission it needs. */
    orgPermission: lambderGuard({
        handler: async (_ctx, _payload, permission: Permission) => ({ permission }),
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
    /** An apiInput slice over a field an API transforms: declared in the form a client posts. */
    lowercaseOrg: lambderGuard({ apiInput: z.object({ org: z.string() }), handler: async () => {} }),
} as const;

const createApp = () => initLambder<{ userId: string }>().create({
    files: testPublicFiles(),
    apiPath: '/api',
    session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
    guards,
});

const testSchema = { input: z.object({ value: z.string() }), output: z.object({ result: z.string() }) };

describe('ApiContract - the guards option on the contract', () => {
    it('carries the declared guards option verbatim, in each of its three forms', () => {
        const created = createApp();
        const app = created.registerApiGroups(created.defineApiGroup('test', {
            single: created.defineApi({ ...testSchema, guards: 'notBanned' }, async (_ctx) => ({ result: 'ok' })),
            list: created.defineApi({ ...testSchema, guards: ['notBanned', 'captcha'] }, async (_ctx) => ({ result: 'ok' })),
            map: created.defineApi({ ...testSchema, guards: { orgPermission: 'USERS.MANAGE' } }, async (_ctx) => ({ result: 'ok' })),
        }));

        type Contract = typeof app.ApiContract;

        // The literal survives: not widened to string, string[] or Permission.
        expectTypeOf<Contract['test.single']['guards']>().toEqualTypeOf<'notBanned'>();
        expectTypeOf<Contract['test.list']['guards']>().toEqualTypeOf<readonly ['notBanned', 'captcha']>();
        expectTypeOf<Contract['test.map']['guards']>().toEqualTypeOf<{ readonly orgPermission: 'USERS.MANAGE' }>();

        // Input and output stay where they were.
        expectTypeOf<Contract['test.single']['input']>().toEqualTypeOf<{ value: string }>();
        expectTypeOf<Contract['test.single']['output']>().toEqualTypeOf<{ result: string }>();

        // The field exists for `typeof` only: it is declared, never assigned.
        expect(app.ApiContract).toBeUndefined();
    });

    it('lists the endpoints that declare one guard, in any of the three forms, beside other guards or alone', () => {
        const app = createApp();
        const _app = app.registerApiGroups(app.defineApiGroup('test', {
            single: app.defineApi({ ...testSchema, guards: 'notBanned' }, async (_ctx) => ({ result: 'ok' })),
            list: app.defineApi({ ...testSchema, guards: ['notBanned', 'captcha'] }, async (_ctx) => ({ result: 'ok' })),
            map: app.defineApi({ ...testSchema, guards: { orgPermission: 'USERS.MANAGE' } }, async (_ctx) => ({ result: 'ok' })),
            open: app.defineApi(testSchema, async (_ctx) => ({ result: 'ok' })),
        }));

        type Contract = typeof _app.ApiContract;

        expectTypeOf<LambderContractKeysWithGuard<Contract, 'notBanned'>>().toEqualTypeOf<'test.single' | 'test.list'>();
        expectTypeOf<LambderContractKeysWithGuard<Contract, 'captcha'>>().toEqualTypeOf<'test.list'>();
        expectTypeOf<LambderContractKeysWithGuard<Contract, 'orgPermission'>>().toEqualTypeOf<'test.map'>();
        expectTypeOf<LambderContractKeysWithGuard<Contract, 'sessionOnly'>>().toEqualTypeOf<never>();

        // A list held to exactly those endpoints, checked in both directions.
        const _NOT_BANNED_APIS = ['test.single', 'test.list'] as const satisfies readonly LambderContractKeysWithGuard<Contract, 'notBanned'>[];
        expectTypeOf<Exclude<LambderContractKeysWithGuard<Contract, 'notBanned'>, (typeof _NOT_BANNED_APIS)[number]>>().toEqualTypeOf<never>();
        // @ts-expect-error 'test.map' does not declare notBanned
        const _wrong = ['test.map'] as const satisfies readonly LambderContractKeysWithGuard<Contract, 'notBanned'>[];
    });

    it('records what a client sends (the input form) and what it receives (the JSON form), and hands the handler the parsed forms', () => {
        const app = createApp();
        const _app = app.registerApiGroups(app.defineApiGroup('test', {
            typed: app.defineApi({
                input: z.object({ page: z.number().default(1), id: z.string().transform(Number) }),
                output: z.object({ at: z.date(), total: z.number(), tags: z.array(z.string()), note: z.string().optional() }),
            }, async (ctx) => {
                // The handler's side: parsed input, and the output as authored.
                expectTypeOf(ctx.apiPayload).toEqualTypeOf<{ page: number; id: number }>();
                return { at: new Date(), total: ctx.apiPayload.id, tags: [] };
            }),
            scoped: app.defineApi({
                // Parsed, `org` is a number; posted, it is the string the guard reads.
                input: z.object({ org: z.string().transform((value) => value.length), body: z.string() }),
                output: z.object({}),
                guards: 'lowercaseOrg',
            }, async (_ctx) => ({})),
        }));

        type Contract = typeof _app.ApiContract;

        // A defaulted field is optional to send, and a transform's source is what is posted.
        expectTypeOf<Contract['test.typed']['input']>().toEqualTypeOf<{ page?: number | undefined; id: string }>();
        // A Date arrives as its string; nothing else changes.
        expectTypeOf<Contract['test.typed']['output']>().toEqualTypeOf<{ at: string; total: number; tags: string[]; note?: string | undefined }>();
        // A guard whose apiInput slice is a transformed field can be declared:
        // the slice is compared in the form a client posts, not the parsed one.
        expectTypeOf<Contract['test.scoped']['guards']>().toEqualTypeOf<'lowercaseOrg'>();
    });

    it('keeps unknown, records and recursive JSON as they are, and writes an array\'s undefined as null', () => {
        const app = createApp();
        const _app = app.registerApiGroups(app.defineApiGroup('test', {
            loose: app.defineApi({
                input: z.object({}),
                output: z.object({ data: z.unknown(), meta: z.record(z.string(), z.unknown()), doc: z.json(), cells: z.array(z.string().optional()) }),
            }, async (_ctx) => ({ data: 1, meta: {}, doc: null, cells: [] })),
            // @ts-expect-error an unknown output may be anything, and an API answers with an object or an array
            anything: app.defineApi({ input: z.object({}), output: z.unknown() }, async (_ctx) => 1),
        }));

        type Contract = typeof _app.ApiContract;
        type Loose = Contract['test.loose']['output'];
        expectTypeOf<Loose['data']>().toEqualTypeOf<unknown>();
        expectTypeOf<Loose['meta']>().toEqualTypeOf<Record<string, unknown>>();
        expectTypeOf<Loose['cells']>().toEqualTypeOf<(string | null)[]>();
        expectTypeOf<Contract['test.anything']['output']>().toEqualTypeOf<unknown>();

        // A typed call over the recursive z.json() type resolves.
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false });
        const read = async () => (await caller.api('test.loose', {}))?.doc;
        expectTypeOf(read).returns.resolves.not.toBeNever();
    });

    it('makes a key whose value may be undefined optional, as JSON leaves it out, and writes a Map or a Set as an empty object', async () => {
        const created = createApp();
        const app = created.registerApiGroups(created.defineApiGroup('test', {
            profile: created.defineApi({
                input: z.object({}),
                output: z.object({
                    name: z.string(),
                    bio: z.string().optional().transform((text) => text?.trim()),
                    nickname: z.string().nullable().transform((nick) => nick ?? undefined),
                    visits: z.map(z.string(), z.number()),
                    tags: z.set(z.string()),
                }),
            }, async (_ctx) => ({ name: 'Ada', nickname: null, visits: new Map([['home', 2]]), tags: new Set(['a']) })),
        }));

        type Contract = typeof app.ApiContract;
        expectTypeOf<Contract['test.profile']['output']>().toEqualTypeOf<{ name: string; bio?: string; nickname?: string; visits: {}; tags: {} }>();

        // What the type says is what the wire carries.
        const response = await app.render(createApiEvent({ apiName: 'test.profile', payload: {} }), createMockContext());
        expect(JSON.parse(response.body || '{}').payload).toEqual({ name: 'Ada', visits: {}, tags: {} });
    });

    it('pins the rest of the JSON mapping: dates, array holes, tuples, records, brands, discriminated unions and z.json()', () => {
        expectTypeOf<LambderJsonOf<{ at: Date; closedAt: Date | null }>>().toEqualTypeOf<{ at: string; closedAt: string | null }>();
        expectTypeOf<LambderJsonOf<(string | undefined)[]>>().toEqualTypeOf<(string | null)[]>();
        expectTypeOf<LambderJsonOf<[string, Date, undefined]>>().toEqualTypeOf<[string, string, null]>();
        expectTypeOf<LambderJsonOf<Record<string, Date>>>().toEqualTypeOf<Record<string, string>>();
        // A record's undefined entries are left out, which its value type says.
        expectTypeOf<LambderJsonOf<Record<string, Date | undefined>>>().toEqualTypeOf<Record<string, string>>();
        const _userIdSchema = z.string().brand<'UserId'>();
        type UserId = z.output<typeof _userIdSchema>;
        expectTypeOf<LambderJsonOf<{ id: UserId }>>().toEqualTypeOf<{ id: UserId }>();
        expectTypeOf<LambderJsonOf<{ kind: 'card'; at: Date } | { kind: 'cash'; cents: number }>>()
            .toEqualTypeOf<{ kind: 'card'; at: string } | { kind: 'cash'; cents: number }>();
        const _documentSchema = z.json();
        type JsonDocument = z.output<typeof _documentSchema>;
        const _doc: LambderJsonOf<JsonDocument> = { nested: [1, 'two', null, { deeper: true }] } satisfies JsonDocument;
        const _back: JsonDocument = _doc;
    });

    it('an API that declares no guards has no guards entry at all', () => {
        const app = createApp();
        const _app = app.registerApiGroups(app.defineApiGroup('test', {
            open: app.defineApi(testSchema, async (_ctx) => ({ result: 'ok' })),
        }));

        type Contract = typeof _app.ApiContract;

        expectTypeOf<Contract['test.open']>().not.toHaveProperty('guards');
        expectTypeOf<Contract['test.open']>().not.toHaveProperty('guardInputs');
        // @ts-expect-error an unguarded API has nothing to read here
        type _NoGuards = Contract['test.open']['guards'];
    });

    it('a guardInput-mode guard lands on both guardInputs and guards', () => {
        const app = createApp();
        const _app = app.registerApiGroups(app.defineApiGroup('test', {
            contact: app.defineApi({ ...testSchema, guards: { captcha: true, orgPermission: 'BILLING.MANAGE' } },
                async (_ctx) => ({ result: 'ok' })),
        }));

        type Entry = (typeof _app.ApiContract)['test.contact'];

        // What the client must send stays the guard's own input shape...
        expectTypeOf<Entry['guardInputs']>().toEqualTypeOf<{ captcha: { token: string } }>();
        // ...and what the API declared stays readable beside it.
        expectTypeOf<Entry['guards']>().toEqualTypeOf<{ readonly captcha: true, readonly orgPermission: 'BILLING.MANAGE' }>();
    });

    it('session APIs carry their guards too, including on a requireApiGuards instance', () => {
        const app = initLambder<{ userId: string }>().create({
            files: testPublicFiles(),
            apiPath: '/api',
            session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
            guards,
            requireApiGuards: true,
        });
        const _app = app.registerApiGroups(
            app.defineApiGroup('account', {
                me: app.defineApi({ ...testSchema, guards: 'sessionOnly' }, async (_ctx) => ({ result: 'ok' })),
            }),
            app.defineApiGroup('users', {
                list: app.defineApi({ ...testSchema, guards: { sessionOnly: true, orgPermission: 'USERS.VIEW' } }, async (_ctx) => ({ result: 'ok' })),
            }),
        );

        type Contract = typeof _app.ApiContract;

        expectTypeOf<Contract['account.me']['guards']>().toEqualTypeOf<'sessionOnly'>();
        expectTypeOf<Contract['users.list']['guards']>().toEqualTypeOf<{ readonly sessionOnly: true; readonly orgPermission: 'USERS.VIEW' }>();
        // The session guard is what makes each a session API.
        expectTypeOf<Contract['account.me']['mode']>().toEqualTypeOf<'session'>();
        expectTypeOf<Contract['users.list']['mode']>().toEqualTypeOf<'session'>();
    });

    it('a declaration names only the guards it declared: guardData and guardInputs do not widen to the whole map', () => {
        // The map form is a union over "this name required, the rest optional",
        // so a declaration could in principle be inferred as the CONSTRAINT
        // (every declarable name) rather than the literal. If it ever were,
        // ctx.guardData would claim guards that never ran and the contract
        // would demand guardInputs the call does not need, both silently.
        createApp().defineApi({ ...testSchema, guards: { orgPermission: 'USERS.VIEW' } }, async (ctx) => {
            expectTypeOf<typeof ctx.guardData>().toEqualTypeOf<{ orgPermission: { permission: Permission } }>();
            // captcha is declarable here and was not declared: it must not appear.
            expectTypeOf<typeof ctx.guardData>().not.toHaveProperty('captcha');
            return { result: ctx.guardData.orgPermission.permission };
        });

        const app = createApp();
        const _app = app.registerApiGroups(app.defineApiGroup('test', {
            narrowContract: app.defineApi({ ...testSchema, guards: { orgPermission: 'USERS.VIEW' } }, async (_ctx) => ({ result: 'ok' })),
        }));
        // No declared guardInput guard, so the contract asks the client for nothing.
        expectTypeOf<(typeof _app.ApiContract)['test.narrowContract']>().not.toHaveProperty('guardInputs');
    });

    it('guards survive a group built in another module, against the instance\'s types', () => {
        // What a module holding one group writes: a function over the
        // instance, typed by what create() configured on it.
        const usersGroup = (lambder: Lambder<ReturnType<typeof createApp>['AppTypes'], any>) =>
            lambder.defineApiGroup('users', {
                remove: lambder.defineApi({ ...testSchema, guards: { orgPermission: 'USERS.MANAGE' } },
                    async (_ctx) => ({ result: 'ok' })),
            });

        const app = createApp();
        const _app = app.registerApiGroups(usersGroup(app));
        type Contract = typeof _app.ApiContract;

        expectTypeOf<Contract['users.remove']['guards']>().toEqualTypeOf<{ readonly orgPermission: 'USERS.MANAGE' }>();
    });
});

describe('ApiContract - pinning a client-side needs map to the declarations', () => {
    const app = createApp();
    const _app = app.registerApiGroups(
        app.defineApiGroup('users', {
            list: app.defineApi({ ...testSchema, guards: { orgPermission: 'USERS.VIEW' } }, async (_ctx) => ({ result: 'ok' })),
            remove: app.defineApi({ ...testSchema, guards: { orgPermission: 'USERS.MANAGE' } }, async (_ctx) => ({ result: 'ok' })),
        }),
        app.defineApiGroup('billing', {
            pay: app.defineApi({ ...testSchema, guards: { orgPermission: 'BILLING.MANAGE', captcha: true } }, async (_ctx) => ({ result: 'ok' })),
        }),
        app.defineApiGroup('health', {
            ping: app.defineApi(testSchema, async (_ctx) => ({ result: 'ok' })),
        }),
    );

    type Contract = typeof _app.ApiContract;
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
            // @ts-expect-error 'health.ping' declares no orgPermission guard, so nothing satisfies never
            'health.ping': 'USERS.VIEW',
        } as const satisfies NeedsMap;

        expect(NEEDS['health.ping']).toBe('USERS.VIEW');
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

describe('ApiContract - a guards entry changes nothing for consumers', () => {
    const app = createApp();
    const _app = app.registerApiGroups(app.defineApiGroup('test', {
        open: app.defineApi(testSchema, async (_ctx) => ({ result: 'ok' })),
        guarded: app.defineApi({ ...testSchema, guards: { orgPermission: 'USERS.MANAGE' } }, async (_ctx) => ({ result: 'ok' })),
        captchaed: app.defineApi({ ...testSchema, guards: 'captcha' }, async (_ctx) => ({ result: 'ok' })),
    }));

    type Contract = typeof _app.ApiContract;

    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        fetchMock = vi.fn(async () => ({
            ok: true, status: 200, statusText: 'OK',
            text: async () => JSON.stringify({ apiVersion: '1', payload: { result: 'ok' } }),
        }));
        vi.stubGlobal('fetch', fetchMock);
        vi.stubGlobal('location', { hostname: 'localhost' });
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('the contract still satisfies LambderApiContractShape', () => {
        expectTypeOf<Contract>().toExtend<LambderApiContractShape>();
    });

    it('holds a hand-written contract to the real option shapes, so a typo in one is a compile error', () => {
        // With mode, guards, rateLimit and idempotency typed as `any`, a
        // hand-written contract (what a client holds, and what the mock
        // registry is checked against) could say mode: "sesion" and every
        // mode-dependent check would silently answer "either".
        type Typo = { 'test.thing': { input: { value: string }; output: null; mode: 'sesion' } };
        // @ts-expect-error "sesion" is not a mode; the modes are "public" and "session"
        expectTypeOf<Typo>().toExtend<LambderApiContractShape>();

        type Written = {
            'test.thing': { input: { value: string }; output: null; mode: 'session'; guards: readonly ['notBanned']; rateLimit: 'perIp'; idempotency: { ttlSeconds: 60 } };
        };
        expectTypeOf<Written>().toExtend<LambderApiContractShape>();
    });

    it('call options still follow guardInputs only: a guard with no client input adds no argument', async () => {
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false });

        // Declaring guards does not, by itself, make the options argument mandatory.
        await caller.api('test.open', { value: 'x' });
        await caller.api('test.guarded', { value: 'x' });
        // A guardInput-mode guard still does.
        await caller.api('test.captchaed', { value: 'x' }, { guardInputs: { captcha: { token: 'abc' } } });
        // @ts-expect-error the captcha token cannot be omitted
        await caller.api('test.captchaed', { value: 'x' }).catch(() => {});

        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('the guards declaration is type-only: nothing about it reaches the wire', async () => {
        const caller = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false });

        await caller.api('test.guarded', { value: 'x' });
        const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as any).body as string);

        // The name is where the call goes, and the body carries the payload.
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/test/guarded');
        expect('apiName' in body).toBe(false);
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
        const created = initLambder().create({
            files: testPublicFiles(),
            apiPath: '/api',
            guards: {
                orgPermission: lambderGuard({
                    handler: async (_ctx, _payload, permission: Permission) => { sawPermission = permission; },
                }),
            },
        });
        const app = created.registerApiGroups(created.defineApiGroup('users', {
            remove: created.defineApi({ ...testSchema, guards: { orgPermission: 'USERS.MANAGE' } },
                async (_ctx) => ({ result: 'removed' })),
        }));

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

describe('ApiContract - the shape every consumer is checked against', () => {
    const app = createApp();
    const _app = app.registerApiGroups(
        app.defineApiGroup('test', {
            open: app.defineApi(testSchema, async (_ctx) => ({ result: 'ok' })),
            guarded: app.defineApi({ ...testSchema, guards: { orgPermission: 'USERS.MANAGE' } }, async (_ctx) => ({ result: 'ok' })),
        }),
        app.defineApiGroup('account', {
            member: app.defineApi({ ...testSchema, guards: 'sessionOnly' }, async (_ctx) => ({ result: 'ok' })),
        }),
    );

    type Contract = typeof _app.ApiContract;

    it('keeps an undeclared option absent rather than optional-undefined', () => {
        // Every `[X] extends [never]` branch in the mock and the caller keys
        // on absence, so an entry that carried the key would change what the
        // contract means.
        expectTypeOf<Contract['test.open']>().not.toHaveProperty('guards');
        expectTypeOf<Contract['test.open']>().not.toHaveProperty('rateLimit');
        expectTypeOf<Contract['test.guarded']['guards']>().toEqualTypeOf<{ readonly orgPermission: 'USERS.MANAGE' }>();
    });

    it('satisfies the contract-shape constraint as inferred, and as a type alias written out member by member', () => {
        // writeApiContract prints the contract as a type alias of an object
        // type for this reason: an interface gets no implicit index signature,
        // so one written out member by member is NOT assignable to
        // LambderApiContractShape (Record<string, ...>) and initLambderMock<C>,
        // LambderCaller<C> and LambderInvokeCaller<C> would reject it.
        type Assert<T extends true> = T;
        type _Accepted = Assert<Contract extends LambderApiContractShape ? true : false>;
        const holdsAsTypeArgument = new LambderCaller<Contract>({ apiPath: '/api', isCorsEnabled: false });
        expect(holdsAsTypeArgument).toBeInstanceOf(LambderCaller);

        interface HandWritten { 'a.b': { input: { v: string }; output: { r: string } } }
        // @ts-expect-error an interface that extends nothing has no inferable index signature
        type _Rejected = Assert<HandWritten extends LambderApiContractShape ? true : false>;
        type _AliasAccepted = Assert<{ 'a.b': { input: { v: string }; output: { r: string } } } extends LambderApiContractShape ? true : false>;
    });
});
