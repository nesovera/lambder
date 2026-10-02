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
 *
 * And what registering endpoints costs as an app grows: every endpoint is
 * typed on its own and the contract is one mapped type over the groups, so
 * eight hundred endpoints must cost what four times two hundred do, not the
 * square. And the checks that walk a registration's groups, or a group's
 * parts, one by one (a name given twice, an action two parts declare) must
 * hold for an app of many small groups as well as for one of a few large
 * ones, still naming what they refuse.
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
 * An app with ten guards, ten policies and forty APIs, each API's input
 * carrying every field a keyed guard or policy reads. Every other API
 * declares one guard and one policy; the rest declare neither, since the cost
 * this guards against fell on those too. The APIs are declared one statement
 * each and registered as one group, so the count is the options' cost.
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
        ? `const api${index} = app.defineApi({ input, output, guards: "g${index % KEYED_DECLARATIONS}", rateLimit: "p${(index + 1) % KEYED_DECLARATIONS}" }, async () => ({ ok: true }));`
        : `const api${index} = app.defineApi({ input, output }, async () => ({ ok: true }));`);
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
        `export const lambder = app.registerApiGroups(app.defineApiGroup("t", { ${Array.from({ length: API_COUNT }, (_, index) => `api${index}`).join(', ')} }));`,
        ``,
    ].join('\n');
};

/**
 * An app of `endpoints` endpoints in groups of `groupSize` (twenty-five unless
 * a case says otherwise), registered in one registerApiGroups() call, with
 * what an app's endpoints declare: an input and an output of their own, a
 * guard that needs a session or one that does not, a rate limit, a handler
 * reading its payload and its session. The client reads the contract, as a
 * typed caller does. `registeredTwice` names a group the call gives a second
 * time.
 */
const registrationSource = (endpoints: number, { groupSize = 25, registeredTwice }: { groupSize?: number; registeredTwice?: number } = {}): string => {
    const groups = Math.ceil(endpoints / groupSize);
    const endpoint = (index: number) => index % 2 === 0
        ? `        e${index}: app.defineApi({ input: z.object({ id: z.string(), n${index}: z.number() }), output: z.object({ ok: z.boolean(), v${index}: z.string() }), guards: "signedIn", rateLimit: "perSession" }, async (ctx) => ({ ok: ctx.apiPayload.n${index} > 0, v${index}: ctx.session.data.userId })),`
        : `        e${index}: app.defineApi({ input: z.object({ id: z.string(), n${index}: z.number() }), output: z.object({ ok: z.boolean(), v${index}: z.string() }), guards: "anyone", rateLimit: "perIp" }, async (ctx) => ({ ok: ctx.apiPayload.n${index} > 0, v${index}: ctx.apiPayload.id })),`;
    const lines = [
        `import { z } from "zod";`,
        `import { initLambder, lambderGuard, LambderMemoryRateLimiter, LambderMemorySessionStore } from "../../../src/index.js";`,
        ``,
        `const app = initLambder<{ userId: string }>().create({`,
        `    apiPath: "/api",`,
        `    session: { store: new LambderMemorySessionStore(), sessionSalt: "salt" },`,
        `    guards: {`,
        `        signedIn: lambderGuard({ session: true, handler: async () => {} }),`,
        `        anyone: lambderGuard({ handler: async () => {} }),`,
        `    },`,
        `    rateLimits: { limiter: new LambderMemoryRateLimiter(), policies: { perIp: { perMin: 5, per: "ip" }, perSession: { perMin: 5, per: "session" } } },`,
        `});`,
        ``,
    ];
    for(let group = 0; group < groups; group += 1){
        const indices = Array.from({ length: groupSize }, (_, offset) => group * groupSize + offset).filter((index) => index < endpoints);
        lines.push(`const group${group} = app.defineApiGroup("g${group}", {`, ...indices.map(endpoint), `});`);
    }
    lines.push(
        `export const lambder = app.registerApiGroups(${[...Array.from({ length: groups }, (_, group) => `group${group}`), ...(registeredTwice === undefined ? [] : [`group${registeredTwice}`])].join(', ')});`,
        `type Contract = typeof lambder.ApiContract;`,
        `export const read: Contract["g0.e0"]["input"] = { id: "a", n0: 1 };`,
        ``,
    );
    return lines.join('\n');
};

/**
 * A contract of forty endpoints over a refusal vocabulary of `codes` codes,
 * each endpoint declaring ten of them and every fourth code carrying data, as
 * an app that words its refusals declares them; and what a client reads of a
 * failure: its reason and its refusal, directly and in a caller's handlers.
 * `entry` is the module the fixture reads the client from.
 */
const refusalReadsSource = (codes: number, entry = '../../../src/client.js'): string => {
    const code = (index: number) => `C${index}`;
    const refusalEntry = (index: number) => `${code(index)}: ${index % 4 === 0 ? `{ data: { n${index}: number } }` : '{}'}`;
    const endpoints = Array.from({ length: 40 }, (_, endpoint) => {
        const declared = Array.from({ length: 10 }, (_, offset) => (endpoint * 10 + offset) % codes);
        return `    "g.e${endpoint}": { input: { id: string }; output: { ok: boolean }; refusals: { ${declared.map(refusalEntry).join('; ')} } };`;
    });
    return [
        `import { LambderCaller, type LambderApiFailure, type LambderApiOutcome, type LambderContractAnyRefusalMessage } from ${JSON.stringify(entry)};`,
        ``,
        `type Contract = {`,
        ...endpoints,
        `};`,
        `type Message = LambderContractAnyRefusalMessage<Contract>;`,
        ``,
        `declare const failure: LambderApiFailure<Message>;`,
        `export const reason = failure.reason;`,
        `export const code = failure.refusal?.code;`,
        `declare const outcome: LambderApiOutcome<unknown, Message>;`,
        `export const ok = outcome.ok;`,
        `export const refused = !outcome.ok && outcome.reason === "refusal" ? outcome.refusal.code : null;`,
        `export const caller = new LambderCaller<Contract>({`,
        `    fetchEndedHandler: ({ fetchResult }) => { if (!fetchResult.ok) void fetchResult.reason; },`,
        `    errorHandler: (error, failed) => { void error.message; void failed.refusal?.code; },`,
        `});`,
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

describe('What registering endpoints costs grows with the endpoints, no faster', () => {
    it('checks eight hundred endpoints for less than four times what two hundred cost', () => {
        // Linear, 800 costs four times 200's endpoints on top of what the app
        // costs before any endpoint, so under four times the whole. An
        // endpoint whose cost grew with the endpoints registered before it
        // would cost many times that.
        const small = checkFixture(registrationSource(200));
        const large = checkFixture(registrationSource(800));
        expect(small.diagnostics).toEqual([]);
        expect(large.diagnostics).toEqual([]);
        expect(large.instantiations).toBeLessThan(small.instantiations * 4);
    }, COMPILER_TIMEOUT_MS);
});

/**
 * One group declared in `parts` parts of two actions each, the way a group
 * spread across files is, with `repeatedAction` declared by a second part
 * too when a case names one.
 */
const groupPartsSource = (parts: number, repeatedAction?: string): string => {
    const lines = [
        `import { z } from "zod";`,
        `import { initLambder } from "../../../src/index.js";`,
        ``,
        `const app = initLambder().create({ apiPath: "/api" });`,
        `const endpoint = app.defineApi({ input: z.object({}), output: z.object({ ok: z.boolean() }) }, async () => ({ ok: true }));`,
        ``,
    ];
    for(let part = 0; part < parts; part += 1){
        lines.push(`const part${part} = { a${part}: endpoint, b${part}: endpoint${part === parts - 1 && repeatedAction ? `, ${repeatedAction}: endpoint` : ''} };`);
    }
    lines.push(
        `export const orders = app.defineApiGroup("orders", ${Array.from({ length: parts }, (_, part) => `part${part}`).join(', ')});`,
        `export const lambder = app.registerApiGroups(orders);`,
        `export const read: (typeof lambder.ApiContract)["orders.a0"]["input"] = {};`,
        ``,
    );
    return lines.join('\n');
};

describe('What an app of many small groups costs: the checks over the groups run as loops, not as nested recursion', () => {
    it('registers a hundred and fifty groups of two endpoints in one call', () => {
        expect(checkFixture(registrationSource(300, { groupSize: 2 })).diagnostics).toEqual([]);
    }, COMPILER_TIMEOUT_MS);

    it('still refuses a group given twice among them, naming it', () => {
        const { diagnostics } = checkFixture(registrationSource(300, { groupSize: 2, registeredTwice: 77 }));
        expect(diagnostics.join('\n')).toMatch(/lambder: these group names are registered twice[\s\S]*"g77"/);
    }, COMPILER_TIMEOUT_MS);

    it('declares one group in a hundred and fifty parts', () => {
        expect(checkFixture(groupPartsSource(150)).diagnostics).toEqual([]);
    }, COMPILER_TIMEOUT_MS);

    it('still refuses an action two of the parts declare, naming it', () => {
        const { diagnostics } = checkFixture(groupPartsSource(150, 'a12'));
        expect(diagnostics.join('\n')).toMatch(/lambder: these actions are declared by more than one part of the group[\s\S]*"a12"/);
    }, COMPILER_TIMEOUT_MS);
});

describe('What reading a failure costs as a contract\'s refusal vocabulary grows', () => {
    it('reads a failure\'s reason and refusal, and a caller\'s handlers read them, for a vocabulary of four hundred codes', () => {
        expect(checkFixture(refusalReadsSource(400)).diagnostics).toEqual([]);
    }, COMPILER_TIMEOUT_MS);
});

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
