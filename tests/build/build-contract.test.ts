/**
 * lambder/build: writing and checking the contract module a client compiles.
 *
 * The contracts come from two kinds of project: an instance declared with a
 * hand-written ApiContract in a temporary directory, for the printer's cases
 * one by one, and a store app registered over this package's source
 * (tests/fixtures/contract-app), for a contract as an app infers it. Generated files are written under the
 * system's temporary directory, never into the repository. Every call
 * compiles its project with the TypeScript compiler, so these take seconds.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { writeApiContract } from '../../src/build.js';

const COMPILER_TIMEOUT_MS = 120_000;
const FIXTURE_APP = fileURLToPath(new URL('../fixtures/contract-app', import.meta.url));
const CLIENT_ENTRY = fileURLToPath(new URL('../../src/client.js', import.meta.url));

const directory = mkdtempSync(join(tmpdir(), 'lambder-contract-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

let projectCount = 0;
/**
 * A project holding one module, `source`, under a tsconfig of its own with
 * only the default library. `contractModule` declares an instance with the
 * contract given and exports it as the default export, as writeApiContract
 * reads it by default.
 */
const projectWith = (source: string, { files = {}, compilerOptions = {} }: { files?: Record<string, string>; compilerOptions?: Record<string, unknown> } = {}) => {
    const root = join(directory, `project-${projectCount++}`);
    mkdirSync(root);
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, lib: ['ES2022'], types: [], ...compilerOptions } }));
    writeFileSync(join(root, 'contract.ts'), source);
    for(const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
    return { module: join(root, 'contract.ts'), file: join(root, 'contract.generated.ts') };
};
const contractModule = (declarations: string, contract: string) =>
    `${declarations}\ndeclare const lambder: { readonly ApiContract: ${contract} };\nexport default lambder;\n`;

/** The diagnostics of `files` compiled on their own, with only the default library. */
const diagnosticsOf = (files: string[], options: ts.CompilerOptions = {}) => {
    const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2022, strict: true, noEmit: true, lib: ['lib.es2022.d.ts'], types: [], ...options });
    return ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
};

const PRINTER_CASES = contractModule(`
export interface Customer { id: string; name: string; tags: readonly string[] }
export type TreeNode = { label: string; children: TreeNode[] };
type Wrapped<T> = { value: T };
/** Anonymous in each instantiation, and Mirrored<TreeNode> meets itself inside its children. */
type Mirrored<T> = { readonly [K in keyof T]: Mirrored<T[K]> };
declare const nodes: TreeNode[];
const anonymousTree = { label: "root", children: nodes };
`, `{
    "orders.get": {
        input: { orderId: string; expand?: boolean };
        output: {
            customer: Customer;
            placedAt: Date;
            lines: { sku: string; quantity: number }[];
            total: Wrapped<number>;
            status: "open" | "paid" | "void" | null;
            flags: { [flag: string]: boolean };
            coordinates: readonly [latitude: number, longitude: number];
            history: [string, ...number[]];
            reference: \`order-\${number}\`;
            quote: "it's \\"quoted\\"";
            offset: -1;
            large: -5n;
            either: string | boolean;
            both: { a: string } & { b: number };
            tree: TreeNode;
            mirror: Mirrored<TreeNode>;
            grid: (readonly string[])[];
            "odd-key": string;
        };
        mode: "session";
        guards: { readonly storePermission: "orders.read" };
    };
    "customers.get": { input: { customerId: string }; output: Customer; mode: "public" };
    "tree.copy": { input: {}; output: typeof anonymousTree; mode: "public" };
}`);

describe('writeApiContract', () => {
    it('prints every type as plain structure, verifies it, and writes a module that imports nothing', async () => {
        const { module, file } = projectWith(PRINTER_CASES);

        const result = await writeApiContract({ module, file });

        expect(result).toMatchObject({ ok: true, written: true, count: 3, added: ['customers.get', 'orders.get', 'tree.copy'], changed: [], removed: [] });
        const printed = readFileSync(file, 'utf8');
        expect(printed).toMatch(/^\/\/ Generated by writeApiContract\(\) from lambder\/build\. Do not edit\./);
        expect(printed).not.toMatch(/^import /m);
        expect(printed).toContain('\n// prettier-ignore\nexport type ApiContractType = {\n    "customers.get": {');

        // A non-generic named type is declared once and referred to by name;
        // a generic one is printed in place.
        expect(printed.match(/^type Customer = \{$/gm)).toHaveLength(1);
        expect(printed).toContain('        output: Customer;');
        expect(printed).toContain('            customer: Customer;');
        expect(printed).not.toContain('Wrapped');
        expect(printed).toContain('            total: {\n                value: number;\n            };');

        // The default library's interfaces keep their names; the rest of the
        // forms print as themselves.
        expect(printed).toContain('placedAt: Date;');
        expect(printed).toContain('tags: readonly string[];');
        expect(printed).toContain('coordinates: readonly [latitude: number, longitude: number];');
        expect(printed).toContain('history: [string, ...number[]];');
        expect(printed).toContain('grid: (readonly string[])[];');
        expect(printed).toContain('reference: `order-${number}`;');
        expect(printed).toContain('quote: "it\'s \\"quoted\\"";');
        expect(printed).toContain('offset: -1;');
        expect(printed).toContain('large: -5n;');
        expect(printed).toContain('status: "open" | "paid" | "void" | null;');
        expect(printed).toContain('either: boolean | string;');
        expect(printed).toContain('flags: {\n                [key: string]: boolean;\n            };');
        expect(printed).toContain('"odd-key": string;');
        // Objects intersected print as the one object they are.
        expect(printed).toContain('both: {\n                a: string;\n                b: number;\n            };');
        expect(printed).toContain('guards: {\n            storePermission: "orders.read";\n        };');

        // A named recursive type refers to itself by its name, and an object
        // that only refers to one is printed in place.
        expect(printed).toContain('type TreeNode = {\n    label: string;\n    children: TreeNode[];\n};');
        expect(printed).toContain('tree: TreeNode;');
        expect(printed).toMatch(/output: \{\n {12}label: string;\n {12}children: TreeNode\[\];\n {8}\};/);
        // An anonymous one is named after the alias it instantiates and its
        // arguments, to refer to itself by.
        expect(printed).toContain('mirror: MirroredTreeNode;');
        expect(printed).toContain('type MirroredTreeNode = {\n    label: string;\n    children: readonly MirroredTreeNode[];\n};');

        // The module stands on its own: nothing it names lives elsewhere.
        expect(diagnosticsOf([file])).toEqual([]);
    }, COMPILER_TIMEOUT_MS);

    it('prints with single quotes and without semicolons when asked, and a custom header', async () => {
        const { module, file } = projectWith(PRINTER_CASES);

        const result = await writeApiContract({ module, file, quotes: 'single', semicolons: false, header: 'Written by the store generator.\n\nDo not edit.' });

        expect(result.ok).toBe(true);
        const printed = readFileSync(file, 'utf8');
        expect(printed.startsWith('// Written by the store generator.\n//\n// Do not edit.\n\n')).toBe(true);
        expect(printed).toContain("\n    'orders.get': {\n");
        expect(printed).toContain("quote: 'it\\'s \"quoted\"'\n");
        expect(printed).toContain("status: 'open' | 'paid' | 'void' | null\n");
        expect(printed).not.toMatch(/;$/m);
        expect(diagnosticsOf([file])).toEqual([]);
    }, COMPILER_TIMEOUT_MS);

    it('prints properties in source order, never in the order the compiler happened to create their keys', async () => {
        // The key "zeta" is created before "alpha", so the compiler orders any
        // union of the two zeta first, and a mapped type over that union lists
        // its properties the same way.
        const { module, file } = projectWith(contractModule(`
            declare const createdFirst: "zeta";
            declare const createdSecond: "alpha";
            interface Written { zeta: string; alpha: string }
            type Mirrored<T> = { [K in keyof T]: T[K] };
        `, `{
            "orders.get": {
                input: { [K in "zeta" | "alpha"]: string };
                output: Mirrored<Written>;
                mode: "public";
            };
        }`));

        expect((await writeApiContract({ module, file })).ok).toBe(true);
        const printed = readFileSync(file, 'utf8');
        // Declared nowhere: by name. Declared: where they are written.
        expect(printed).toContain('input: {\n            alpha: string;\n            zeta: string;\n        };');
        expect(printed).toContain('output: {\n            zeta: string;\n            alpha: string;\n        };');
    }, COMPILER_TIMEOUT_MS);

    it('refuses a contract holding what has no plain form, names where each sits, and writes nothing', async () => {
        const { module, file } = projectWith(contractModule(`
            enum Level { Low, High }
            declare const secretKey: unique symbol;
            class Account { private secret = ""; id = ""; }
        `, `{
            "accounts.get": {
                input: {};
                output: { run: () => void; level: Level; [secretKey]: string; account: Account };
                mode: "public";
            };
        }`));

        const result = await writeApiContract({ module, file });

        expect(result).toMatchObject({ ok: false, written: false, count: 0 });
        expect(result.lines[0]).toMatch(/holds types with no plain form/);
        expect(result.lines).toEqual(expect.arrayContaining([
            expect.stringMatching(/"accounts\.get"\.output\.run: .*a function/),
            expect.stringMatching(/"accounts\.get"\.output\.level: .*an enum/),
            expect.stringMatching(/"accounts\.get"\.output\.__@secretKey.*: a symbol-keyed property/),
            expect.stringMatching(/"accounts\.get"\.output\.account\.secret: a private or protected member/),
        ]));
        expect(existsSync(file)).toBe(false);
    }, COMPILER_TIMEOUT_MS);

    it('refuses a type a compile error left unresolved, in whichever module the error is', async () => {
        // The entry compiles; the module it takes an output from does not,
        // and what it could not resolve would print, and verify, as any.
        const { module, file } = projectWith(contractModule('import type { OrderOutput } from "./orders";', '{ "orders.get": { input: {}; output: OrderOutput; mode: "public" } }'), {
            files: { 'orders.ts': 'export type OrderOutput = { id: string; total: MissingMoney };' },
        });

        const result = await writeApiContract({ module, file });

        expect(result).toMatchObject({ ok: false, written: false });
        expect(result.lines).toEqual(expect.arrayContaining([expect.stringMatching(/"orders\.get"\.output\.total: a type the compiler could not resolve/)]));
        expect(existsSync(file)).toBe(false);
    }, COMPILER_TIMEOUT_MS);

    it('prints an optional member as its source wrote it under exactOptionalPropertyTypes', async () => {
        const { module, file } = projectWith(contractModule(
            'interface Customer { id: string; nickname?: string; note?: string | undefined }',
            '{ "customers.get": { input: {}; output: Customer; mode: "public" } }',
        ), { compilerOptions: { exactOptionalPropertyTypes: true } });

        expect((await writeApiContract({ module, file })).ok).toBe(true);
        expect(readFileSync(file, 'utf8')).toContain('type Customer = {\n    id: string;\n    nickname?: string;\n    note?: string | undefined;\n};');
    }, COMPILER_TIMEOUT_MS);

    it('names a declaration after what it declares: a default export, a class, an interface with a base, an instance of a generic one', async () => {
        const { module, file } = projectWith(contractModule(`
            import type Customer from "./customer";
            class Money { amount = 0; currency = "USD"; }
            interface Record { id: string }
            interface Order extends Record { total: Money; customer: Customer }
            interface Tree<T> { value: T; children: Tree<T>[] }
        `, '{ "orders.get": { input: {}; output: { order: Order; tags: Tree<string>; counts: Tree<number> }; mode: "public" } }'), {
            files: { 'customer.ts': 'export default interface Customer { name: string }' },
        });

        expect((await writeApiContract({ module, file })).ok).toBe(true);
        const printed = readFileSync(file, 'utf8');
        expect(printed).toContain('type Customer = {\n    name: string;\n};');
        expect(printed).toContain('type Money = {\n    amount: number;\n    currency: string;\n};');
        // Record's member is written above Order's own, and prints there.
        expect(printed).toContain('type Order = {\n    id: string;\n    total: Money;\n    customer: Customer;\n};');
        expect(printed).toContain('type TreeString = {\n    value: string;\n    children: TreeString[];\n};');
        expect(printed).toContain('type TreeNumber = {\n    value: number;\n    children: TreeNumber[];\n};');
    }, COMPILER_TIMEOUT_MS);

    it('numbers types sharing a name by where each is declared, whatever order the APIs are registered in', async () => {
        const files = {
            'orders.ts': 'export interface Row { orderId: string }',
            'users.ts': 'export interface Row { userId: string }\nexport interface Row2 { note: string }',
        };
        const imports = 'import type { Row as OrderRow } from "./orders";\nimport type { Row as UserRow, Row2 } from "./users";';
        // The entry reaching users.ts's Row sorts first, and orders.ts is declared first.
        const accounts = '{ "accounts.list": { input: {}; output: { rows: UserRow[]; note: Row2 }; mode: "public" } }';
        const orders = '{ "orders.list": { input: {}; output: OrderRow[]; mode: "public" } }';
        const accountsFirst = projectWith(contractModule(imports, `${accounts} & ${orders}`), { files });
        const ordersFirst = projectWith(contractModule(imports, `${orders} & ${accounts}`), { files });

        expect((await writeApiContract(accountsFirst)).ok).toBe(true);
        expect((await writeApiContract(ordersFirst)).ok).toBe(true);
        const printed = readFileSync(accountsFirst.file, 'utf8');
        expect(readFileSync(ordersFirst.file, 'utf8')).toBe(printed);
        // The Row declared first keeps the name, and the other takes the
        // first number no type is declared under.
        expect(printed).toContain('type Row = {\n    orderId: string;\n};');
        expect(printed).toContain('type Row2 = {\n    note: string;\n};');
        expect(printed).toContain('type Row3 = {\n    userId: string;\n};');
    }, COMPILER_TIMEOUT_MS);

    it('escapes what a template literal holds, so its text prints back as the same text', async () => {
        const { module, file } = projectWith(contractModule('', '{ "orders.get": { input: {}; output: { reference: `line\\n\\`${number}` }; mode: "public" } }'));

        expect((await writeApiContract({ module, file })).ok).toBe(true);
        expect(readFileSync(file, 'utf8')).toContain('reference: `line\\n\\`${number}`;');
    }, COMPILER_TIMEOUT_MS);

    it('refuses a module that does not compile, since its contract may have inferred any', async () => {
        const { module, file } = projectWith(contractModule('', '{ "orders.get": { input: MissingType; output: {}; mode: "public" } }'));

        const result = await writeApiContract({ module, file });

        expect(result).toMatchObject({ ok: false, written: false });
        expect(result.lines[0]).toMatch(/the module does not compile/);
        expect(result.lines.join('\n')).toContain('TS2304');
    }, COMPILER_TIMEOUT_MS);

    it('names the export it could not find, and one that is not an instance', async () => {
        const { module, file } = projectWith(`
            export const settings = { region: "us-east-1" };
            export declare const store: { readonly ApiContract: {} };
        `);

        const missing = await writeApiContract({ module, file });
        expect(missing.ok).toBe(false);
        expect(missing.lines[0]).toMatch(/has no export named "default"; name the export that holds the Lambder instance in exportName$/);

        const notInstance = await writeApiContract({ module, file, exportName: 'settings' });
        expect(notInstance.lines[0]).toMatch(/"settings" is not a Lambder instance: it has no ApiContract$/);

        // The written type takes typeName, whatever the export is called.
        expect(await writeApiContract({ module, file, exportName: 'store', typeName: 'StoreContract' })).toMatchObject({ ok: true, count: 0 });
        expect(readFileSync(file, 'utf8')).toContain('export type StoreContract = {};');
    }, COMPILER_TIMEOUT_MS);
});

describe('writeApiContract over an app', () => {
    const file = join(directory, 'store.generated.ts');
    const storeV1 = { module: join(FIXTURE_APP, 'storeV1.ts'), exportName: 'lambder', file };
    const storeV2 = { module: join(FIXTURE_APP, 'storeV2.ts'), exportName: 'lambder', file };

    it('writes the contract the instance infers, and a check of the same app passes without writing', async () => {
        expect(await writeApiContract(storeV1)).toMatchObject({ ok: true, written: true, count: 3 });
        const printed = readFileSync(file, 'utf8');
        // The client's side of each schema: a defaulted field is optional to
        // send, and a date arrives as its JSON string.
        expect(printed).toContain('            expand?: boolean | undefined;');
        expect(printed).toContain('            placedAt: string;');
        expect(printed).toContain('        mode: "session";');
        expect(printed).toContain('        guards: {\n            storePermission: "orders.read";\n        };');
        expect(printed).toContain('        guards: readonly ["captcha"];');
        expect(printed).toContain('        guardInputs: {\n            captcha: {\n                token: string;\n            };\n        };');
        // Every code the endpoint can refuse with, its guard's included.
        expect(printed).toContain('        refusals: {\n            "not-permitted": {};\n            "order-closed": {};\n        };');

        const check = await writeApiContract({ ...storeV1, check: true });
        expect(check).toMatchObject({ ok: true, written: false, changed: [], added: [], removed: [] });
        expect(check.lines).toEqual([expect.stringMatching(/matches the 3 APIs of ApiContractType$/)]);
        expect(readFileSync(file, 'utf8')).toBe(printed);
    }, COMPILER_TIMEOUT_MS);

    it('fails a check against a changed app, naming what moved, and a write then says the same', async () => {
        const stale = await writeApiContract({ ...storeV2, check: true });
        expect(stale).toMatchObject({ ok: false, written: false, changed: ['orders.get'], added: ['orders.refund'], removed: ['orders.cancel'] });
        expect(stale.lines).toEqual([
            expect.stringMatching(/is stale: regenerate it$/),
            '  1 changed, 1 added, 1 removed (1 unchanged)',
            '  ~ orders.get',
            '  + orders.refund',
            '  - orders.cancel',
        ]);

        const written = await writeApiContract(storeV2);
        expect(written).toMatchObject({ ok: true, written: true, changed: ['orders.get'], added: ['orders.refund'], removed: ['orders.cancel'] });
        expect(await writeApiContract(storeV2)).toMatchObject({ ok: true, written: false, lines: [expect.stringMatching(/is up to date \(3 APIs\)$/)] });
    }, COMPILER_TIMEOUT_MS);

    it('prints a contract the typed caller and the mock accept, as they accept the inferred one', () => {
        // The printed type is a type literal, so it has the inferable index
        // signature LambderApiContractShape asks for, which an interface
        // written out member by member would not.
        const consumer = join(directory, 'consumer.ts');
        writeFileSync(consumer, [
            `import type { LambderApiContractShape, LambderCaller } from ${JSON.stringify(CLIENT_ENTRY)};`,
            `import type { ApiContractType } from ${JSON.stringify(file.replace(/\.ts$/, '.js'))};`,
            'type Accepted<C extends LambderApiContractShape> = C;',
            'export type StoreContract = Accepted<ApiContractType>;',
            'export type RefundCall = LambderCaller<ApiContractType>["api"];',
            'export const refundAmount = (input: ApiContractType["orders.refund"]["input"]): number => input.amount;',
            `import type { LambderContractRefusalMessage } from ${JSON.stringify(CLIENT_ENTRY)};`,
            // A refusal's data, printed as it arrives: the Date is its string.
            'export const refundable = (message: LambderContractRefusalMessage<ApiContractType, "orders.refund">): string => message.code === "refund-too-large" ? `${message.data.refundable} since ${message.data.placedAt.slice(0, 10)}` : message.content;',
        ].join('\n'));

        expect(diagnosticsOf([consumer], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'], types: ['node'], skipLibCheck: true })).toEqual([]);
    }, COMPILER_TIMEOUT_MS);
});
