/**
 * lambder/build: checkApiRefusals, every refusal a handler can reach held to
 * the codes its endpoint may send.
 *
 * The project is tests/fixtures/refusal-app: an app whose endpoints, guards,
 * mock guards and mock entries each reach their refusals one way (their own
 * ctx.refuse, a helper, a class's method, a refusal class of the app's own, a
 * function handed along, a module loaded with import(), a handler wrapped or
 * held in an object, a refuse under a name of the app's own), several of them
 * wrongly on purpose, and a mock whose init declared no vocabulary, whose
 * guards have only their own refusals option to be held to. Every call compiles the
 * project with the TypeScript compiler, so these take a second or two.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkApiRefusals, type LambderRefusalCheckFinding } from '../../src/build.js';

const COMPILER_TIMEOUT_MS = 120_000;
const FIXTURE = relative(process.cwd(), fileURLToPath(new URL('../fixtures/refusal-app', import.meta.url)));
const at = (file: string, line: number) => `${FIXTURE}/${file}:${line}`;

/** What each finding says, without the lines of prose around it. */
const summaryOf = (findings: LambderRefusalCheckFinding[]) =>
    findings.map(({ handler, problem, code, raisedAt }) => ({ handler, problem, ...(code ? { code } : {}), ...(raisedAt ? { raisedAt } : {}) }));

describe('checkApiRefusals', () => {
    it('finds every code a handler can reach and may not send, wherever it is raised', async () => {
        const result = await checkApiRefusals({ tsconfig: `${FIXTURE}/tsconfig.json` });
        expect(result.ok).toBe(false);
        // The guards, the endpoints, the mock guards and the mock entries of the fixture, each checked, but for the one handed no typed refuse.
        expect(result.handlers).toBe(23);
        expect(summaryOf(result.findings.filter((finding) => finding.problem === 'undeclared'))).toEqual([
            // A guard raising, through a helper, a code it does not name.
            { handler: 'openOrder', problem: 'undeclared', code: 'order-missing', raisedAt: at('helpers.ts', 9) },
            // An endpoint reaching a helper's code.
            { handler: 'orders.cancel', problem: 'undeclared', code: 'order-missing', raisedAt: at('helpers.ts', 9) },
            // A method of a class it constructs; its guard's own code needs nothing of it.
            { handler: 'orders.refund', problem: 'undeclared', code: 'wallet-short', raisedAt: at('helpers.ts', 16) },
            // A refusal class of the app's own, raised where its super() is.
            { handler: 'orders.reopen', problem: 'undeclared', code: 'order-missing', raisedAt: at('helpers.ts', 26) },
            // A module it loads with import().
            { handler: 'orders.audit', problem: 'undeclared', code: 'wallet-short', raisedAt: at('lazyHelpers.ts', 4) },
            // A refusal class of the app's own that inherits LambderApiRefusal's constructor, constructed where it is thrown.
            { handler: 'orders.settle', problem: 'undeclared', code: 'wallet-short', raisedAt: at('server.ts', 65) },
            // A handler the app wraps, followed through the wrapper's argument.
            { handler: 'orders.hold', problem: 'undeclared', code: 'order-missing', raisedAt: at('helpers.ts', 9) },
            // A handler held in an object, followed through the property.
            { handler: 'orders.drop', problem: 'undeclared', code: 'order-closed', raisedAt: at('helpers.ts', 12) },
            // The init's refuse held in a constant of another name.
            { handler: 'orders.ship', problem: 'undeclared', code: 'wallet-short', raisedAt: at('aliases.ts', 9) },
            // A mock guard, its refuse typed to its own refusals as a server guard's is, raising through the mock's helper.
            { handler: 'mockOpenOrder', problem: 'undeclared', code: 'wallet-short', raisedAt: at('mock.ts', 10) },
            // A mock entry, held to what the contract gives its endpoint.
            { handler: 'orders.cancel', problem: 'undeclared', code: 'wallet-short', raisedAt: at('mock.ts', 10) },
        ]);
        // orders.get reaches exactly its two codes, one through a constant, and
        // staffOnly, its mock twin and the other mock entry exactly theirs.
        // orders.close reaches its two through its refuse held in a variable
        // and destructured under another name. plainOpen, from a mock with no
        // vocabulary, is held to its own empty refusals and reaches none.
        // mockAnyoneIsStaff declares its server guard's code and raises none,
        // as a mock that lets everyone through does.
        const handlersWithFindings = result.findings.map((finding) => finding.handler);
        for(const handler of ['orders.get', 'staffOnly', 'mockStaffOnly', 'mockAnyoneIsStaff', 'orders.close', 'plainOpen']) expect(handlersWithFindings).not.toContain(handler);
        // Of every handler found, the unchecked one included.
        expect(result.lines[0]).toMatch(/^✗ 18 refusal findings in 16 of 24 handlers$/);
    }, COMPILER_TIMEOUT_MS);

    it('finds a declared code nothing reaches, a refusal with no code, one whose code cannot be told, a handler it cannot follow, and one it has nothing to check against', async () => {
        const result = await checkApiRefusals({ tsconfig: `${FIXTURE}/tsconfig.json` });
        expect(summaryOf(result.findings.filter((finding) => finding.problem !== 'undeclared'))).toEqual([
            { handler: 'openOrder', problem: 'unused', code: 'order-closed' },
            { handler: 'orders.list', problem: 'unused', code: 'wallet-short' },
            // Handed along to forEach rather than called: still reached.
            { handler: 'orders.archive', problem: 'uncoded', raisedAt: at('helpers.ts', 21) },
            { handler: 'orders.tag', problem: 'unreadable', raisedAt: at('helpers.ts', 31) },
            // The free refuse imported under another name.
            { handler: 'orders.pause', problem: 'uncoded', raisedAt: at('aliases.ts', 12) },
            // Registered inside the app's own wrapper, where the handler is a parameter: a finding, never a pass.
            { handler: 'defineApi', problem: 'untraced' },
            // A mock guard from an init with no vocabulary, declaring no refusals: nothing to hold it to, so a finding, never a pass.
            { handler: 'plainSignedIn', problem: 'unchecked' },
        ]);
        expect(result.lines.some((line) => line.includes('orders.archive') && line.includes('no code'))).toBe(true);
        expect(result.lines.at(-1)).toBe(`  plainSignedIn (${at('plainMock.ts', 9)}) is handed no typed refuse, so nothing it reaches could be checked: build it from an init that declares the refusal vocabulary (declareRefusals, on initLambderMock() as on initLambder()), or give a guard a refusals option naming the codes it may send`);
    }, COMPILER_TIMEOUT_MS);

    it('lists a handler handed no typed refuse without failing on it, when told it may stand unchecked', async () => {
        const result = await checkApiRefusals({ tsconfig: `${FIXTURE}/tsconfig.json`, requireTypedRefuse: false });
        expect(result.findings.some((finding) => finding.problem === 'unchecked')).toBe(false);
        expect(result.lines[0]).toMatch(/^✗ 17 refusal findings in 15 of 24 handlers$/);
        expect(result.lines.at(-1)).toBe(`  1 handler has no typed refuse to check against: plainSignedIn (${at('plainMock.ts', 9)})`);
    }, COMPILER_TIMEOUT_MS);

    it('lets a refusal with no code pass for an app that does not require codes', async () => {
        const result = await checkApiRefusals({ tsconfig: `${FIXTURE}/tsconfig.json`, requireCodes: false });
        expect(result.findings.some((finding) => finding.problem === 'uncoded')).toBe(false);
        expect(result.findings.some((finding) => finding.problem === 'undeclared')).toBe(true);
    }, COMPILER_TIMEOUT_MS);

    it('reads the declaration files an installed copy ships, where a refuse\'s type is written out on the member', async () => {
        // The emitted declarations spell out an init's and a mock's refuse in
        // place of the alias the sources name, so a project over the built
        // package (here, dist) meets those members and not the alias.
        const built = (entry: string) => JSON.stringify(fileURLToPath(new URL(`../../dist/${entry}`, import.meta.url)));
        const project = mkdtempSync(join(tmpdir(), 'lambder-refusal-check-'));
        try {
            writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({
                compilerOptions: { noEmit: true, strict: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'ESNext', skipLibCheck: true, types: [] },
                include: ['*.ts'],
            }));
            writeFileSync(join(project, 'app.ts'), [
                `import { initLambder } from ${built('index.js')};`,
                `import { initLambderMock } from ${built('mock.js')};`,
                'const init = initLambder();',
                'const mock = initLambderMock<{}>();',
                'const held = init.refuse;',
                'const refuseThroughInit = (): never => init.refuse("No.");',
                'const refuseThroughHeld = (): never => held("No.");',
                'const refuseThroughMock = (): never => mock.refuse("No.");',
                'export const throughInit = init.guard({ handler: () => refuseThroughInit() });',
                'export const throughHeld = init.guard({ handler: () => refuseThroughHeld() });',
                'export const throughMock = init.guard({ handler: () => refuseThroughMock() });',
            ].join('\n'));
            const result = await checkApiRefusals({ tsconfig: join(project, 'tsconfig.json') });
            expect(result.findings.map(({ handler, problem }) => ({ handler, problem }))).toEqual([
                { handler: 'throughInit', problem: 'uncoded' },
                { handler: 'throughHeld', problem: 'uncoded' },
                { handler: 'throughMock', problem: 'uncoded' },
            ]);
        } finally {
            rmSync(project, { recursive: true, force: true });
        }
    }, COMPILER_TIMEOUT_MS);

    it('fails a project whose every handler is handed no typed refuse, naming each', async () => {
        const project = mkdtempSync(join(tmpdir(), 'lambder-refusal-check-'));
        try {
            writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({
                compilerOptions: { noEmit: true, strict: true, module: 'nodenext', moduleResolution: 'nodenext', target: 'ESNext', skipLibCheck: true, types: [] },
                include: ['*.ts'],
            }));
            writeFileSync(join(project, 'mock.ts'), [
                `import { initLambderMock } from ${JSON.stringify(fileURLToPath(new URL('../../dist/mock.js', import.meta.url)))};`,
                'const mock = initLambderMock<{}>();',
                'export const signedIn = mock.guard({ handler: () => {} });',
            ].join('\n'));
            const result = await checkApiRefusals({ tsconfig: join(project, 'tsconfig.json') });
            expect(result).toMatchObject({ ok: false, handlers: 0, findings: [{ handler: 'signedIn', problem: 'unchecked' }] });
            expect(result.lines[0]).toMatch(/no handler Lambder hands a typed refuse was found, so nothing was checked/);
            expect(result.lines[1]).toMatch(/^ {2}signedIn \(.*mock\.ts:3\) is handed no typed refuse/);
        } finally {
            rmSync(project, { recursive: true, force: true });
        }
    }, COMPILER_TIMEOUT_MS);

    it('answers a project it cannot read with the reason, and checks nothing', async () => {
        const result = await checkApiRefusals({ tsconfig: `${FIXTURE}/missing.json` });
        expect(result).toMatchObject({ ok: false, handlers: 0, findings: [] });
        expect(result.lines[0]).toMatch(/could not be read/);
    });

    it('fails a project in which it finds no handler to check, rather than passing it', async () => {
        const result = await checkApiRefusals({ tsconfig: `${FIXTURE}/tsconfig.json`, files: [`${FIXTURE}/vocabulary.ts`] });
        expect(result).toMatchObject({ ok: false, handlers: 0, findings: [] });
        expect(result.lines[0]).toMatch(/no handler Lambder hands a typed refuse was found, so nothing was checked/);
    }, COMPILER_TIMEOUT_MS);
});
