/**
 * lambder/build's one call over every file a script names: each app's
 * module given once, every file written or checked, a failing writer
 * reported beside the others rather than stopping them, and a config the
 * call cannot read refused.
 *
 * Files are written under the system's temporary directory, never into the
 * repository.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { initLambder } from '../../src/core/Lambder.js';
import { lambderGuard } from '../../src/core/LambderPolicyBuilders.js';
import { generateApiFiles, type LambderApiFilesConfig } from '../../src/build.js';

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
        expect(readFileSync(join(root, 'staffGuardParams.generated.ts'), 'utf8')).toContain('"orders.list": "ORDERS.VIEW"');

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
});
