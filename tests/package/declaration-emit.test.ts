/**
 * Declaration files of an app built on the package, as a consumer emits them.
 *
 * An app that emits declarations (`declaration: true`, or `composite` for a
 * build split into project references) has to name, in each of its own .d.ts
 * files, every type its exports were inferred as. A type the package's entry
 * does not export can be named only through a path the exports map refuses,
 * and the compiler stops with TS2883 ("cannot be named without a reference
 * to ... from lambder"). So every type a builder's signature names has to be
 * reachable from an entry, and this holds that.
 *
 * The sample app (tests/fixtures/declaration-app) imports `lambder` by name.
 * It is compiled in a temporary project whose node_modules holds a copy of
 * this package (its package.json and built dist), so the compiler meets the
 * package exactly as an installed dependency: through the exports map, with
 * the files inside a node_modules folder. Every other dependency is linked
 * to this repository's own. It reads `dist`, so `npm run build` has to have
 * run, as for package-exports.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const COMPILER_TIMEOUT_MS = 120_000;
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURE_APP = fileURLToPath(new URL('../fixtures/declaration-app', import.meta.url));

let project: string;

beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), 'lambder-declarations-'));
    const modules = join(project, 'node_modules');
    const installed = join(modules, 'lambder');
    mkdirSync(installed, { recursive: true });
    cpSync(join(PACKAGE_ROOT, 'package.json'), join(installed, 'package.json'));
    cpSync(join(PACKAGE_ROOT, 'dist'), join(installed, 'dist'), { recursive: true });
    for(const entry of readdirSync(join(PACKAGE_ROOT, 'node_modules'))){
        if(entry === '.bin' || entry === 'lambder') continue;
        symlinkSync(join(PACKAGE_ROOT, 'node_modules', entry), join(modules, entry));
    }
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'declaration-app', type: 'module', private: true }));
    cpSync(FIXTURE_APP, join(project, 'src'), { recursive: true });
});

afterAll(() => {
    if(project) rmSync(project, { recursive: true, force: true });
});

/** Every diagnostic of compiling the sample app with declaration emit on, the declarations themselves written to memory. */
const declarationDiagnostics = (): string[] => {
    const sources = readdirSync(join(project, 'src')).filter((name) => name.endsWith('.ts')).map((name) => join(project, 'src', name));
    const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: join(project, 'out'),
        rootDir: join(project, 'src'),
        skipLibCheck: true,
        lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
        types: ['node'],
    };
    const host = ts.createCompilerHost(options);
    host.writeFile = () => {};
    const program = ts.createProgram(sources, options, host);
    // The declaration diagnostics are among the pre-emit ones and the emit's
    // alike, so each is listed once.
    const diagnostics = [...ts.getPreEmitDiagnostics(program), ...program.emit().diagnostics];
    return [...new Set(diagnostics.map((diagnostic) => {
        const where = diagnostic.file && diagnostic.start !== undefined
            ? `${diagnostic.file.fileName.slice(project.length + 1)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1} `
            : '';
        return `${where}TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
    }))];
};

describe('declaration files of an app on lambder', () => {
    it('emit without an error: every type the builders name is exported by an entry', () => {
        expect(declarationDiagnostics()).toEqual([]);
    }, COMPILER_TIMEOUT_MS);
});
