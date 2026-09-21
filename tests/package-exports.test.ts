/**
 * The package as a consumer resolves it, and the layering the source keeps.
 *
 * Every other test imports `../src/...` directly, which never touches
 * package.json's `exports` map, the `browser` field, or the built `dist`. So
 * a renamed subpath, a stale mapping or a missing build could ship and the
 * whole suite would stay green: exactly what happened to `./testing` when it
 * became `./mock`.
 *
 * These import by package name, which Node resolves through the package's own
 * exports map (self-reference), so what runs here is what a consumer gets.
 * They read `dist`, so `npm run build` has to have run; `npm test` does that
 * ahead of them in the release flow, and a stale dist is itself worth failing
 * on.
 *
 * The rest of the file works off the source import graph rather than `dist`:
 * the browser boundary, the layer directions in docs/api-core.md's layering
 * section, and the export list `docs/exports.md` claims are all properties of
 * the tree, so each of them is checked here rather than by a reader.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * Every Node built-in, in both spellings a source file can write.
 *
 * Read from the runtime rather than listed by hand: the list this replaced was
 * the four names the `browser` field happens to stub, so a static
 * `import { Buffer } from "buffer"` or anything out of `stream`, `util`, `os`
 * or `events` passed the browser-safety gate silently and reached a bundle as
 * a real resolve.
 */
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
const isNodeBuiltin = (specifier: string) => NODE_BUILTINS.has(specifier) || specifier.startsWith('node:');

/**
 * Whether an import clause erases at build time, per specifier rather than
 * per clause.
 *
 * `import { type Foo, bar }` imports a value: the clause STARTS with `type`
 * but `bar` is still a real edge. A "does it start with type" reading called
 * that type-only and let it past the checks below.
 */
const isTypeOnlyClause = (clause: string) => {
    const trimmed = clause.trim();
    if(!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
    const members = trimmed.slice(1, -1).split(',').map(member => member.trim()).filter(Boolean);
    return members.length > 0 && members.every(member => /^type\b/.test(member));
};

type ModuleImports = {
    /** Bare specifiers a bundler resolves at build time. */
    value: Set<string>;
    /** Bare specifiers that erase at build time and bind a consumer's typecheck instead. */
    type: Set<string>;
    /** Bare specifiers behind a dynamic `import()`: not followed, still resolved by a bundler. */
    lazy: Set<string>;
    /** Edges inside `src`, as the src-relative path of the target. */
    local: { target: string; typeOnly: boolean }[];
};

/**
 * The import graph one entry drags behind it, as a bundler and a typechecker
 * would follow it.
 *
 * Property checks on the namespace cannot see this: an entry can re-export
 * one value and drag a whole library in behind it. That is what happened to
 * the cookie jar, whose tough-cookie/tldts pair carries the public suffix
 * list and took the client bundle from 372 KB to 27 KB once the package
 * declared it has no side effects.
 *
 * This is a source-graph proxy for the bundle, not the bundle: it says what a
 * bundler would be ASKED to resolve. That is the property the entries promise
 * (a browser-safe graph, and a heavy dependency reachable from one module
 * only), and it is also the one a bundler cannot check for the type graph at
 * all, since type-only edges never reach a bundler and still bind every
 * consumer's typecheck. A real bundle measurement needs a bundler this
 * repository does not install; the byte figures above were taken by hand with
 * one.
 */
const sourceGraph = (entryFile: string) => {
    const graph = new Map<string, ModuleImports>();
    const visit = (url: URL) => {
        const key = url.pathname.split('/src/')[1]!;
        if(graph.has(key)) return;
        const imports: ModuleImports = { value: new Set(), type: new Set(), lazy: new Set(), local: [] };
        graph.set(key, imports);
        const source = readFileSync(url, 'utf8');
        const followed: URL[] = [];
        for(const match of source.matchAll(/(?:^|\n)\s*(?:import|export)(\s+type)?([\s\S]*?)from\s+['"]([^'"]+)['"]/g)){
            const specifier = match[3]!;
            const typeOnly = Boolean(match[1]) || isTypeOnlyClause(match[2]!);
            if(specifier.startsWith('.')){
                const target = new URL(specifier.replace(/\.js$/, '.ts'), url);
                imports.local.push({ target: target.pathname.split('/src/')[1]!, typeOnly });
                followed.push(target);
                continue;
            }
            // Type-only edges vanish at build time, but they still bind a
            // consumer's typecheck, so they are recorded apart rather than
            // dropped.
            (typeOnly ? imports.type : imports.value).add(specifier);
        }
        // A dynamic import() is deliberately not followed: it is the lazy edge
        // that keeps zlib and the DDB SDK out of a bundle. Its specifier is
        // still recorded, because a bundler is asked to resolve it and the
        // `browser` field is the answer. `typeof import(...)` is a type
        // position, not an edge.
        for(const match of source.matchAll(/(typeof\s+)?\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)){
            if(!match[1] && !match[2]!.startsWith('.')) imports.lazy.add(match[2]!);
        }
        for(const target of followed) visit(target);
    };
    visit(new URL(entryFile, import.meta.url));
    return {
        modules: [...graph.keys()],
        graph,
        importersOf: (name: string) => [...graph].filter(([, imports]) => imports.value.has(name)).map(([file]) => file),
    };
};

const ENTRY_FILES = ['../src/index.ts', '../src/client.ts', '../src/mock.ts', '../src/testing.ts'] as const;

/** The four entry graphs merged: every module the package can reach, once. */
const wholeSourceTree = () => {
    const merged = new Map<string, ModuleImports>();
    for(const entryFile of ENTRY_FILES){
        for(const [file, imports] of sourceGraph(entryFile).graph) merged.set(file, imports);
    }
    return merged;
};

/** Nothing a browser cannot run, anywhere on the graph, at value level or in the types. */
const expectBrowserSafe = (entry: ReturnType<typeof sourceGraph>) => {
    for(const [file, imports] of entry.graph){
        // The same three rules over both edge kinds. A type edge is checked
        // because aws-lambda on this graph makes @types/aws-lambda a typecheck
        // dependency of every browser-only consumer, and an SDK type a
        // dependency of one that installed no SDK; a Node built-in reached
        // through `import { type Foo, bar }` is a value edge that only looked
        // type-only.
        for(const specifier of [...imports.value, ...imports.type]){
            expect(specifier.startsWith('@aws-sdk/'), `${file} imports ${specifier}`).toBe(false);
            expect(specifier === 'aws-lambda', `${file} imports ${specifier}`).toBe(false);
            expect(isNodeBuiltin(specifier), `${file} imports the Node built-in ${specifier}`).toBe(false);
        }
    }
};

describe('The published entry points', () => {
    it('resolves the root entry and hands back the framework', async () => {
        const lambder = await import('lambder');

        expect(typeof lambder.default).toBe('function');
        expect(typeof lambder.initLambder).toBe('function');
        expect(typeof lambder.LambderDdbSessionStore).toBe('function');
        expect(typeof lambder.LambderMemorySessionStore).toBe('function');
    });

    it('resolves the client entry, and that entry pulls in no server code', async () => {
        const client = await import('lambder/client');

        expect(typeof client.LambderCaller).toBe('function');
        expect(typeof client.lambderFetchTransport).toBe('function');
        // The boundary the browser bundle depends on: no Lambder server, no
        // session manager, no stores.
        expect(client).not.toHaveProperty('LambderDdbSessionStore');
        expect(client).not.toHaveProperty('LambderSessionManager');
        expect(client).not.toHaveProperty('initLambder');
    });

    it('resolves the mock entry', async () => {
        const mock = await import('lambder/mock');

        expect(typeof mock.initLambderMock).toBe('function');
        expect(typeof mock.lambderMockMswHandler).toBe('function');
        expect(typeof mock.lambderMockInvokeTransport).toBe('function');
    });

    it('lets a consumer read its own package.json through the exports map', () => {
        // With an exports map and no "./package.json" entry, build tooling and
        // version probes that resolve it get ERR_PACKAGE_PATH_NOT_EXPORTED.
        const resolved = createRequire(import.meta.url).resolve('lambder/package.json');

        expect(resolved).toBe(new URL('../package.json', import.meta.url).pathname);
    });

    it('keeps the browser entry free of server dependencies, and droppable ones droppable', () => {
        const client = sourceGraph('../src/client.ts');

        // Type-only edges are followed too: a type reaching into core/ pulls
        // aws-lambda into the type graph of this entry, so a browser-only
        // consumer cannot typecheck without @types/aws-lambda. The allowed
        // neighbourhood is stated the same way the mock's is, so the whole
        // claim is pinned rather than the one directory a reader thought of:
        // the entry reached neither core/ nor session/ and only core/ was
        // checked.
        const allowed = /^(client\.ts|client\/|shared\/)/;
        for(const file of client.modules){
            expect(allowed.test(file), `the client entry reaches ${file}`).toBe(true);
        }
        expectBrowserSafe(client);

        // The heavy one enters through exactly one module, so it stays
        // droppable. A second importer would pin it into every bundle.
        expect(client.importersOf('tough-cookie')).toEqual(['shared/transport/LambderCookieJar.ts']);
        // And the package says a bundler may drop what a consumer never imports.
        expect(packageJson.sideEffects).toBe(false);
    });

    it('keeps the mock entry browser-safe too, which nothing used to check', () => {
        // The gate was written for the client entry and the mock entry got an
        // "it resolves" test, so `lambder/mock` reached aws-lambda and
        // @aws-sdk/client-lambda through its invoke transport and its guards:
        // 29 typecheck errors for a frontend that adopted it without @types
        // installed, and zero for the entry beside it. The rule is the same
        // rule; only the allowed neighbourhood differs.
        const mock = sourceGraph('../src/mock.ts');

        // The mock runtime is the API core over the memory stores: it may
        // reach the core's api/, session/ and shared/ modules and the memory
        // stores, and nothing else. core/ is the server adapter (aws-lambda
        // in its own types) and the invoke caller is the Lambda SDK.
        const allowed = /^(mock\.ts|mock\/|api\/|session\/|shared\/|stores\/LambderMemory)/;
        for(const file of mock.modules){
            expect(allowed.test(file), `the mock entry reaches ${file}`).toBe(true);
        }
        expectBrowserSafe(mock);
        expect(mock.importersOf('tough-cookie')).toEqual(['shared/transport/LambderCookieJar.ts']);
    });

    it('resolves the testing entry', async () => {
        const testing = await import('lambder/testing');

        expect(typeof testing.lambderTestApp).toBe('function');
        expect(typeof testing.assertApiSuccess).toBe('function');
        expect(typeof testing.assertApiFailure).toBe('function');
        expect(typeof testing.LambderMemorySessionStore).toBe('function');
    });

    it('keeps the testing entry out of every other entry, so no deployment or bundle carries it', () => {
        // The test app exists to put other stores under a built instance.
        // Nothing an app ships should be able to reach it, and "nothing else
        // imports it" is only true while something checks.
        for(const entryFile of ['../src/index.ts', '../src/client.ts', '../src/mock.ts']){
            const reached = sourceGraph(entryFile).modules.filter(file => file === 'testing.ts' || file.startsWith('testing/'));
            expect(reached, `${entryFile} reaches the testing entry`).toEqual([]);
        }
    });

    it('serves the same outcome assertions from the mock entry and the testing entry', async () => {
        const mock = await import('lambder/mock');
        const testing = await import('lambder/testing');

        expect(mock.assertApiFailure).toBe(testing.assertApiFailure);
        expect(mock.assertApiSuccess).toBe(testing.assertApiSuccess);
    });

    it('maps every Node built-in a bundler is asked to resolve away for the browser', () => {
        // A bundler reads this field to decide what a browser build gets.
        // Anything the graph asks it to resolve and this field does not answer
        // reaches a browser as a real require and breaks the bundle. The
        // expectation is derived from the graph rather than written out,
        // because the literal version failed when an import and its matching
        // mapping were added together and stayed green when only the import
        // was.
        const reached = new Set<string>();
        for(const [, imports] of wholeSourceTree()){
            // Value edges are forbidden outright on the two browser entries
            // and allowed on the root; lazy ones are the deliberate shape
            // (`shared/util/LambderNodeModules.ts` hands back null off Node). Both
            // are specifiers a bundler resolves.
            for(const specifier of [...imports.value, ...imports.lazy]){
                if(isNodeBuiltin(specifier)) reached.add(specifier);
            }
        }

        // The `browser` field keys on the specifier as written, so a
        // `node:`-prefixed one would need its own key. The layer rule keeps
        // them out of the isomorphic modules, and this is where that shows up.
        expect([...reached].filter(specifier => specifier.startsWith('node:'))).toEqual([]);
        expect(Object.keys(packageJson.browser).sort()).toEqual([...reached].sort());
        for(const [specifier, mapping] of Object.entries(packageJson.browser)){
            expect(mapping, `${specifier} should be stubbed out, not redirected`).toBe(false);
        }
    });

    it('declares the subpaths it means to, in exports and typesVersions', () => {
        expect(Object.keys(packageJson.exports).sort()).toEqual(['.', './client', './mock', './package.json', './testing']);
        expect(Object.keys(packageJson.typesVersions['*']).sort()).toEqual(['client', 'mock', 'testing']);
    });
});

/**
 * Directories are layers and imports only ever point down, per the layering
 * section of docs/api-core.md.
 *
 * Stated here as the rule itself, once per directory, rather than left to the
 * two entry gates above. Those enforce MEMBERSHIP for two entries, which
 * reaches most of these edges only by accident: it says nothing about
 * `shared/ -> api/`, `core/ -> stores/` or `invoke/ -> core/`, it checks a
 * module against only the layers its own entry happens to exclude, and what
 * it covers moves whenever an entry's re-export list does.
 */
const MAY_IMPORT: Record<string, readonly string[]> = {
    shared: ['shared'],
    stores: ['shared', 'stores'],
    session: ['shared', 'session'],
    api: ['shared', 'session', 'api'],
    client: ['shared', 'client'],
    core: ['shared', 'stores', 'session', 'api', 'core'],
    mock: ['shared', 'stores', 'session', 'api', 'mock'],
    // invoke/ sits above core/: it synthesizes events for and decodes results
    // from a Lambder server. The edge is type-only, pinned separately below.
    invoke: ['shared', 'session', 'api', 'invoke', 'core'],
    // testing/ sits on top of the server: it puts a built instance under test
    // through the typed caller and the in-process transport, over the memory
    // stores. Nothing imports it back, which its own gate above pins.
    testing: ['shared', 'stores', 'session', 'api', 'client', 'core', 'invoke', 'testing'],
    // The entries. The root one is the whole framework minus the mock
    // runtime, which is its own entry and stays out of a server bundle.
    'index.ts': ['shared', 'stores', 'session', 'api', 'client', 'core', 'invoke'],
    'client.ts': ['shared', 'client'],
    'mock.ts': ['shared', 'stores', 'session', 'api', 'mock'],
    'testing.ts': ['shared', 'stores', 'session', 'invoke', 'testing'],
};

/** The layer a src-relative path belongs to: its directory, or the entry file itself. */
const layerOf = (file: string) => file.includes('/') ? file.slice(0, file.indexOf('/')) : file;

/**
 * `shared/` is layered inside itself, because its groups carry different
 * obligations: `wire/` is the format a deployed client already speaks,
 * `contracts/` is what a store implements, `transport/` is the caller-to-
 * server seam, and `util/` is helpers with no vocabulary of their own. The
 * order below is what keeps those apart in practice. A utility that reached
 * up into the wire format would put a compatibility obligation on a file
 * whose group says it has none, which is the drift the grouping exists to
 * prevent.
 *
 * `contracts/` imports nothing at all: an interface a store implements should
 * cost that store nothing else. The two standalone modules at the root of the
 * group (LambderI18n, LambderHtml) import nothing either, which is what makes
 * them standalone rather than shared vocabulary.
 */
const SHARED_GROUPS = ['wire', 'contracts', 'transport', 'util'] as const;
const SHARED_MAY_IMPORT: Record<string, readonly string[]> = {
    contracts: [],
    util: ['util'],
    wire: ['wire', 'util', 'contracts'],
    transport: ['transport', 'wire', 'util', 'contracts'],
    root: [],
};

/** Which group inside `shared/` a src-relative path belongs to; "root" for the standalone modules. */
const sharedGroupOf = (file: string) => {
    const group = file.split('/')[1] ?? '';
    return (SHARED_GROUPS as readonly string[]).includes(group) ? group : 'root';
};

describe('The source layers', () => {
    const tree = wholeSourceTree();

    it('covers every module under src, so nothing is gated by not being reached', () => {
        const onDisk: string[] = [];
        const walk = (directory: string, prefix: string) => {
            for(const dirent of readdirSync(new URL(directory, import.meta.url), { withFileTypes: true })){
                if(dirent.isDirectory()) walk(`${directory}${dirent.name}/`, `${prefix}${dirent.name}/`);
                else if(dirent.name.endsWith('.ts')) onDisk.push(`${prefix}${dirent.name}`);
            }
        };
        walk('../src/', '');

        // A module no entry reaches is either dead or a layer rule nobody is
        // checking, and both are worth the failure.
        expect([...tree.keys()].sort()).toEqual(onDisk.sort());
    });

    it('points every import down, per directory', () => {
        for(const [file, imports] of tree){
            const allowed = MAY_IMPORT[layerOf(file)];
            expect(allowed, `no layer rule declared for ${file}`).toBeDefined();
            for(const { target } of imports.local){
                expect(allowed, `${file} imports ${target}`).toContain(layerOf(target));
            }
        }
    });

    it('lets invoke/ name a core/ type and never a core/ value', () => {
        for(const [file, imports] of tree){
            if(layerOf(file) !== 'invoke') continue;
            for(const { target, typeOnly } of imports.local){
                if(layerOf(target) !== 'core') continue;
                expect(typeOnly, `${file} imports a value out of ${target}`).toBe(true);
            }
        }
    });

    it('lets the mock runtime reach the memory stores and no other store', () => {
        for(const [file, imports] of tree){
            if(layerOf(file) !== 'mock' && file !== 'mock.ts') continue;
            for(const { target } of imports.local){
                if(layerOf(target) !== 'stores') continue;
                expect(target.startsWith('stores/LambderMemory'), `${file} imports ${target}`).toBe(true);
            }
        }
    });

    it('points every import down inside shared/ too, per group', () => {
        for(const [file, imports] of tree){
            if(layerOf(file) !== 'shared') continue;
            const group = sharedGroupOf(file);
            const allowed = SHARED_MAY_IMPORT[group];
            expect(allowed, `no group rule declared for ${file}`).toBeDefined();
            for(const { target } of imports.local){
                if(layerOf(target) !== 'shared') continue;
                expect(allowed, `${file} imports ${target}`).toContain(sharedGroupOf(target));
            }
        }
    });
});

/**
 * `docs/exports.md` is the page a consumer reads to find out what the package
 * exports. Checked here, because a page diffed against the entries by hand is
 * correct on the day someone does it and drifts on the next export.
 */
const entryExportNames = (entryFile: string) => {
    // Comments first: an export list carries them between its braces, and the
    // words inside one are not export names.
    const source = readFileSync(new URL(entryFile, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const names = new Set<string>();
    for(const match of source.matchAll(/(?:^|\n)\s*export\s+(?:type\s+)?\{([\s\S]*?)\}/g)){
        for(const raw of match[1]!.split(',')){
            const member = raw.replace(/^\s*type\s+/, '').trim();
            if(!member) continue;
            const aliased = member.split(/\s+as\s+/);
            names.add((aliased[1] ?? aliased[0]!).trim());
        }
    }
    // The default export under the name the page files it as ("`Lambder`
    // (default)"), not under the word `default`.
    const defaultExport = source.match(/(?:^|\n)\s*import\s+(\w+)\s+from[\s\S]*?\n\s*export\s+default\s+\1\s*;/);
    if(defaultExport) names.add(defaultExport[1]!);
    return names;
};

/**
 * The vocabulary a public name in this package starts with.
 *
 * The page is prose as well as tables, so the check needs to tell a name it
 * claims to export from an ordinary word in a sentence. A prefix from this
 * list plus an upper-case letter or an underscore after the first character is
 * what separates `initLambder` and `LAMBDER_INVOKE_HEADER` from `crash`,
 * `compression` and `dataRefresh`. The rate-limit verbs are deliberately
 * absent: the page writes `rateLimitKey` in a sentence about what the mock
 * runtime binds a builder as, and the real exports all start with `lambder`,
 * `Lambder` or `RATE_LIMIT_`.
 */
const EXPORT_NAME_PREFIXES = [
    'Lambder', 'LAMBDER_', 'DEFAULT_', 'API_', 'RATE_LIMIT_', 'COMPRESSED_',
    'Api', 'Condition', 'Http', 'PathParams', 'Route',
    'accepts', 'addAnswer', 'answer', 'apiNot', 'assertApi', 'buildApi', 'buildTransport',
    'compress', 'crash', 'create', 'decode', 'describe', 'envelope', 'error',
    'escapeHtml', 'finalize', 'getAnswer', 'html', 'init', 'invalid', 'is',
    'jsonScript', 'lambder', 'local', 'parse', 'raw', 'read', 'refusal',
    'refuse', 'renderHtmlValue', 'resolve', 'response', 'restore', 'serialize',
    'session', 'setAnswer', 'synthesize', 'toHttp', 'validation', 'version',
    'xml',
];
const looksLikeAnExportName = (name: string) =>
    /^[A-Za-z_$][\w$]*$/.test(name)
    && /[A-Z_]/.test(name.slice(1))
    && EXPORT_NAME_PREFIXES.some(prefix => name.startsWith(prefix));

describe('docs/exports.md', () => {
    const exported = new Set(ENTRY_FILES.flatMap(entryFile => [...entryExportNames(entryFile)]));
    const page = readFileSync(new URL('../docs/exports.md', import.meta.url), 'utf8');
    const backticked = new Set([...page.matchAll(/`([^`\n]+)`/g)].map(match => match[1]!.trim()));

    it('names every export of the four entries', () => {
        expect([...exported].filter(name => !backticked.has(name)).sort()).toEqual([]);
    });

    it('names nothing the entries no longer export', () => {
        const stale = [...backticked].filter(name => looksLikeAnExportName(name) && !exported.has(name));

        expect(stale.sort()).toEqual([]);
    });
});
