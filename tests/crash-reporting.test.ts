/**
 * The `crashes` option: one reporter told every crash wherever it happened
 * (an API call, a route, a non-HTTP event, a failed `created` hook), awaited
 * before the answer goes out for up to `reportTimeoutMs`, never told a
 * refusal, and unable to break or stall the answer when it fails itself; and
 * `reveal`, which lets a trusted caller read
 * a crash in the framework's own 500.
 *
 * Also what happens with no reporter: the framework's 500 logs the crash, so
 * a crash nothing answered is never silent.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { initLambder } from '../src/core/Lambder.js';
import type { LambderCrashOptions, LambderCrashSite } from '../src/core/LambderCreateOptions.js';
import { refuse } from '../src/shared/wire/LambderApiRefusal.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import type { LambderRenderContext } from '../src/core/LambderContext.js';
import { lambderTestApp, assertApiFailure, assertApiSuccess } from '../src/testing.js';

afterEach(() => { vi.restoreAllMocks(); });

type Report = { message: string; site: LambderCrashSite };

const createApp = (crashes: LambderCrashOptions = {}) => initLambder().create({ apiPath: '/api', crashes })
    .addApi('crash', { input: z.object({}), output: z.object({}) }, async (ctx, res) => {
        res.logToApiResponse({ before: 'the throw' });
        throw new Error('boom');
    })
    .addApi('refused', { input: z.object({}), output: z.object({}) }, async () => refuse('No.'))
    .addApi('fine', { input: z.object({}), output: z.object({ ok: z.boolean() }) }, async (_ctx, res) => res.api({ ok: true }))
    .addRoute('/broken', async () => { throw new Error('the page broke'); })
    .addAction((event): event is { source: 'nightly' } => (event as { source?: string })?.source === 'nightly', async () => {
        throw new Error('the job broke');
    });

const recorder = () => {
    const reports: Report[] = [];
    return { reports, report: async (error: Error, site: LambderCrashSite) => { reports.push({ message: error.message, site }); } };
};

describe('crashes.report', () => {
    it('is told an API crash, with the context, before the answer goes out', async () => {
        const order: string[] = [];
        const app = lambderTestApp(createApp({
            report: async (error, site) => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                order.push(`reported ${error.message} at ${site.kind} ${site.kind === 'api' ? site.ctx.apiName : ''}`);
            },
        }));

        const outcome = await app.visitor().apiOutcome('crash', {});
        order.push('answered');

        assertApiFailure(outcome, 'server', { status: 500 });
        expect(order).toEqual(['reported boom at api crash', 'answered']);
    });

    it('is told a route crash, a failed event action and an event nothing matched, and the event errors still reach Lambda', async () => {
        const { reports, report } = recorder();
        const app = lambderTestApp(createApp({ report }));

        expect((await app.visitor().request('GET', '/broken')).statusCode).toBe(500);
        await expect(app.event({ source: 'nightly' })).rejects.toThrow('the job broke');
        await expect(app.event({ source: 'nobody.listens' })).rejects.toThrow(/no action matched/);

        expect(reports.map(({ message, site }) => [site.kind, message])).toEqual([
            ['route', 'the page broke'],
            ['event', 'the job broke'],
            ['event', expect.stringMatching(/no action matched/)],
        ]);
        const event = reports[1]!.site;
        expect(event.kind === 'event' ? event.event : null).toEqual({ source: 'nightly' });
    });

    it('is told a created hook that failed, as a startup crash, on either path', async () => {
        const { reports, report } = recorder();
        const app = createApp({ report }).addHook('created', async () => { throw new Error('secrets unreachable'); });
        const tested = lambderTestApp(app);

        assertApiFailure(await tested.visitor().apiOutcome('fine', {}), 'server');
        await expect(tested.event({ source: 'nightly' })).rejects.toThrow('secrets unreachable');

        expect(reports.map(({ message, site }) => [site.kind, message])).toEqual([
            ['startup', 'secrets unreachable'],
            ['startup', 'secrets unreachable'],
        ]);
    });

    it('is never told a refusal', async () => {
        const { reports, report } = recorder();
        const app = lambderTestApp(createApp({ report }));

        assertApiFailure(await app.visitor().apiOutcome('refused', {}), 'errorMessage');
        assertApiSuccess(await app.visitor().apiOutcome('fine', {}));
        expect(reports).toEqual([]);
    });

    it('cannot break the answer by throwing, and what it threw is logged beside the crash', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const app = lambderTestApp(createApp({ report: async () => { throw new Error('reporter down'); } }));

        assertApiFailure(await app.visitor().apiOutcome('crash', {}), 'server', { status: 500 });
        const logged = error.mock.calls.find((call) => String(call[0]).includes('crashes.report threw'));
        expect((logged?.[1] as Error).message).toBe('boom');
        expect((logged?.[3] as Error).message).toBe('reporter down');
    });

    /**
     * Pins the unbounded wait: a reporter whose network call hangs held
     * every crash's answer until the function timed out, so a crash became a
     * Lambda timeout with no answer at all.
     */
    it('is waited for only up to reportTimeoutMs, then the crash is logged as unreported and answered', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const stalled = new Promise<void>(() => {});
        const app = lambderTestApp(createApp({ report: () => stalled, reportTimeoutMs: 20 }));

        const started = Date.now();
        assertApiFailure(await app.visitor().apiOutcome('crash', {}), 'server', { status: 500 });
        await expect(app.event({ source: 'nightly' })).rejects.toThrow('the job broke');
        expect(Date.now() - started).toBeLessThan(2_000);

        const unfinished = error.mock.calls.filter((call) => String(call[0]).includes('crashes.report did not finish within 20 ms'));
        expect(unfinished.map((call) => (call[1] as Error).message)).toEqual(['boom', 'the job broke']);
    });

    it('refuses a reportTimeoutMs that is not a positive integer', () => {
        expect(() => createApp({ reportTimeoutMs: 0 })).toThrow(/Lambder: crashes.reportTimeoutMs must be a positive integer/);
        expect(() => createApp({ reportTimeoutMs: 1.5 })).toThrow(/crashes.reportTimeoutMs/);
        expect(() => createApp({ reportTimeoutMs: 500 })).not.toThrow();
    });

    it('is told the crash and, separately, a global error handler that threw while answering it', async () => {
        const { reports, report } = recorder();
        const app = lambderTestApp(createApp({ report }).setGlobalErrorHandler(() => { throw new Error('handler broke'); }));

        assertApiFailure(await app.visitor().apiOutcome('crash', {}), 'server', { status: 500 });
        expect(reports.map(({ message }) => message)).toEqual(['boom', 'Lambder: the global error handler threw while answering a crash.']);
    });
});

describe('a crash nothing answered', () => {
    it('is logged by the framework\'s 500 when the app has no reporter', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const app = lambderTestApp(createApp());

        assertApiFailure(await app.visitor().apiOutcome('crash', {}), 'server', { status: 500 });
        expect(String(error.mock.calls[0]?.[0])).toContain('POST /api crashed');
        expect((error.mock.calls[0]?.[1] as Error).message).toBe('boom');
    });

    it('is left to the reporter when there is one', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const app = lambderTestApp(createApp(recorder()));

        assertApiFailure(await app.visitor().apiOutcome('crash', {}), 'server', { status: 500 });
        expect(error).not.toHaveBeenCalled();
    });
});

describe('crashes.reveal', () => {
    it('puts the crash and the call\'s logList on the framework\'s 500 for a caller it trusts', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const app = lambderTestApp(createApp({ reveal: (ctx) => ctx.header('x-developer') === 'yes' }));

        const revealed = await app.visitor({ headers: { 'x-developer': 'yes' } }).apiOutcome('crash', {});
        assertApiFailure(revealed, 'server', { status: 500 });
        expect(revealed.response?.crash).toMatchObject({ name: 'Error', message: 'boom', requestId: expect.any(String) });
        expect(revealed.response?.crash?.stack).toContain('crash-reporting.test.ts');
        expect(revealed.response?.logList).toEqual([{ before: 'the throw' }]);

        const hidden = await app.visitor().apiOutcome('crash', {});
        assertApiFailure(hidden, 'server', { status: 500 });
        expect(hidden.response?.crash).toBeUndefined();
        expect(hidden.response?.logList).toBeUndefined();
    });

    it('puts the stack in the text of a route\'s 500', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const app = lambderTestApp(createApp({ reveal: () => true }));

        const page = await app.visitor().request('GET', '/broken');
        expect(page.statusCode).toBe(500);
        expect(page.text()).toMatch(/^Internal Server Error\.\n\nError: the page broke\n\s+at /);
    });

    it('reveals nothing when it throws, and nothing through an app\'s own error handler', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const throwing = lambderTestApp(createApp({ reveal: () => { throw new Error('reveal broke'); } }));
        const hidden = await throwing.visitor().apiOutcome('crash', {});
        assertApiFailure(hidden, 'server');
        expect(hidden.response?.crash).toBeUndefined();
        expect(error.mock.calls.some((call) => String(call[0]).includes('crashes.reveal threw'))).toBe(true);

        const handled = lambderTestApp(createApp({ reveal: () => true }).setGlobalErrorHandler((_err, _ctx, res) => res.api(null, { errorMessage: 'Ours.' }, { statusCode: 500 })));
        const answered = await handled.visitor().apiOutcome('crash', {});
        assertApiFailure(answered, 'server');
        expect(answered.response?.crash).toBeUndefined();
        expect(answered.errorMessage?.content).toBe('Ours.');
    });
});

describe('a context a beforeRender hook handed back', () => {
    /**
     * A session app whose hook replaces the context with a copy carrying a
     * tenant, and whose session API and route both crash after it. The
     * session the pipeline reads lands on the replacement, the one object
     * the handler holds.
     */
    const createTenantApp = (crashes: LambderCrashOptions) => initLambder<{ userId: string }>().create({
        apiPath: '/api',
        session: { store: new LambderMemorySessionStore(), sessionSalt: 'crash-salt' },
        crashes,
    })
        .addHook('beforeRender', (ctx) => {
            const replaced: LambderRenderContext & { tenant: string } = { ...ctx, tenant: 'acme' };
            return replaced;
        })
        .addSessionApi('crashSigned', { input: z.object({}), output: z.object({}) }, async () => { throw new Error('signed boom'); })
        .addRoute('/broken', async () => { throw new Error('the page broke'); });
    const tenantOf = (ctx: LambderRenderContext | null) => (ctx as (LambderRenderContext & { tenant?: string }) | null)?.tenant;

    it('is the one the reporter and reveal are handed, the session the call read included', async () => {
        // Regression: the replacement reached the handler alone, so a crash's
        // site.ctx and reveal(ctx) missed what the hook added, and site.ctx
        // held no session although the handler's context had one.
        const reports: { tenant: string | undefined; sessionKey: string | null; kind: string }[] = [];
        const revealedTo: (string | undefined)[] = [];
        const app = lambderTestApp(createTenantApp({
            report: (_error, site) => {
                if(site.kind !== 'api' && site.kind !== 'route') return;
                reports.push({ tenant: tenantOf(site.ctx), sessionKey: site.ctx?.session?.sessionKey ?? null, kind: site.kind });
            },
            reveal: (ctx) => { revealedTo.push(tenantOf(ctx)); return false; },
        }));
        const visitor = await app.signIn('ada', { userId: 'ada' });

        assertApiFailure(await visitor.apiOutcome('crashSigned', {}), 'server', { status: 500 });
        expect((await visitor.request('GET', '/broken')).statusCode).toBe(500);

        expect(reports).toEqual([
            { tenant: 'acme', sessionKey: 'ada', kind: 'api' },
            { tenant: 'acme', sessionKey: null, kind: 'route' },
        ]);
        expect(revealedTo).toEqual(['acme', 'acme']);
    });

    it('is the one the global error handler is handed', async () => {
        const handledFor: (string | undefined)[] = [];
        const app = lambderTestApp(createTenantApp({}).setGlobalErrorHandler((_error, ctx, res) => {
            handledFor.push(tenantOf(ctx));
            return res.text('handled', { statusCode: 500 });
        }));

        expect((await app.visitor().request('GET', '/broken')).text()).toBe('handled');
        expect(handledFor).toEqual(['acme']);
    });
});
