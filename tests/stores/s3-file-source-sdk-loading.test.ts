/**
 * LambderS3FileSource loads @aws-sdk/client-s3, an optional peer, on its
 * first read, the way every store and bucket here loads its SDK (see
 * LambderSdkInstallHint): a package that fails to load fails that read with
 * the install hint, and the failure is not remembered, so a read after the
 * package is installed in the same process goes through.
 *
 * The mock stands in for the package: absent until the test installs it.
 */

import { describe, it, expect, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ installed: false, loads: 0 }));
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
    sdk.loads += 1;
    if(!sdk.installed) throw new Error('Cannot find module @aws-sdk/client-s3');
    return await importOriginal<typeof import('@aws-sdk/client-s3')>();
});

describe('LambderS3FileSource without its SDK', () => {
    it('fails a read with the install hint, and reads once the package is there, without remembering the failure', async () => {
        const { LambderS3FileSource } = await import('../../src/stores/LambderS3FileSource.js');
        // A client that answers every GetObject with one file, so the read needs no bucket.
        const client = {
            send: async () => ({ Body: { transformToByteArray: async () => new Uint8Array(Buffer.from('body {}', 'utf8')) }, ContentType: 'text/css' }),
        } as unknown as import('@aws-sdk/client-s3').S3Client;
        const source = new LambderS3FileSource({ bucket: 'web', client });

        await expect(source.read('app.css')).rejects.toThrow('LambderS3FileSource requires @aws-sdk/client-s3: npm install @aws-sdk/client-s3');
        await expect(source.read('app.css')).rejects.toThrow('LambderS3FileSource requires @aws-sdk/client-s3');

        sdk.installed = true;
        const file = await source.read('app.css');
        expect(file?.body.toString('utf8')).toBe('body {}');
        expect(file?.mimeType).toBe('text/css');
        expect(sdk.loads).toBe(3);
    });
});
