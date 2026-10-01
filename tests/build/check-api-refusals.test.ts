/**
 * lambder/build: checkApiRefusals, every refusal a handler can reach held to
 * the codes its endpoint may send.
 *
 * The project is tests/fixtures/refusal-app: an app whose endpoints, guards
 * and mock entries each reach their refusals one way (their own ctx.refuse, a
 * helper, a class's method, a refusal class of the app's own, a function
 * handed along, a module loaded with import(), a handler wrapped or held in
 * an object), several of them wrongly on purpose. Every call compiles the
 * project with the TypeScript compiler, so these take a second or two.
 */

import { describe, it, expect } from 'vitest';
import { relative } from 'node:path';
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
        // The guards, the endpoints and the mock entries of the fixture, each checked.
        expect(result.handlers).toBe(16);
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
            { handler: 'orders.settle', problem: 'undeclared', code: 'wallet-short', raisedAt: at('server.ts', 64) },
            // A handler the app wraps, followed through the wrapper's argument.
            { handler: 'orders.hold', problem: 'undeclared', code: 'order-missing', raisedAt: at('helpers.ts', 9) },
            // A handler held in an object, followed through the property.
            { handler: 'orders.drop', problem: 'undeclared', code: 'order-closed', raisedAt: at('helpers.ts', 12) },
            // A mock entry, held to what the contract gives its endpoint.
            { handler: 'orders.cancel', problem: 'undeclared', code: 'wallet-short', raisedAt: at('mock.ts', 11) },
        ]);
        // orders.get reaches exactly its two codes, one through a constant, and staffOnly and the other mock entry exactly theirs.
        expect(result.findings.map((finding) => finding.handler)).not.toContain('orders.get');
        expect(result.findings.map((finding) => finding.handler)).not.toContain('staffOnly');
        expect(result.lines[0]).toMatch(/^✗ 14 refusal findings in 12 of 16 handlers$/);
    }, COMPILER_TIMEOUT_MS);

    it('finds a declared code nothing reaches, a refusal with no code, one whose code cannot be told, and a handler it cannot follow', async () => {
        const result = await checkApiRefusals({ tsconfig: `${FIXTURE}/tsconfig.json` });
        expect(summaryOf(result.findings.filter((finding) => finding.problem !== 'undeclared'))).toEqual([
            { handler: 'openOrder', problem: 'unused', code: 'order-closed' },
            { handler: 'orders.list', problem: 'unused', code: 'wallet-short' },
            // Handed along to forEach rather than called: still reached.
            { handler: 'orders.archive', problem: 'uncoded', raisedAt: at('helpers.ts', 21) },
            { handler: 'orders.tag', problem: 'unreadable', raisedAt: at('helpers.ts', 31) },
            // Registered inside the app's own wrapper, where the handler is a parameter: a finding, never a pass.
            { handler: 'defineApi', problem: 'untraced' },
        ]);
        expect(result.lines.some((line) => line.includes('orders.archive') && line.includes('no code'))).toBe(true);
    }, COMPILER_TIMEOUT_MS);

    it('lets a refusal with no code pass for an app that does not require codes', async () => {
        const result = await checkApiRefusals({ tsconfig: `${FIXTURE}/tsconfig.json`, requireCodes: false });
        expect(result.findings.some((finding) => finding.problem === 'uncoded')).toBe(false);
        expect(result.findings.some((finding) => finding.problem === 'undeclared')).toBe(true);
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
