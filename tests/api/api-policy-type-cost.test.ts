/**
 * What an API's `guards` and `rateLimit` options cost the compiler as an app
 * grows. An instance's guards and policies may read fields of an API's input
 * (an apiInput guard, a policy keyed by an apiInput slice), and whether an
 * API's input carries those fields is a question about that API alone. If the
 * option's constraint asks it of every name the instance declares while the
 * API's input is still being inferred, every API pays for every keyed
 * declaration of the whole app, and the cost grows exponentially with them.
 *
 * So the same set of APIs is compiled twice, on an instance whose ten guards
 * and ten policies read the input and on one whose same-named guards and
 * policies do not, and the two must cost about the same. The fixture lives in
 * memory, under a path inside tests/ so that it resolves this package's
 * source and dependencies; nothing is written to disk. Each case builds a
 * program over the package's source, so these take seconds.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const COMPILER_TIMEOUT_MS = 120_000;
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_FILE = join(REPO_ROOT, 'tests/fixtures/type-cost/app.ts');

const KEYED_DECLARATIONS = 10;
const API_COUNT = 40;

/**
 * An app with ten guards, ten policies and forty session APIs, each API's
 * input carrying every field a keyed guard or policy reads. Every other API
 * declares one guard and one policy; the rest declare neither, since the cost
 * this guards against fell on those too. The APIs are registered one
 * statement each, so the count is the options' cost and not a chain's.
 */
const fixtureSource = (keyed: boolean): string => {
    const indices = Array.from({ length: KEYED_DECLARATIONS }, (_, index) => index);
    const guards = indices.map((index) => keyed
        ? `        g${index}: lambderGuard({ apiInput: z.object({ f${index}: z.string() }), handler: async () => ({}) }),`
        : `        g${index}: lambderGuard({ handler: async () => ({}) }),`);
    const policies = indices.map((index) => keyed
        ? `            p${index}: { perMin: 5, per: lambderRateLimitKey({ apiInput: z.object({ f${index}: z.string() }), handler: (_ctx, payload) => payload.f${index} }) },`
        : `            p${index}: { perMin: 5, per: "ip" },`);
    const fields = indices.map((index) => `f${index}: z.string()`).join(', ');
    const apis = Array.from({ length: API_COUNT }, (_, index) => index % 2 === 0
        ? `app.addSessionApi("api.${index}", { input, output, guards: "g${index % KEYED_DECLARATIONS}", rateLimit: "p${(index + 1) % KEYED_DECLARATIONS}" }, async () => ({ ok: true }));`
        : `app.addSessionApi("api.${index}", { input, output }, async () => ({ ok: true }));`);
    return [
        `import { z } from "zod";`,
        `import { initLambder, lambderGuard, lambderRateLimitKey, LambderMemoryRateLimiter, LambderMemorySessionStore } from "../../../src/index.js";`,
        ``,
        `const app = initLambder<{ userId: string }>().create({`,
        `    apiPath: "/api",`,
        `    session: { store: new LambderMemorySessionStore(), sessionSalt: "salt" },`,
        `    guards: {`,
        ...guards,
        `    },`,
        `    rateLimits: {`,
        `        limiter: new LambderMemoryRateLimiter(),`,
        `        policies: {`,
        ...policies,
        `        },`,
        `    },`,
        `});`,
        ``,
        `const input = z.object({ id: z.string(), ${fields} });`,
        `const output = z.object({ ok: z.boolean() });`,
        ``,
        ...apis,
        ``,
    ].join('\n');
};

/** The fixture checked under the package's own compiler options: its diagnostics, and the type instantiations checking it took. */
const checkFixture = (source: string): { instantiations: number; diagnostics: string[] } => {
    const config = ts.readConfigFile(join(REPO_ROOT, 'tsconfig.json'), ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT);
    const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, declaration: false, rootDir: REPO_ROOT };
    const host = ts.createCompilerHost(options);
    const isFixture = (fileName: string) => ts.sys.resolvePath(fileName) === FIXTURE_FILE;
    const readFromDisk = host.getSourceFile.bind(host);
    const fileExistsOnDisk = host.fileExists.bind(host);
    const readFileFromDisk = host.readFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, ...rest) =>
        isFixture(fileName) ? ts.createSourceFile(fileName, source, languageVersion, true) : readFromDisk(fileName, languageVersion, ...rest);
    host.fileExists = (fileName) => isFixture(fileName) || fileExistsOnDisk(fileName);
    host.readFile = (fileName) => isFixture(fileName) ? source : readFileFromDisk(fileName);
    const program = ts.createProgram([FIXTURE_FILE], options, host);
    const file = program.getSourceFile(FIXTURE_FILE);
    if (!file) throw new Error('The type-cost fixture did not load.');
    const diagnostics = [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)]
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    return { instantiations: program.getInstantiationCount(), diagnostics };
};

describe('The guards and rateLimit options cost the same whether the instance\'s declarations read an API\'s input or not', () => {
    it('keeps an app\'s APIs as cheap to check with ten keyed guards and ten keyed policies as with plain ones', () => {
        const keyed = checkFixture(fixtureSource(true));
        const plain = checkFixture(fixtureSource(false));
        expect(keyed.diagnostics).toEqual([]);
        expect(plain.diagnostics).toEqual([]);
        // The keyed instance carries twenty more object schemas, so it may
        // cost a little more; an exponential in the keyed declarations is
        // many times the plain count.
        expect(keyed.instantiations).toBeLessThan(plain.instantiations * 1.5);
    }, COMPILER_TIMEOUT_MS);
});
