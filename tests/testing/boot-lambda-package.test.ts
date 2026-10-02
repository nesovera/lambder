/**
 * lambder/testing: a built deployment package booted in a fresh process.
 *
 * Every package here is written under the system's temporary directory and
 * booted for real, in a child node process. The Lambder app package imports
 * the built framework (`dist`, which `npm test` builds ahead of the suite)
 * and zod by their file URLs, as a bundle carries what it imports: a bare
 * import of either would be held to the package, which carries neither.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertApiFailure, assertApiSuccess, bootLambdaPackage, LAMBDER_REFUSAL_CODES } from '../../src/testing.js';
import type { LambdaPackageBootSetup } from '../../src/testing/lambdaPackageBootProcess.js';

const root = mkdtempSync(join(tmpdir(), 'lambder-boot-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let directoryCount = 0;
/** A fresh directory under the temporary root holding these files, by path relative to it. */
const writeTree = (files: Record<string, string>): string => {
    const directory = join(root, `tree-${directoryCount++}`);
    for(const [path, content] of Object.entries(files)){
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), content);
    }
    mkdirSync(directory, { recursive: true });
    return directory;
};

const distUrl = new URL('../../dist/index.js', import.meta.url).href;
const zodUrl = new URL('../../node_modules/zod/index.js', import.meta.url).href;

/** A module a runtime supplies, answering where it was loaded from, under ESM and CommonJS alike. */
const runtimeModule = (where: string) => ({
    'node_modules/@aws-sdk/client-example/package.json': JSON.stringify({
        name: '@aws-sdk/client-example',
        exports: { import: './index.mjs', require: './index.cjs' },
    }),
    'node_modules/@aws-sdk/client-example/index.mjs': `export const where = ${JSON.stringify(`${where}, imported`)};\n`,
    'node_modules/@aws-sdk/client-example/index.cjs': `exports.where = ${JSON.stringify(`${where}, required`)};\n`,
});

describe('bootLambdaPackage', () => {
    it('boots a Lambder app package and answers its API calls, measuring the import', async () => {
        const packageDir = writeTree({
            'package.json': JSON.stringify({ type: 'module' }),
            'index.js': [
                `import { initLambder } from ${JSON.stringify(distUrl)};`,
                `import { z } from ${JSON.stringify(zodUrl)};`,
                'const app = initLambder().create({ apiPath: "/api" });',
                'export const lambder = app.registerApiGroups(app.defineApiGroup("greeting", {',
                '    hello: app.defineApi({ input: z.object({ name: z.string() }), output: z.object({ text: z.string() }) },',
                '        async (ctx) => ({ text: `${process.env.GREETING}, ${ctx.apiPayload.name}` })),',
                '}));',
                'export const handler = lambder.getHandler();',
            ].join('\n'),
        });

        const boot = await bootLambdaPackage({
            packageDir,
            calls: [{ api: 'greeting.hello', payload: { name: 'Ada' } }, { api: 'greeting.missing' }],
            env: { GREETING: 'Hello' },
        });

        expect(boot.ok, boot.error).toBe(true);
        expect(boot.phase).toBeUndefined();
        expect(boot.calls.map((call) => [call.name, call.status])).toEqual([['greeting.hello', 200], ['greeting.missing', 200]]);
        const greeting = boot.calls[0]!.outcome!;
        assertApiSuccess(greeting);
        expect(greeting.payload).toEqual({ text: 'Hello, Ada' });
        const missing = boot.calls[1]!.outcome!;
        assertApiFailure(missing, 'refusal', { code: LAMBDER_REFUSAL_CODES.apiNotFound });
        expect(boot.measurements!.importMs).toBeGreaterThanOrEqual(0);
        expect(boot.measurements!.rssBytes).toBeGreaterThan(0);
    });

    it('reports the import phase when the handler module throws while loading', async () => {
        const packageDir = writeTree({ 'index.mjs': 'throw new Error("the bundle needs a file it does not carry");\nexport const handler = async () => null;\n' });

        const boot = await bootLambdaPackage({ packageDir, calls: [{ event: {} }] });

        expect(boot.ok).toBe(false);
        expect(boot.phase).toBe('import');
        expect(boot.error).toMatch(/^importing index\.mjs failed:\nError: the bundle needs a file it does not carry/);
        expect(boot.calls).toEqual([]);
        expect(boot.measurements).toBeUndefined();
    });

    it('reports the handler phase and names the call when the handler throws, keeping the answers before it', async () => {
        const packageDir = writeTree({
            'index.mjs': 'export const handler = async (event) => { if(event.fail) throw new Error("no such order"); return { seen: event.n }; };\n',
        });

        const boot = await bootLambdaPackage({
            packageDir,
            calls: [{ event: { n: 1 } }, { event: { fail: true }, name: 'the failing order' }, { event: { n: 3 } }],
        });

        expect(boot.ok).toBe(false);
        expect(boot.phase).toBe('handler');
        expect(boot.failedCall).toBe('the failing order');
        expect(boot.error).toMatch(/^call 1 \(the failing order\) threw:\nError: no such order/);
        expect(boot.calls).toEqual([{ name: 'event 0', returned: { seen: 1 } }]);
        expect(boot.measurements).toBeDefined();
    });

    it('reports a call that runs past its time, and a process that dies during a call', async () => {
        const packageDir = writeTree({
            'index.mjs': 'export const handler = (event) => event.exit ? process.exit(3) : new Promise(() => {});\n',
        });

        const stalled = await bootLambdaPackage({ packageDir, calls: [{ event: {} }], callTimeoutMs: 300 });
        expect(stalled.phase).toBe('handler');
        expect(stalled.error).toBe('call 0 (event 0) did not finish within 300 ms');

        const died = await bootLambdaPackage({ packageDir, calls: [{ event: { exit: true }, name: 'exit' }] });
        expect(died.phase).toBe('handler');
        expect(died.error).toMatch(/^call 0 \(exit\) the process exited with code 3/);
    });

    it('resolves what the runtime supplies from the given directory, for import and require alike', async () => {
        const runtimeDir = writeTree(runtimeModule('the runtime'));
        const packageDir = writeTree({
            'index.mjs': [
                'import { where } from "@aws-sdk/client-example";',
                'import { required } from "./required.cjs";',
                'export const handler = async () => ({ where, required });',
            ].join('\n'),
            'required.cjs': 'exports.required = require("@aws-sdk/client-example").where;\n',
        });

        const boot = await bootLambdaPackage({ packageDir, runtimeModulesFrom: runtimeDir, calls: [{ event: {} }] });

        expect(boot.ok, boot.error).toBe(true);
        expect(boot.calls[0]!.returned).toEqual({ where: 'the runtime, imported', required: 'the runtime, required' });
    });

    it('prefers a runtime module the package carries, as Lambda does', async () => {
        const runtimeDir = writeTree(runtimeModule('the runtime'));
        const packageDir = writeTree({
            ...runtimeModule('the package'),
            'index.mjs': 'import { where } from "@aws-sdk/client-example";\nexport const handler = async () => where;\n',
        });

        const boot = await bootLambdaPackage({ packageDir, runtimeModulesFrom: runtimeDir, calls: [{ event: {} }] });

        expect(boot.calls[0]!.returned).toBe('the package, imported');
    });

    it('fails the import when the runtime directory lacks a runtime module, naming the directory', async () => {
        const emptyRuntimeDir = writeTree({ 'package.json': '{}' });
        const packageDir = writeTree({ 'index.mjs': 'import "@aws-sdk/client-example";\nexport const handler = async () => null;\n' });

        const boot = await bootLambdaPackage({ packageDir, runtimeModulesFrom: emptyRuntimeDir });

        expect(boot.phase).toBe('import');
        expect(boot.error).toContain(`"@aws-sdk/client-example" is supplied by the Lambda runtime, so the package leaves it out, and it resolves from ${emptyRuntimeDir} instead, where it is not installed either`);
    });

    it('holds every other import to the package, even where the directory sits in an install that has it', async () => {
        const project = writeTree({
            'node_modules/left-behind/package.json': JSON.stringify({ name: 'left-behind', main: 'index.js' }),
            'node_modules/left-behind/index.js': 'module.exports = "found outside";\n',
            'shared/helper.mjs': 'export const helper = 1;\n',
            'build/bare/index.mjs': 'import "left-behind";\nexport const handler = async () => null;\n',
            'build/relative/index.mjs': 'import "../../shared/helper.mjs";\nexport const handler = async () => null;\n',
            'build/required/index.cjs': 'require("left-behind");\nexports.handler = async () => null;\n',
        });

        for(const [name, specifier] of [['bare', 'left-behind'], ['relative', '../../shared/helper.mjs'], ['required', 'left-behind']] as const){
            const boot = await bootLambdaPackage({ packageDir: join(project, 'build', name) });
            expect(boot.phase, name).toBe('import');
            expect(boot.error, name).toContain(`"${specifier}", imported by ${realpathSync(join(project, 'build', name))}`);
            expect(boot.error, name).toContain('is not in the package');
        }
    });

    it('gives the process the package as its working directory, the node flags it is told, and of this environment only PATH', async () => {
        process.env.LAMBDER_BOOT_TEST_LEAK = 'leaked';
        try {
            const packageDir = writeTree({
                'app/main.cjs': 'exports.run = async () => ({ cwd: process.cwd(), env: Object.keys(process.env).sort(), execArgv: process.execArgv });\n',
            });

            const boot = await bootLambdaPackage({
                packageDir,
                handler: 'app/main.run',
                env: { FUNCTION_SETTING: 'on' },
                nodeFlags: ['--max-old-space-size=200'],
                calls: [{ event: { source: 'aws.events' } }],
            });

            expect(boot.ok, boot.error).toBe(true);
            const seen = boot.calls[0]!.returned as { cwd: string; env: string[]; execArgv: string[] };
            expect(seen.cwd).toBe(realpathSync(packageDir));
            expect(seen.execArgv).toEqual(['--max-old-space-size=200']);
            expect(seen.env).toEqual(expect.arrayContaining(['FUNCTION_SETTING', 'PATH']));
            // The operating system may add its own (macOS does), so the
            // check is that this process's, the runner's included, stay out.
            expect(process.env.NODE_ENV).toBe('test');
            expect(seen.env).not.toContain('NODE_ENV');
            expect(seen.env).not.toContain('LAMBDER_BOOT_TEST_LEAK');
        } finally {
            delete process.env.LAMBDER_BOOT_TEST_LEAK;
        }
    });

    it('ends the process when the one that started it goes away, whatever the package keeps running', async () => {
        const packageDir = realpathSync(writeTree({ 'index.mjs': 'setInterval(() => {}, 1000);\nexport const handler = async () => null;\n' }));
        const setup: LambdaPackageBootSetup = {
            handlerUrl: pathToFileURL(join(packageDir, 'index.mjs')).href,
            handlerExport: 'handler',
            packageUrl: `${pathToFileURL(packageDir).href}/`,
            runtimeModules: [],
            runtimeModulesFrom: packageDir,
            callTimeoutMs: 1000,
        };
        const entry = fileURLToPath(new URL('../../src/testing/lambdaPackageBootProcess.ts', import.meta.url));
        const child = fork(entry, [JSON.stringify(setup)], { cwd: packageDir, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        await new Promise((resolve) => child.once('message', resolve));
        const exited = new Promise((resolve) => child.once('exit', resolve));

        // The channel closing is what the process sees of a parent that died.
        child.disconnect();
        expect(await exited).toBe(1);
    });

    it('throws for what is not the package\'s doing, rather than booting', async () => {
        const packageDir = writeTree({ 'index.mjs': 'export const main = async () => null;\nexport const version = 1;\n' });

        await expect(bootLambdaPackage({ packageDir: join(root, 'not-built') })).rejects.toThrow(/packageDir .*not-built is not a directory/);
        await expect(bootLambdaPackage({ packageDir, handler: 'handler' })).rejects.toThrow('handler "handler" is not a module and an export');
        await expect(bootLambdaPackage({ packageDir, handler: 'app.handler' })).rejects.toThrow(/found no app\.js, app\.mjs or app\.cjs in .* for the handler "app\.handler"/);
        await expect(bootLambdaPackage({ packageDir })).rejects.toThrow('index.mjs exports no function "handler" (it exports main, version)');
        await expect(bootLambdaPackage({ packageDir, handler: 'index.main', calls: [{ api: 'notAnEndpoint' }] })).rejects.toThrow('"notAnEndpoint" is not an endpoint name');
        await expect(bootLambdaPackage({ packageDir, handler: 'index.main', calls: [{} as never] })).rejects.toThrow('call 0 is neither { api } nor { event }');
        await expect(bootLambdaPackage({ packageDir, handler: 'index.main', runtimeModules: ['./local'] })).rejects.toThrow('runtimeModules entry "./local" is not a package name or a scope');
        await expect(bootLambdaPackage({ packageDir, handler: 'index.main', runtimeModulesFrom: join(root, 'no-install') })).rejects.toThrow(/runtimeModulesFrom .*no-install is not a directory/);
        await expect(bootLambdaPackage({ packageDir, handler: 'index.main', callTimeoutMs: 0 })).rejects.toThrow('callTimeoutMs must be a positive integer');
    });
});
