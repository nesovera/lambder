/**
 * The two formats that outlive a deploy, frozen as data.
 *
 * A request envelope and a response envelope are a contract between code that
 * ships separately: a browser holding an older bundle keeps calling, and a
 * callee keeps answering, across a deploy. A session's hash construction is a
 * contract with the table: change it and every stored record stops matching,
 * which reads to every signed-in person as being logged out at once.
 *
 * Neither is protected by anything else here. The rest of the suite computes
 * its expectations with the same code it is testing, so it would follow a
 * change straight through and stay green. These pin the bytes, so changing
 * either means editing a literal in this file and saying why.
 */

import { describe, it, expect } from 'vitest';
import nodeCrypto from 'node:crypto';
import { z } from 'zod';
import Lambder from '../src/core/Lambder.js';
import { LambderMemorySessionStore } from '../src/stores/LambderMemorySessionStore.js';
import { LambderWebCrypto } from '../src/session/LambderSessionCrypto.js';
import { buildTransportEnvelope } from '../src/shared/transport/LambderApiTransport.js';
import { DEFAULT_SESSION_TOKEN_COOKIE_KEY, DEFAULT_SESSION_CSRF_COOKIE_KEY } from '../src/shared/wire/LambderSessionCookieNames.js';
import { refuse } from '../src/shared/wire/LambderApiRefusal.js';
import { decodeBody, createApiEvent, createMockContext, testPublicFiles } from './helpers.js';

describe('The request envelope', () => {
    it('posts these exact fields, in this order', () => {
        const envelope = buildTransportEnvelope({
            apiPath: '/api',
            apiName: 'user.get',
            version: '3',
            token: 'csrf-token',
            siteHost: 'app.example.com',
            payload: { userId: '1' },
            guardInputs: { org: { organizationId: 'o-1' } },
            idempotencyKey: 'k-abcdefabcdefabcdef',
        });

        expect(JSON.stringify(envelope)).toBe(
            '{"apiName":"user.get","version":"3","token":"csrf-token","siteHost":"app.example.com"'
            + ',"payload":{"userId":"1"},"guardInputs":{"org":{"organizationId":"o-1"}},"idempotencyKey":"k-abcdefabcdefabcdef"}',
        );
    });

    it('carries a compressed payload under its own field, in place of payload', () => {
        const envelope = buildTransportEnvelope({
            apiPath: '/api', apiName: 'thing.do', token: '', siteHost: 'localhost',
            compressed: { payloadGz: 'H4sIA', payloadBytes: 42 },
        });

        expect(JSON.stringify(envelope)).toBe(
            '{"apiName":"thing.do","token":"","siteHost":"localhost","payloadGz":"H4sIA","payloadBytes":42}',
        );
        expect(envelope).not.toHaveProperty('payload');
    });

    it('leaves out what the call did not carry, rather than sending nulls', () => {
        const envelope = buildTransportEnvelope({ apiPath: '/api', apiName: 'ping', token: '', siteHost: '' });

        expect(Object.keys(envelope)).toEqual(['apiName', 'version', 'token', 'siteHost', 'payload']);
        expect(envelope.version).toBeUndefined();
    });
});

describe('The response envelope', () => {
    const app = () => new Lambder({
        files: testPublicFiles(),
        apiPath: '/api',
        apiVersion: '3',
        // A map that holds nothing, so every signed call is refused: what the
        // versionExpired case below exercises.
        apiSignatures: {},
        session: { store: new LambderMemorySessionStore(), sessionSalt: 'salt' },
    });
    const schema = { input: z.object({ value: z.string() }), output: z.any() };
    const bodyOf = async (lambder: Lambder<any, any>, apiName: string, body: Record<string, unknown> = { apiName, payload: { value: 'x' }, version: '3' }) =>
        decodeBody(await lambder.render(createApiEvent(body), createMockContext()));

    it('answers a success as apiVersion and payload, and nothing else', async () => {
        const lambder = app().addApi('ok', schema, async (ctx, res) => res.api({ id: 1 }));

        expect(await bodyOf(lambder, 'ok')).toBe('{"apiVersion":"3","payload":{"id":1}}');
    });

    it('carries the logList channel when the call wrote to it', async () => {
        const lambder = app().addApi('logs', schema, async (ctx, res) => { res.logToApiResponse('note'); return res.api(null); });

        expect(await bodyOf(lambder, 'logs')).toBe('{"apiVersion":"3","payload":null,"logList":["note"]}');
    });

    it('answers a refusal as a null payload beside the errorMessage shape', async () => {
        const lambder = app().addApi('no', schema, async () => refuse('Not today.', { code: 'app/no', title: 'Refused' }));

        expect(await bodyOf(lambder, 'no')).toBe(
            '{"apiVersion":"3","payload":null,"errorMessage":{"type":"warning","code":"app/no","title":"Refused","content":"Not today."}}',
        );
    });

    it('answers the framework refusals with their own flags and codes', async () => {
        const lambder = app().addSessionApi('secret', schema, async (ctx, res) => res.api(null));

        expect(await bodyOf(lambder, 'secret')).toBe('{"apiVersion":"3","payload":null,"sessionExpired":true}');
        expect(await bodyOf(lambder, 'nope')).toBe(
            '{"apiVersion":"3","payload":null,"errorMessage":{"type":"warning","code":"lambder/api-not-found","content":"API not found."}}',
        );
        expect(await bodyOf(lambder, 'secret', { apiName: 'secret', payload: { value: 'x' }, version: '3', signature: 'an-older-shape' }))
            .toBe('{"apiVersion":"3","payload":null,"versionExpired":true}');
    });

    it('answers a crash as a 500 envelope that says nothing about the crash', async () => {
        const lambder = app().addApi('boom', schema, async () => { throw new Error('the real reason'); });

        const body = await bodyOf(lambder, 'boom');
        expect(body).toBe('{"apiVersion":"3","payload":null,"errorMessage":{"type":"error","content":"Internal server error."}}');
        expect(body).not.toContain('the real reason');
    });
});

describe('The session hash construction', () => {
    const crypto = new LambderWebCrypto();

    it('hashes the partition key as HMAC-SHA256 of the sessionKey, keyed by the salt', async () => {
        // Frozen against node:crypto rather than against itself, which is the
        // whole point: computing the expectation with the code under test
        // would follow any change straight through.
        const sessionKey = 'user-123';
        const sessionSalt = 'a-salt-value';

        const hashed = await crypto.hmacSha256Hex(sessionSalt, sessionKey);

        expect(hashed).toBe(nodeCrypto.createHmac('sha256', sessionSalt).update(sessionKey).digest('hex'));
        expect(hashed).toBe('1e5a075c96fcae8d5a7ea353750ceb12e1b8dc1a665ea90533061f89bc2979b2');
    });

    it('hashes a bearer secret unsalted, so a record is found by the token alone', async () => {
        expect(await crypto.sha256Hex('a-secret')).toBe(nodeCrypto.createHash('sha256').update('a-secret').digest('hex'));
    });

    it('mints tokens as lowercase hex of 32 random bytes', async () => {
        const token = await crypto.randomHex(32);

        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(await crypto.randomHex(32)).not.toBe(token);
    });

    it('keeps the session cookie as the partition hash and the secret, joined by a colon', async () => {
        const store = new LambderMemorySessionStore();
        const lambder = new Lambder({
            files: testPublicFiles(),
            apiPath: '/api',
            session: { store, sessionSalt: 'a-salt-value' },
        }).addApi('login', { input: z.any(), output: z.any() }, async (ctx, res) => {
            await lambder.getSessionController(ctx).createSession('user-123', { role: 'user' });
            return res.api({ ok: true });
        });

        const result = await lambder.render(createApiEvent({ apiName: 'login', payload: {} }), createMockContext());

        const [tokenCookie, csrfCookie] = result.multiValueHeaders?.['Set-Cookie'] ?? [];
        // The NAMES are as much of the contract as the values: a browser holding
        // a live session sends them back under these two, so renaming either
        // reads to everyone signed in as being logged out at once. They are also
        // the names the browser client, the invoke caller and the mock runtime
        // each read, and nothing else pins the four spellings equal.
        expect(String(tokenCookie).startsWith('LMDRSESSIONTKID=')).toBe(true);
        expect(String(csrfCookie).startsWith('LMDRSESSIONCSTK=')).toBe(true);
        expect(DEFAULT_SESSION_TOKEN_COOKIE_KEY).toBe('LMDRSESSIONTKID');
        expect(DEFAULT_SESSION_CSRF_COOKIE_KEY).toBe('LMDRSESSIONCSTK');
        // HttpOnly on the session token, readable on the CSRF one: the client
        // has to read the CSRF value to post it back.
        expect(String(tokenCookie)).toContain('HttpOnly');
        expect(String(csrfCookie)).not.toContain('HttpOnly');

        const token = String(tokenCookie).split(';')[0]!.split('=')[1]!;
        const [partitionHash, secret] = token.split(':');
        expect(partitionHash).toBe(nodeCrypto.createHmac('sha256', 'a-salt-value').update('user-123').digest('hex'));
        expect(secret).toMatch(/^[0-9a-f]{64}$/);

        // And the stored record is keyed by that hash, with only hashes at rest.
        const [record] = store.list();
        expect(record!.sessionKeyHash).toBe(partitionHash);
        expect(record!.secretHash).toBe(nodeCrypto.createHash('sha256').update(secret!).digest('hex'));
        expect(JSON.stringify(record)).not.toContain(secret);
    });
});
