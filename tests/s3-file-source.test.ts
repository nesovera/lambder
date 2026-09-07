/**
 * LambderS3FileSource: public files from S3 or an S3-compatible store.
 *
 * - Keys are prefix + relative path; the object's Content-Type is used
 *   unless it is a generic octet-stream (then the extension decides).
 * - A missing object reads as null (the request falls through); other
 *   errors propagate.
 * - Works with a supplied client or one built from clientConfig (R2 style).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import path from 'path';
import { decodeBody } from './helpers.js';
import Lambder from '../src/core/Lambder.js';
import { LambderS3FileSource } from '../src/stores/LambderS3FileSource.js';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';

const s3Mock = mockClient(S3Client);

/** The Body of a GetObject response: enough surface for transformToByteArray. */
const bodyOf = (text: string) => ({ transformToByteArray: async () => new Uint8Array(Buffer.from(text, 'utf8')) }) as any;
const s3Error = (name: string) => Object.assign(new Error(name), { name });

beforeEach(() => { s3Mock.reset(); });

describe('LambderS3FileSource', () => {
    it('reads prefix + relative path and uses the object Content-Type', async () => {
        s3Mock.on(GetObjectCommand, { Bucket: 'web', Key: 'v42/app.css' })
            .resolves({ Body: bodyOf('body {}'), ContentType: 'text/css' });
        const source = new LambderS3FileSource({ bucket: 'web', prefix: 'v42/', client: new S3Client({}) });

        const file = await source.read('app.css');

        expect(file?.body.toString('utf8')).toBe('body {}');
        expect(file?.mimeType).toBe('text/css');
    });

    it('leaves the mime type to the extension when the object is a generic octet-stream', async () => {
        s3Mock.on(GetObjectCommand).resolves({ Body: bodyOf('x'), ContentType: 'binary/octet-stream' });
        const file = await new LambderS3FileSource({ bucket: 'web', client: new S3Client({}) }).read('app.js');
        expect(file?.mimeType).toBeUndefined();

        s3Mock.on(GetObjectCommand).resolves({ Body: bodyOf('x') });
        const untyped = await new LambderS3FileSource({ bucket: 'web', client: new S3Client({}) }).read('app.js');
        expect(untyped?.mimeType).toBeUndefined();
    });

    it('a missing object reads as null; other errors propagate', async () => {
        const source = new LambderS3FileSource({ bucket: 'web', client: new S3Client({}) });

        s3Mock.on(GetObjectCommand).rejects(s3Error('NoSuchKey'));
        await expect(source.read('missing.css')).resolves.toBeNull();
        s3Mock.on(GetObjectCommand).rejects(s3Error('NotFound'));
        await expect(source.read('missing.css')).resolves.toBeNull();

        s3Mock.on(GetObjectCommand).rejects(s3Error('AccessDenied'));
        await expect(source.read('missing.css')).rejects.toThrow('AccessDenied');
    });

    it('builds its own client from clientConfig on first read (R2 style), once', async () => {
        s3Mock.on(GetObjectCommand, { Bucket: 'web', Key: 'app.css' }).resolves({ Body: bodyOf('a'), ContentType: 'text/css' });
        const source = new LambderS3FileSource({
            bucket: 'web',
            clientConfig: { region: 'auto', endpoint: 'https://account.r2.cloudflarestorage.com', credentials: { accessKeyId: 'k', secretAccessKey: 's' } },
        });

        expect((await source.read('app.css'))?.body.toString('utf8')).toBe('a');
        expect((await source.read('app.css'))?.body.toString('utf8')).toBe('a');
        expect(s3Mock.commandCalls(GetObjectCommand).length).toBe(2);
        expect(() => new LambderS3FileSource({ bucket: '  ' })).toThrow();
    });

    it('serves through Lambder: extension mime for untyped objects, fallthrough for missing ones', async () => {
        s3Mock.on(GetObjectCommand, { Bucket: 'web', Key: 'site/app.css' }).resolves({ Body: bodyOf('body {}') });
        s3Mock.on(GetObjectCommand, { Bucket: 'web', Key: 'site/missing.js' }).rejects(s3Error('NoSuchKey'));
        const lambder = new Lambder({ publicPath: path.resolve('./tests/fixtures/public'), apiPath: '/api' })
            .servePublicFiles({ source: new LambderS3FileSource({ bucket: 'web', prefix: 'site/', client: new S3Client({}) }) })
            .setRouteFallbackHandler((ctx, res) => res.text('fallback', { statusCode: 404 }));
        const handler = lambder.getHandler();
        const event = (requestPath: string): APIGatewayProxyEvent => ({
            body: null, headers: { Host: 'localhost' }, multiValueHeaders: {}, httpMethod: 'GET', isBase64Encoded: false,
            path: requestPath, pathParameters: null, queryStringParameters: null, multiValueQueryStringParameters: null,
            stageVariables: null, requestContext: {} as any, resource: '',
        });
        const context = {} as Context;

        const css = await handler(event('/app.css'), context);
        expect(css.statusCode).toBe(200);
        expect(css.multiValueHeaders?.['Content-Type']).toContain('text/css');
        expect(decodeBody(css)).toBe('body {}');

        const missing = await handler(event('/missing.js'), context);
        expect(missing.statusCode).toBe(404);
        expect(decodeBody(missing)).toBe('fallback');
    });
});
