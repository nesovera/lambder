/**
 * lambder/build's one call over every file a script names: each app's
 * module given once, every file written or checked, a failing writer
 * reported beside the others rather than stopping them, and a config the
 * call cannot read refused.
 *
 * Files are written under the system's temporary directory, never into the
 * repository. A contract is printed in a Node process of its own, started
 * from the built package's entry, so those cases run a generator script over
 * the built package (`dist`, which `npm test` builds ahead of the suite).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { lambderGuard } from '../../src/core/LambderPolicyBuilders.js';
import { generateApiFiles, writeApiContract, type LambderApiFilesConfig } from '../../src/build.js';

const directory = mkdtempSync(join(tmpdir(), 'lambder-generate-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

let caseCount = 0;
/** A directory of its own per case. */
const nextCase = () => {
    const root = join(directory, `case-${caseCount++}`);
    mkdirSync(root);
    return root;
};

/** A store app; `withRefund` adds an endpoint, which moves every file. */
const storeApp = (withRefund: boolean) => {
    const app = initLambder().create({
        apiPath: '/api',
        guards: { staff: lambderGuard({ handler: (_ctx, _payload, _need: 'ORDERS.MANAGE' | 'ORDERS.VIEW') => {} }) },
    });
    return app.registerApiGroups(app.defineApiGroup('orders', {
        list: app.defineApi({ input: z.object({}), output: z.object({ count: z.number() }), guards: { staff: 'ORDERS.VIEW' } }, async () => ({ count: 0 })),
        ...(withRefund ? { refund: app.defineApi({ input: z.object({ orderId: z.string() }), output: z.object({ ok: z.boolean() }), guards: { staff: 'ORDERS.MANAGE' } }, async () => ({ ok: true })) } : {}),
    }));
};

/** The app as a module the writers import: a plain-JS stand-in reporting what the instance reports, so no loader is needed. */
const writeInstanceModule = async (root: string, withRefund: boolean) => {
    const app = storeApp(withRefund);
    writeFileSync(join(root, 'instance.mjs'), [
        `const entries = ${JSON.stringify(await app.apiOptionEntries())};`,
        `const signatures = ${JSON.stringify(await app.apiSignatureEntries())};`,
        'export const lambder = { apiOptionEntries: async () => entries, apiSignatureEntries: async () => signatures };',
        '',
    ].join('\n'));
};

/** The store app's files, relative to the case's directory: no fresh-process verification, since the stand-in digests nothing. */
const storeConfig = (root: string): LambderApiFilesConfig => ({
    apps: {
        store: {
            module: join(root, 'instance.mjs'),
            exportName: 'lambder',
            signatures: { file: join(root, 'apiSignatures.generated.ts'), verifyInFreshProcess: false },
            options: { file: join(root, 'apiOptions.generated.ts') },
            guardParams: [{ guard: 'staff', file: join(root, 'staffGuardParams.generated.ts') }],
        },
    },
});

describe('generateApiFiles', () => {
    it('writes every file of an app from its module, given once, and then finds them current', async () => {
        const root = nextCase();
        await writeInstanceModule(root, false);

        const written = await generateApiFiles(storeConfig(root));
        expect(written.ok).toBe(true);
        expect(written.lines.filter((line) => line.startsWith('✓ Wrote'))).toHaveLength(3);
        expect(readFileSync(join(root, 'staffGuardParams.generated.ts'), 'utf8')).toContain('export const ordersListGuardParam = "ORDERS.VIEW" as const');

        const checked = await generateApiFiles(storeConfig(root), { check: true });
        expect(checked).toMatchObject({ ok: true });
        expect(checked.lines.every((line) => line.startsWith('✓'))).toBe(true);
    });

    it('names every stale file on a check, and writes none of them', async () => {
        const root = nextCase();
        await writeInstanceModule(root, false);
        await generateApiFiles(storeConfig(root));
        const before = readFileSync(join(root, 'apiOptions.generated.ts'), 'utf8');

        // A new module, so the check does not read the first one back from Node's module cache.
        const moved = join(root, 'moved');
        mkdirSync(moved);
        await writeInstanceModule(moved, true);
        const config = storeConfig(root);
        config.apps.store!.module = join(moved, 'instance.mjs');
        const checked = await generateApiFiles(config, { check: true });

        expect(checked.ok).toBe(false);
        expect(checked.lines.filter((line) => line.startsWith('✗')).map((line) => line.replace(root, '<root>'))).toEqual([
            '✗ <root>/apiSignatures.generated.ts is stale: regenerate it',
            '✗ <root>/apiOptions.generated.ts is stale: regenerate it',
            '✗ <root>/staffGuardParams.generated.ts is stale: regenerate it',
        ]);
        expect(readFileSync(join(root, 'apiOptions.generated.ts'), 'utf8')).toBe(before);
    });

    it('reports a writer that fails beside the others, which still run', async () => {
        const root = nextCase();
        await writeInstanceModule(root, false);
        const config = storeConfig(root);
        config.apps.store!.guardParams = [{ guard: 'manager', file: join(root, 'managerGuardParams.generated.ts') }];

        const result = await generateApiFiles(config);
        expect(result.ok).toBe(false);
        expect(result.lines).toContainEqual(expect.stringMatching(/^✗ store: the "manager" guard parameters failed: writeApiGuardParams: the server declares no guard "manager"/));
        expect(result.lines.filter((line) => line.startsWith('✓ Wrote'))).toHaveLength(2);
    });

    it('refuses a config it cannot read, naming what is wrong', async () => {
        await expect(generateApiFiles({ apps: {} })).rejects.toThrow(/names no apps/);
        await expect(generateApiFiles({ apps: { store: { module: 'x.mjs' } } })).rejects.toThrow(/"store" is written to no file/);
        await expect(generateApiFiles({ apps: { store: { module: 'x.mjs', options: { file: 'o.ts' }, signature: {} } as never } })).rejects.toThrow(/"store" has "signature", which the generator does not read/);
    });

    it('refuses a contract heap that is not a whole number of megabytes, before writing anything', async () => {
        const root = nextCase();
        for(const contractHeapMegabytes of [0, -1024, 1.5, Number.NaN]){
            await expect(generateApiFiles(storeConfig(root), { contractHeapMegabytes }))
                .rejects.toThrow(`generateApiFiles: contractHeapMegabytes is ${contractHeapMegabytes}; give the heap of the process each contract is printed in as a whole number of megabytes, such as 8192.`);
        }
        expect(() => readFileSync(join(root, 'apiOptions.generated.ts'))).toThrow();
    });
});

describe('generateApiFiles prints each contract in a process of its own', () => {
    const COMPILER_TIMEOUT_MS = 120_000;
    const buildEntry = pathToFileURL(new URL('../../dist/build.js', import.meta.url).pathname).href;
    /** Too small a heap for the compiler to read even a one-API contract in, and enough for a generator script that only starts processes. */
    const SMALL_HEAP = '--max-old-space-size=16';

    /** A project holding one contract module under a tsconfig of its own, with only the default library. */
    const contractProject = (source: string) => {
        const root = nextCase();
        writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, lib: ['ES2022'], types: [] } }));
        writeFileSync(join(root, 'contract.ts'), source);
        return root;
    };
    const STORE_CONTRACT = 'declare const lambder: { readonly ApiContract: { "orders.get": { input: { orderId: string }; output: { total: number } } } };\nexport default lambder;\n';

    /**
     * A generator script over the built package, run in this process's
     * working directory with the Node flags given, as an app runs its own:
     * it calls generateApiFiles with the config and options given as JSON,
     * and prints the result.
     */
    const runGenerator = (root: string, config: LambderApiFilesConfig, options: object, nodeFlags: string[] = []) => {
        const script = join(root, 'generate.mjs');
        writeFileSync(script, [
            `import { generateApiFiles } from ${JSON.stringify(buildEntry)};`,
            `const result = await generateApiFiles(${JSON.stringify(config)}, ${JSON.stringify(options)});`,
            'process.stdout.write(JSON.stringify(result));',
        ].join('\n'));
        const child = spawnSync(process.execPath, [...nodeFlags, script], { encoding: 'utf8' });
        expect(child.status, child.stderr).toBe(0);
        return JSON.parse(child.stdout) as { ok: boolean; lines: string[] };
    };

    it('prints with a heap of its own, whatever heap the script runs with and without the script\'s loader', () => {
        const root = contractProject(STORE_CONTRACT);
        const config: LambderApiFilesConfig = { apps: { store: { module: join(root, 'contract.ts'), contract: { file: join(root, 'contract.generated.ts') } } } };
        // A loader the printing process must not be started with: it throws there.
        const loader = ['--import', 'data:text/javascript,if(process.argv[1]?.endsWith("contractPrinterProcess.js"))throw new Error("the script\'s loader reached the printing process")'];

        // The heap the script runs with is too small to print in.
        const inScript = join(root, 'print-here.mjs');
        writeFileSync(inScript, `import { writeApiContract } from ${JSON.stringify(buildEntry)};\nawait writeApiContract(${JSON.stringify({ module: join(root, 'contract.ts'), file: join(root, 'unused.generated.ts') })});\n`);
        const printedHere = spawnSync(process.execPath, [SMALL_HEAP, inScript], { encoding: 'utf8' });
        expect(printedHere.status).not.toBe(0);
        expect(printedHere.stderr).toMatch(/JavaScript heap out of memory/);

        const written = runGenerator(root, config, {}, [SMALL_HEAP, ...loader]);
        expect(written).toEqual({ ok: true, lines: [`✓ Wrote ${join(root, 'contract.generated.ts')} (1 APIs)`, '  0 changed, 1 added, 0 removed (0 unchanged)', '  + orders.get'] });
        expect(readFileSync(join(root, 'contract.generated.ts'), 'utf8')).toContain('"orders.get": {');
        expect(runGenerator(root, config, { check: true }, [SMALL_HEAP, ...loader]))
            .toEqual({ ok: true, lines: [`✓ ${join(root, 'contract.generated.ts')} matches the 1 APIs of ApiContractType`] });
    }, COMPILER_TIMEOUT_MS);

    it('answers what writeApiContract answers, a contract it could not read and what it threw included', async () => {
        const root = contractProject('const total: number = "none";\nexport default { ApiContract: {} };\n');
        const broken = { module: join(root, 'contract.ts'), file: join(root, 'contract.generated.ts') };
        // A file URL naming another host, which no path stands for: writeApiContract throws on it.
        const elsewhere = { module: 'file://elsewhere/contract.ts', file: join(root, 'elsewhere.generated.ts') };
        const result = runGenerator(root, { apps: { broken: { module: broken.module, contract: { file: broken.file } }, elsewhere: { module: elsewhere.module, contract: { file: elsewhere.file } } } }, {});

        const thrown = await writeApiContract(elsewhere).then(() => null, (err: Error) => err.message);
        expect(thrown).toBeTruthy();
        expect(result).toEqual({
            ok: false,
            lines: [...(await writeApiContract(broken)).lines, `✗ elsewhere: the contract failed: ${thrown}`],
        });
        expect(result.lines[0]).toMatch(/the module does not compile$/);
    }, COMPILER_TIMEOUT_MS);

    it('reports a printing process that runs out of its heap, and still runs the other writers', () => {
        const root = contractProject(STORE_CONTRACT);
        writeFileSync(join(root, 'instance.mjs'), 'export default { apiOptionEntries: async () => ({ apis: {}, rateLimitPolicies: {}, guards: {} }) };\n');
        const result = runGenerator(root, {
            apps: {
                store: { module: join(root, 'contract.ts'), contract: { file: join(root, 'contract.generated.ts') } },
                shop: { module: join(root, 'instance.mjs'), options: { file: join(root, 'apiOptions.generated.ts') } },
            },
        }, { contractHeapMegabytes: 16 });
        expect(result.ok).toBe(false);
        expect(result.lines[0]).toBe('✗ store: the contract failed: the process printing it ran out of its 16 MB heap; raise contractHeapMegabytes');
        expect(result.lines).toContainEqual(expect.stringMatching(/^✓ Wrote .*apiOptions\.generated\.ts/));
    }, COMPILER_TIMEOUT_MS);
});
