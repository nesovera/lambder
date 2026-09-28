/**
 * lambder/build: the declared options as a generated module of plain data,
 * the instance method behind it, and what reads the module back: the typed
 * readers a client derives from, and the mock helper that puts a table's
 * key handlers back.
 *
 * Files are written under the system's temporary directory, never into the
 * repository.
 */

import { afterAll, describe, expect, expectTypeOf, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { lambderGuard, lambderRateLimitKey } from '../../src/core/LambderPolicyBuilders.js';
import { LambderMemoryRateLimiter } from '../../src/stores/LambderMemoryRateLimiter.js';
import { LambderMemoryIdempotencyStore } from '../../src/stores/LambderMemoryIdempotencyStore.js';
import { LambderMemorySessionStore } from '../../src/stores/LambderMemorySessionStore.js';
import { writeApiGuardParams, writeApiOptions } from '../../src/build.js';
import { readOptionTables, type LambderApiOptionsFileOptions } from '../../src/build/writeApiOptions.js';
import { readGeneratedTable, type LambderApiOptionsSource } from '../../src/build/generatedTables.js';
import { apiGuardParam, type LambderApiOptionEntries, type LambderApisGuardedBy, type LambderApisWithGuard, type LambderApisWithMode, type LambderGuardParamOf } from '../../src/shared/wire/LambderApiOptionEntries.js';
import { initLambderMock } from '../../src/mock/LambderMockApp.js';
import { lambderMockPoliciesFrom } from '../../src/mock/lambderMockPoliciesFrom.js';

const directory = mkdtempSync(join(tmpdir(), 'lambder-options-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

let fileCount = 0;
const nextFile = () => join(directory, `apiOptions-${fileCount++}.generated.ts`);

let moduleCount = 0;
/** A module exporting an app's options as the app reports them: what the server's entry is to writeApiOptions, which imports it. */
const moduleFor = (app: LambderApiOptionsSource, exportName = 'default') => {
    const path = join(directory, `instance-${moduleCount++}.mjs`);
    writeFileSync(path, `const instance = { apiOptionEntries: () => (${JSON.stringify(app.apiOptionEntries())}) };\nexport ${exportName === 'default' ? 'default instance' : `{ instance as ${exportName} }`};\n`);
    return path;
};

const write = (app: LambderApiOptionsSource, options: Omit<LambderApiOptionsFileOptions, 'module'>) =>
    writeApiOptions({ module: moduleFor(app), ...options });

type Permission = 'ORDERS.MANAGE' | 'ORDERS.VIEW' | 'STAFF.MANAGE';

const storeGuards = {
    open: lambderGuard({ handler: (_ctx, _payload, _reason: string) => {} }),
    captcha: lambderGuard({ guardInput: z.object({ token: z.string() }), runAt: 'afterInputValidation', handler: () => {} }),
    store: lambderGuard({ guardInput: z.object({ storeId: z.uuid() }), session: true, refusals: ['not-staff'], handler: (_ctx, _input, _need: Permission | readonly Permission[]) => ({ storeId: 's' }) }),
    device: lambderGuard({ apiInput: z.object({ deviceToken: z.string() }), handler: () => {} }),
    owner: lambderGuard({ session: true, handler: () => {} }),
};

/** A store app with every shape of option: a guard per input mode, a policy per kind of key, overrides, idempotency. */
const storeApp = (ordersNeed: Permission | readonly Permission[] = 'ORDERS.MANAGE') => initLambder<{ userId: string }>().declareRefusals({ 'not-staff': { notAuthorized: true, status: 403 }, 'order-closed': {}, 'invite-pending': { data: z.object({ sentAt: z.string() }) } }).create({
    apiPath: '/api',
    session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
    idempotency: { store: new LambderMemoryIdempotencyStore() },
    guards: storeGuards,
    rateLimits: {
        limiter: new LambderMemoryRateLimiter(),
        policies: {
            authPerIp: { perMin: 10, perHour: 60, per: 'ip' },
            codePerEmail: {
                perMin: 4, perDay: 30, budget: 'perPolicy', chargeAt: 'beforeGuards',
                per: lambderRateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email.toLowerCase() }),
                refusal: { type: 'warning', content: 'Too many codes for this address. Try again later.' },
            },
            remindPerSession: { perHour: 20, per: 'session' },
            invitesPerRecipient: { perMonth: 3, budget: 'perPolicy' },
        },
    },
})
    .addApi('order.lookup', { input: z.object({ code: z.string() }), output: z.object({ found: z.boolean() }), guards: { open: 'A lookup code is the whole secret.' }, rateLimit: 'authPerIp', refusals: 'order-closed' }, async (_ctx) => ({ found: true }))
    .addApi('code.send', { input: z.object({ email: z.string() }), output: z.object({ sent: z.boolean() }), guards: 'captcha', rateLimit: { authPerIp: { perMin: 3 }, codePerEmail: true } }, async (_ctx) => ({ sent: true }))
    .addApi('device.ping', { input: z.object({ deviceToken: z.string() }), output: z.object({ ok: z.boolean() }), guards: ['device'] }, async (_ctx) => ({ ok: true }))
    .addSessionApi('orders.list', { input: z.object({}), output: z.array(z.string()), guards: { store: ordersNeed } }, async (_ctx) => [])
    .addSessionApi('staff.invite', { input: z.object({ email: z.string() }), output: z.object({ invited: z.boolean() }), guards: { store: ['STAFF.MANAGE', 'ORDERS.MANAGE'] }, rateLimit: 'remindPerSession', idempotency: { ttlSeconds: 600 }, refusals: ['invite-pending'] }, async (_ctx) => ({ invited: true }))
    .addSessionApi('me', { input: z.object({}), output: z.object({ userId: z.string() }), guards: 'owner', idempotency: true }, async (ctx) => ({ userId: ctx.session.data.userId }));

describe('Lambder.apiOptionEntries', () => {
    it('reports every API sorted by name, with its mode and options as written', () => {
        const { apis } = storeApp().apiOptionEntries();

        expect(Object.keys(apis)).toEqual(['code.send', 'device.ping', 'me', 'order.lookup', 'orders.list', 'staff.invite']);
        expect(apis).toEqual({
            'code.send': { mode: 'public', guards: 'captcha', rateLimit: { authPerIp: { perMin: 3 }, codePerEmail: true } },
            'device.ping': { mode: 'public', guards: ['device'] },
            me: { mode: 'session', guards: 'owner', idempotency: true },
            'order.lookup': { mode: 'public', guards: { open: 'A lookup code is the whole secret.' }, rateLimit: 'authPerIp', refusals: 'order-closed' },
            'orders.list': { mode: 'session', guards: { store: 'ORDERS.MANAGE' } },
            // Its own refusals as written; the code its guard adds is on the guard's declaration.
            'staff.invite': { mode: 'session', guards: { store: ['STAFF.MANAGE', 'ORDERS.MANAGE'] }, rateLimit: 'remindPerSession', idempotency: { ttlSeconds: 600 }, refusals: ['invite-pending'] },
        });
    });

    it('reduces each policy to what is not code, and each guard to its input mode', () => {
        const { rateLimitPolicies, guards } = storeApp().apiOptionEntries();

        expect(rateLimitPolicies).toEqual({
            authPerIp: { perMin: 10, perHour: 60, per: 'ip' },
            codePerEmail: { perMin: 4, perDay: 30, budget: 'perPolicy', chargeAt: 'beforeGuards', per: 'custom', refusal: { type: 'warning', content: 'Too many codes for this address. Try again later.' } },
            invitesPerRecipient: { perMonth: 3, budget: 'perPolicy' },
            remindPerSession: { perHour: 20, per: 'session' },
        });
        expect(JSON.stringify(rateLimitPolicies)).not.toContain('handler');
        expect(guards).toEqual({
            captcha: { input: 'guardInput', session: false, runAt: 'afterInputValidation' },
            device: { input: 'apiInput', session: false, runAt: 'beforeInputValidation' },
            open: { input: 'none', session: false, runAt: 'beforeInputValidation' },
            owner: { input: 'none', session: true, runAt: 'beforeInputValidation' },
            store: { input: 'guardInput', session: true, runAt: 'beforeInputValidation', refusals: ['not-staff'] },
        });
    });

    it('refuses a guard parameter that is not plain data, naming the API and where it sits', () => {
        const withSchema = initLambder().create({ apiPath: '/api', guards: { shape: lambderGuard({ handler: (_ctx, _payload, _schema: z.ZodType) => {} }) } })
            .addApi('a', { input: z.object({}), output: z.object({}), guards: { shape: z.object({}) } }, async (_ctx) => ({}));
        expect(() => withSchema.apiOptionEntries()).toThrow(/the guards option of API "a" must be plain data .* but shape is an instance of ZodObject/);

        const withFunction = initLambder().create({ apiPath: '/api', guards: { pick: lambderGuard({ handler: (_ctx, _payload, _pick: { by: (row: unknown) => boolean }) => {} }) } })
            .addApi('b', { input: z.object({}), output: z.object({}), guards: { pick: { by: () => true } } }, async (_ctx) => ({}));
        expect(() => withFunction.apiOptionEntries()).toThrow(/API "b" .* but pick\.by is a function/);
    });

    it('is the same for an app with no guards and no policies', () => {
        const bare = initLambder().create({ apiPath: '/api' }).addApi('ping', { input: z.object({}), output: z.object({}) }, async (_ctx) => ({}));
        expect(bare.apiOptionEntries()).toEqual({ apis: { ping: { mode: 'public' } }, rateLimitPolicies: {}, guards: {} });
    });
});

describe('writeApiOptions', () => {
    it('writes a module whose three tables read back as the instance reports them', async () => {
        const app = storeApp();
        const file = nextFile();

        const result = await write(app, { file });

        expect(result).toMatchObject({ ok: true, written: true, counts: { apis: 6, rateLimitPolicies: 4, guards: 5 } });
        expect(result.changes.apis.added).toEqual(['code.send', 'device.ping', 'me', 'order.lookup', 'orders.list', 'staff.invite']);
        const contents = readFileSync(file, 'utf8');
        expect(contents).toMatch(/^\/\/ Generated by writeApiOptions\(\) from lambder\/build\. Do not edit\./);
        expect(contents).toContain('import type { LambderApiOptionEntry, LambderRateLimitPolicyEntry, LambderGuardDeclarationEntry } from "lambder/client";');
        expect(contents).toContain('\n// prettier-ignore\nexport const apiOptions = {');
        expect(contents).toContain('} as const satisfies Record<string, LambderApiOptionEntry>;');
        expect(contents).toContain('} as const satisfies Record<string, LambderRateLimitPolicyEntry>;');
        expect(contents).toContain('} as const satisfies Record<string, LambderGuardDeclarationEntry>;');
        expect(readOptionTables(contents)).toEqual(app.apiOptionEntries());
        // The header may speak of handlers; the tables hold none.
        expect(JSON.stringify(readOptionTables(contents))).not.toContain('handler');
    });

    it('names what moved in each table, and leaves a current file untouched however it is formatted', async () => {
        const file = nextFile();
        await write(storeApp(), { file });
        const before = statSync(file).ino;

        const same = await write(storeApp(), { file });
        expect(same).toMatchObject({ ok: true, written: false });
        expect(same.lines).toEqual([expect.stringMatching(/is up to date \(6 APIs, 4 policies, 5 guards\)$/), '  no options changed']);

        // Re-indented and with CRLF line endings, the data is the same.
        writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '\r\n').replace(/ {4}/g, '  '));
        expect(await write(storeApp(), { file })).toMatchObject({ ok: true, written: false });
        expect(statSync(file).ino).toBe(before);

        const reshaped = await write(storeApp(['ORDERS.MANAGE', 'ORDERS.VIEW']), { file });
        expect(reshaped).toMatchObject({ ok: true, written: true });
        expect(reshaped.changes.apis).toEqual({ changed: ['orders.list'], added: [], removed: [] });
        expect(reshaped.lines).toContain('  ~ apiOptions orders.list');
        expect(statSync(file).ino).not.toBe(before);
    });

    it('checks without writing: a current file passes, a stale one fails and names what moved, a missing one fails', async () => {
        const file = nextFile();
        await write(storeApp(), { file });
        const before = readFileSync(file, 'utf8');

        expect(await write(storeApp(), { file, check: true })).toMatchObject({ ok: true, written: false });

        const fewerPolicies = initLambder().create({ apiPath: '/api', guards: { open: storeGuards.open }, rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: { authPerIp: { perMin: 5, per: 'ip' } } } })
            .addApi('order.lookup', { input: z.object({}), output: z.object({}), guards: { open: 'A lookup code is the whole secret.' }, rateLimit: 'authPerIp' }, async (_ctx) => ({}));
        const stale = await write(fewerPolicies, { file, check: true });
        expect(stale.ok).toBe(false);
        expect(stale.lines[0]).toMatch(/is stale: regenerate it/);
        expect(stale.changes.rateLimitPolicies).toEqual({ changed: ['authPerIp'], added: [], removed: ['codePerEmail', 'invitesPerRecipient', 'remindPerSession'] });
        expect(stale.changes.guards.removed).toEqual(['captcha', 'device', 'owner', 'store']);
        expect(stale.lines).toContain('  ~ rateLimitPolicies authPerIp');
        expect(stale.lines).toContain('  - guardDeclarations store');
        expect(readFileSync(file, 'utf8')).toBe(before);

        expect(await write(storeApp(), { file: nextFile(), check: true })).toMatchObject({ ok: false, written: false });
    });

    it('calls a file whose tables it cannot read back stale, and rewrites it', async () => {
        const file = nextFile();
        await write(storeApp(), { file });
        writeFileSync(file, readFileSync(file, 'utf8').replace(/"/g, "'"));

        const check = await write(storeApp(), { file, check: true });
        expect(check.ok).toBe(false);
        expect(check.lines[0]).toMatch(/does not hold the three tables as written/);

        expect(await write(storeApp(), { file })).toMatchObject({ ok: true, written: true });
        expect(readOptionTables(readFileSync(file, 'utf8'))).toEqual(storeApp().apiOptionEntries());
    });

    it('writes the header and semicolons an app asks for', async () => {
        const file = nextFile();
        await write(storeApp(), { file, header: 'Generated by ./build options. Do not edit.\n\nThe declarations as data.', semicolons: false });
        const contents = readFileSync(file, 'utf8');
        expect(contents.startsWith('// Generated by ./build options. Do not edit.\n//\n// The declarations as data.\nimport type')).toBe(true);
        expect(contents).toContain('from "lambder/client"\n');
        expect(contents).toContain('satisfies Record<string, LambderGuardDeclarationEntry>\n');
        expect(await write(storeApp(), { file, check: true })).toMatchObject({ ok: true });
    });

    it('imports the module it is given and reads the export it is told to', async () => {
        const app = storeApp();
        const module = moduleFor(app, 'lambder');
        expect(await writeApiOptions({ module, exportName: 'lambder', file: nextFile() })).toMatchObject({ ok: true, written: true });
        await expect(writeApiOptions({ module, file: nextFile() })).rejects.toThrow(/has no export "default" that reports API options/);
        await expect(writeApiOptions({ module: join(directory, 'missing.mjs'), file: nextFile() })).rejects.toThrow(/could not load .*missing\.mjs$/);
    });
});

describe('writeApiGuardParams', () => {
    const writeParams = (app: LambderApiOptionsSource, options: { guard: string; file: string; check?: boolean; header?: string; semicolons?: boolean }) =>
        writeApiGuardParams({ module: moduleFor(app), ...options });

    it('writes the parameter each API gives one guard, for the APIs that declare it, and nothing else', async () => {
        const file = nextFile();

        const result = await writeParams(storeApp(), { guard: 'store', file });

        expect(result).toMatchObject({ ok: true, written: true, count: 2, changes: { added: ['orders.list', 'staff.invite'], changed: [], removed: [] } });
        const contents = readFileSync(file, 'utf8');
        expect(contents).toMatch(/^\/\/ Generated by writeApiGuardParams\(\) from lambder\/build\. Do not edit\./);
        expect(contents).toContain('\n// prettier-ignore\nexport const guardParams = {');
        expect(readGeneratedTable(contents, 'guardParams')).toEqual({ 'orders.list': 'ORDERS.MANAGE', 'staff.invite': ['STAFF.MANAGE', 'ORDERS.MANAGE'] });
        // No other API, no mode, no other guard, and no reviewer's reason.
        expect(contents).not.toMatch(/order\.lookup|code\.send|"mode"|captcha|lookup code/);
        expect(contents).not.toContain('import');
    });

    it('writes true for a guard an API names without a parameter', async () => {
        const file = nextFile();
        await writeParams(storeApp(), { guard: 'device', file });
        expect(readGeneratedTable(readFileSync(file, 'utf8'), 'guardParams')).toEqual({ 'device.ping': true });
    });

    it('names what moved, leaves a current file untouched, and checks without writing', async () => {
        const file = nextFile();
        await writeParams(storeApp(), { guard: 'store', file });
        const before = readFileSync(file, 'utf8');

        expect(await writeParams(storeApp(), { guard: 'store', file })).toMatchObject({ ok: true, written: false });
        expect(await writeParams(storeApp(), { guard: 'store', file, check: true })).toMatchObject({ ok: true, written: false });

        const stale = await writeParams(storeApp('ORDERS.VIEW'), { guard: 'store', file, check: true });
        expect(stale).toMatchObject({ ok: false, written: false, changes: { changed: ['orders.list'], added: [], removed: [] } });
        expect(stale.lines).toEqual([expect.stringMatching(/is stale: regenerate it$/), '  guardParams: 1 changed, 0 added, 0 removed (1 unchanged)', '  ~ guardParams orders.list']);
        expect(readFileSync(file, 'utf8')).toBe(before);

        expect(await writeParams(storeApp('ORDERS.VIEW'), { guard: 'store', file })).toMatchObject({ ok: true, written: true });
        expect(readGeneratedTable(readFileSync(file, 'utf8'), 'guardParams')).toMatchObject({ 'orders.list': 'ORDERS.VIEW' });
        expect(await writeParams(storeApp(), { guard: 'store', file: nextFile(), check: true })).toMatchObject({ ok: false });
    });

    it('writes the header and semicolons an app asks for', async () => {
        const file = nextFile();
        await writeParams(storeApp(), { guard: 'store', file, header: 'Generated by ./build guards. Do not edit.', semicolons: false });
        const contents = readFileSync(file, 'utf8');
        expect(contents.startsWith('// Generated by ./build guards. Do not edit.\n\n/**')).toBe(true);
        expect(contents.endsWith('} as const\n')).toBe(true);
    });

    it('refuses a guard the server does not declare, naming the ones it does', async () => {
        await expect(writeParams(storeApp(), { guard: 'shop', file: nextFile() }))
            .rejects.toThrow('writeApiGuardParams: the server declares no guard "shop" (it declares "captcha", "device", "open", "owner", "store").');
    });
});

/** The tables as a generated module holds them: `as const`, so every reader below sees literals. */
const apiOptions = {
    'code.send': { mode: 'public', guards: 'captcha', rateLimit: { authPerIp: { perMin: 3 }, codePerEmail: true } },
    'device.ping': { mode: 'public', guards: ['device'] },
    me: { mode: 'session', guards: 'owner', idempotency: true },
    'order.lookup': { mode: 'public', guards: { open: 'A lookup code is the whole secret.' }, rateLimit: 'authPerIp' },
    'orders.list': { mode: 'session', guards: { store: 'ORDERS.MANAGE' } },
    'staff.invite': { mode: 'session', guards: { store: ['STAFF.MANAGE', 'ORDERS.MANAGE'] }, rateLimit: 'remindPerSession', idempotency: { ttlSeconds: 600 } },
    health: { mode: 'public' },
} as const satisfies LambderApiOptionEntries['apis'];
const rateLimitPolicies = {
    authPerIp: { perMin: 10, perHour: 60, per: 'ip' },
    codePerEmail: { perMin: 4, perDay: 30, budget: 'perPolicy', chargeAt: 'beforeGuards', per: 'custom', refusal: { type: 'warning', content: 'Too many codes for this address. Try again later.' } },
    invitesPerRecipient: { perMonth: 3, budget: 'perPolicy' },
    remindPerSession: { perHour: 20, per: 'session' },
} as const satisfies LambderApiOptionEntries['rateLimitPolicies'];
const guardDeclarations = {
    captcha: { input: 'guardInput', session: false, runAt: 'afterInputValidation' },
    device: { input: 'apiInput', session: false, runAt: 'beforeInputValidation' },
    open: { input: 'none', session: false, runAt: 'beforeInputValidation' },
    owner: { input: 'none', session: true, runAt: 'beforeInputValidation' },
    store: { input: 'guardInput', session: true, runAt: 'beforeInputValidation' },
} as const satisfies LambderApiOptionEntries['guards'];

describe('Reading the generated tables', () => {
    it('derives the APIs behind a guard, by name or by exact declaration, and the APIs of a mode', () => {
        expectTypeOf<LambderApisWithGuard<typeof apiOptions, 'store'>>().toEqualTypeOf<'orders.list' | 'staff.invite'>();
        expectTypeOf<LambderApisWithGuard<typeof apiOptions, 'captcha'>>().toEqualTypeOf<'code.send'>();
        expectTypeOf<LambderApisWithGuard<typeof apiOptions, 'device'>>().toEqualTypeOf<'device.ping'>();
        expectTypeOf<LambderApisWithGuard<typeof apiOptions, 'nobody'>>().toEqualTypeOf<never>();
        expectTypeOf<LambderApisGuardedBy<typeof apiOptions, 'owner'>>().toEqualTypeOf<'me'>();
        expectTypeOf<LambderApisGuardedBy<typeof apiOptions, { store: 'ORDERS.MANAGE' }>>().toEqualTypeOf<'orders.list'>();
        expectTypeOf<LambderApisWithMode<typeof apiOptions, 'session'>>().toEqualTypeOf<'me' | 'orders.list' | 'staff.invite'>();
    });

    it('reads a guard parameter with the literal the table pins', () => {
        expectTypeOf<LambderGuardParamOf<(typeof apiOptions)['orders.list'], 'store'>>().toEqualTypeOf<'ORDERS.MANAGE'>();
        expectTypeOf<LambderGuardParamOf<(typeof apiOptions)['staff.invite'], 'store'>>().toEqualTypeOf<readonly ['STAFF.MANAGE', 'ORDERS.MANAGE']>();
        expectTypeOf<LambderGuardParamOf<(typeof apiOptions)['me'], 'owner'>>().toEqualTypeOf<true>();
        expectTypeOf<LambderGuardParamOf<(typeof apiOptions)['device.ping'], 'device'>>().toEqualTypeOf<true>();
        expectTypeOf<LambderGuardParamOf<(typeof apiOptions)['health'], 'owner'>>().toEqualTypeOf<undefined>();
        expectTypeOf<LambderGuardParamOf<(typeof apiOptions)['me'], 'store'>>().toEqualTypeOf<undefined>();

        expect(apiGuardParam(apiOptions, 'orders.list', 'store')).toBe('ORDERS.MANAGE');
        expect(apiGuardParam(apiOptions, 'staff.invite', 'store')).toEqual(['STAFF.MANAGE', 'ORDERS.MANAGE']);
        expect(apiGuardParam(apiOptions, 'order.lookup', 'open')).toBe('A lookup code is the whole secret.');
        expect(apiGuardParam(apiOptions, 'me', 'owner')).toBe(true);
        expect(apiGuardParam(apiOptions, 'device.ping', 'device')).toBe(true);
        expect(apiGuardParam(apiOptions, 'health', 'owner')).toBeUndefined();
        expect(apiGuardParam(apiOptions, 'me', 'store')).toBeUndefined();
        // A guard named for something Object.prototype carries reads as absent, not as the inherited function.
        expect(apiGuardParam(apiOptions, 'orders.list', 'toString')).toBeUndefined();
        // Over a union of names, the parameter is the union of what each declares.
        const need = apiGuardParam(apiOptions, 'orders.list' as 'orders.list' | 'staff.invite', 'store');
        expectTypeOf(need).toEqualTypeOf<'ORDERS.MANAGE' | readonly ['STAFF.MANAGE', 'ORDERS.MANAGE']>();
    });
});

describe('lambderMockPoliciesFrom', () => {
    type Contract = ReturnType<typeof storeApp>['ApiContract'];
    const mock = initLambderMock<Contract, { userId: string }>();
    const emailKey = mock.rateLimitKey({ apiInput: z.object({ email: z.string() }), handler: (_ctx, { email }) => email.toLowerCase() });

    it('puts the key handler back on a custom-keyed policy and copies every other as declared', () => {
        const policies = lambderMockPoliciesFrom(rateLimitPolicies, { keys: { codePerEmail: emailKey } });
        expect(policies.authPerIp).toEqual({ perMin: 10, perHour: 60, per: 'ip' });
        expect(policies.codePerEmail).toEqual({ perMin: 4, perDay: 30, budget: 'perPolicy', chargeAt: 'beforeGuards', per: emailKey, refusal: { type: 'warning', content: 'Too many codes for this address. Try again later.' } });
        expect(policies.invitesPerRecipient).toEqual({ perMonth: 3, budget: 'perPolicy' });
        expect(policies.remindPerSession).toEqual({ perHour: 20, per: 'session' });
        expectTypeOf(policies.authPerIp.per).toEqualTypeOf<'ip'>();
        expectTypeOf(policies.codePerEmail.budget).toEqualTypeOf<'perPolicy'>();
        expectTypeOf(policies.codePerEmail.per).toEqualTypeOf<typeof emailKey>();
    });

    it('requires a key for exactly the custom-keyed policies, at compile time and at runtime', () => {
        // @ts-expect-error codePerEmail is keyed by a handler, and none is given.
        expect(() => lambderMockPoliciesFrom(rateLimitPolicies, { keys: {} })).toThrow(/rate-limit policy "codePerEmail" is keyed by a handler of the server's, so the mock has to supply one/);
        // @ts-expect-error authPerIp is keyed per ip: a handler for it is a mistake.
        expect(() => lambderMockPoliciesFrom(rateLimitPolicies, { keys: { codePerEmail: emailKey, authPerIp: emailKey } })).toThrow(/"authPerIp", which the server does not key by a handler/);
        // @ts-expect-error nobody is not a policy.
        expect(() => lambderMockPoliciesFrom(rateLimitPolicies, { keys: { codePerEmail: emailKey, nobody: emailKey } })).toThrow(/"nobody", which the server does not declare/);
        // A table without a custom key needs no keys at all.
        expect(lambderMockPoliciesFrom({ authPerIp: { perMin: 10, per: 'ip' } } as const, {})).toEqual({ authPerIp: { perMin: 10, per: 'ip' } });
    });

    it('builds policies a mock app accepts against the contract, held to the same rules as a hand-written map', () => {
        const mockGuards = {
            open: mock.guard({ handler: (_ctx, _payload, _reason: string) => {} }),
            captcha: mock.guard({ guardInput: z.object({ token: z.string() }), handler: () => {} }),
            store: mock.guard({ guardInput: z.object({ storeId: z.uuid() }), session: true, handler: (_ctx, _input, _need: Permission | readonly Permission[]) => ({ storeId: 's' }) }),
            device: mock.guard({ apiInput: z.object({ deviceToken: z.string() }), handler: () => {} }),
            owner: mock.guard({ session: true, handler: () => {} }),
        };
        const mockApp = mock.create({
            sessions: true,
            idempotency: true,
            rateLimits: { policies: lambderMockPoliciesFrom(rateLimitPolicies, { keys: { codePerEmail: emailKey } }) },
            guards: mockGuards,
            guardDeclarations,
        });
        expect(mockApp).toBeDefined();

        // A policy a public endpoint names may still not be keyed per session:
        // the table's literals carry through, so the contract check still bites.
        const sessionKeyedLookup = { ...rateLimitPolicies, authPerIp: { perMin: 10, per: 'session' } } as const;
        mock.create({
            sessions: true, idempotency: true, guards: mockGuards,
            // @ts-expect-error order.lookup is public and authPerIp would count per session.
            rateLimits: { policies: lambderMockPoliciesFrom(sessionKeyedLookup, { keys: { codePerEmail: emailKey } }) },
        });
    });

    it('holds a mock guard to the declared input mode and session requirement when the declarations are given', () => {
        const agreeing = {
            open: mock.guard({ handler: (_ctx, _payload, _reason: string) => {} }),
            captcha: mock.guard({ guardInput: z.object({ token: z.string() }), handler: () => {} }),
            store: mock.guard({ guardInput: z.object({ storeId: z.uuid() }), session: true, handler: (_ctx, _input, _need: Permission | readonly Permission[]) => ({ storeId: 's' }) }),
            device: mock.guard({ apiInput: z.object({ deviceToken: z.string() }), handler: () => {} }),
            owner: mock.guard({ session: true, handler: () => {} }),
        };
        const policies = lambderMockPoliciesFrom(rateLimitPolicies, { keys: { codePerEmail: emailKey } });
        mock.create({ sessions: true, idempotency: true, rateLimits: { policies }, guards: agreeing, guardDeclarations });

        mock.create({
            sessions: true, idempotency: true, rateLimits: { policies }, guardDeclarations,
            guards: {
                ...agreeing,
                // @ts-expect-error the server's owner guard needs no input; a payload slice here would run where the server reads nothing.
                owner: mock.guard({ apiInput: z.object({ userId: z.string() }), session: true, handler: () => {} }),
            },
        });
        mock.create({
            sessions: true, idempotency: true, rateLimits: { policies }, guardDeclarations,
            guards: {
                ...agreeing,
                // @ts-expect-error the server's owner guard needs the session; a mock guard that does not would authorize a call the server refuses.
                owner: mock.guard({ handler: () => {} }),
            },
        });
        // Without the declarations, nothing more than the contract is asked:
        // it names a guardInput's shape and a public endpoint's guards, and
        // sees neither of the two disagreements above.
        mock.create({
            sessions: true, idempotency: true, rateLimits: { policies },
            guards: { ...agreeing, owner: mock.guard({ apiInput: z.object({ userId: z.string() }), handler: () => {} }) },
        });
    });
});
