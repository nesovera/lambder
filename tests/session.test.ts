/**
 * Session and Session Types Tests
 * 
 * This file tests session management functionality including:
 * - Session type safety
 * - Session lifecycle (create, fetch, update, delete, regenerate)
 * - Session validation and security
 * - Session controller operations
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import nodeCrypto from 'crypto';
import { decodeBody } from './helpers.js';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import LambderSessionManager, { LambderSessionDataRefreshError, LambderSessionReadError, type LambderSessionContext } from '../src/session/LambderSessionManager.js';
import LambderSessionController from '../src/session/LambderSessionController.js';
import { lambderGuard } from '../src/policies/LambderApiGuards.js';
import Lambder from '../src/core/Lambder.js';
import type { LambderRenderContext, LambderSessionRenderContext } from '../src/core/LambderContext.js';
import type { APIGatewayProxyEvent, Context } from 'aws-lambda';

// Mock DynamoDB
const ddbMock = mockClient(DynamoDBDocumentClient);

// Sessions store only hashes of the bearer secrets: mock items carry
// hashTok(<raw>) where the presented cookie carries <raw>.
const hashTok = (value: string) => nodeCrypto.createHash('sha256').update(value).digest('hex');

// Test session data types
interface UserSessionData {
    userId: string;
    username: string;
    role: 'admin' | 'user' | 'guest';
    preferences?: {
        theme: 'light' | 'dark';
        language: string;
    };
}

interface AdminSessionData extends UserSessionData {
    role: 'admin';
    permissions: string[];
}

describe('Session Type Safety', () => {
    it('should correctly type LambderSessionContext', () => {
        // Type test: LambderSessionContext should have correct structure
        const session: LambderSessionContext<UserSessionData> = {
            csrfTokenHash: 'csrf-token-hash',
            sessionKey: 'user-123',
            data: {
                userId: '123',
                username: 'testuser',
                role: 'user',
            },
            createdAt: Date.now(),
            expiresAt: Date.now() + 3600000,
            lastAccessedAt: Date.now(),
            ttlInSeconds: 3600,
        };

        expect(session.data.userId).toBe('123');
        expect(session.data.role).toBe('user');
    });

    it('should correctly type LambderSessionRenderContext', () => {
        // Type test: Session render context should extend regular context
        const sessionCtx = {
            host: 'localhost',
            path: '/test',
            pathParams: {},
            method: 'GET',
            get: {},
            post: {},
            cookie: {},
            session: {
                csrfTokenHash: 'csrf-token-hash',
                sessionKey: 'user-123',
                data: {
                    userId: '123',
                    username: 'testuser',
                    role: 'admin' as const,
                    permissions: ['read', 'write'],
                },
                createdAt: Date.now(),
                expiresAt: Date.now() + 3600000,
                lastAccessedAt: Date.now(),
                ttlInSeconds: 3600,
            },
            apiName: '',
            apiPayload: {},
            headers: {},
            rawBody: '',
            ip: '',
            header: () => undefined,
            event: {} as any,
            lambdaContext: {} as any,
            _otherInternal: {
                isApiCall: false,
                requestVersion: null,
                eventFormat: 'v1' as const,
                setHeaderFnAccumulator: [],
                addHeaderFnAccumulator: [],
                logToApiResponseAccumulator: [],
            },
        } as LambderSessionRenderContext<any, AdminSessionData>;

        // Type assertions - these should compile
        expect(sessionCtx.session.data.userId).toBe('123');
        expect(sessionCtx.session.data.role).toBe('admin');
        expect(sessionCtx.session.data.permissions).toContain('read');
    });
});

describe('LambderSessionManager', () => {
    let sessionManager: LambderSessionManager;

    beforeEach(() => {
        ddbMock.reset();
        sessionManager = new LambderSessionManager({
            tableName: 'test-sessions',
            tableRegion: 'us-east-1',
            partitionKey: 'pk',
            sortKey: 'sk',
            sessionSalt: 'test-salt-12345',
            enableSlidingExpiration: true,
        });
    });

    describe('createSession', () => {
        it('should create a new session with correct structure', async () => {
            ddbMock.on(PutCommand).resolves({});

            const sessionData: UserSessionData = {
                userId: '123',
                username: 'testuser',
                role: 'user',
            };

            const { session, sessionToken, csrfToken } = await sessionManager.createSession('user-123', sessionData, 3600);

            expect(session).toBeDefined();
            expect(sessionToken).toBeDefined();
            expect(csrfToken).toBeDefined();
            expect(session.sessionKey).toBe('user-123');
            expect(session.data).toEqual(sessionData);
            expect(session.createdAt).toBeDefined();
            expect(session.expiresAt).toBeDefined();
            expect(session.ttlInSeconds).toBe(3600);
        });

        it('stores only hashes of the bearer secrets, never the raw tokens', async () => {
            ddbMock.on(PutCommand).resolves({});

            const { sessionToken, csrfToken } = await sessionManager.createSession('user-123', {}, 3600);

            const putItem = ddbMock.commandCalls(PutCommand)[0]!.args[0].input.Item!;
            const sortKeySecret = sessionToken.split(':')[1]!;
            // The range key is the hash of the cookie's secret half; the CSRF
            // token is stored as its hash. Neither raw value appears anywhere
            // in the record, so a table read yields no usable cookies.
            expect(putItem.sk).toBe(hashTok(sortKeySecret));
            expect(putItem.csrfTokenHash).toBe(hashTok(csrfToken));
            const serialized = JSON.stringify(putItem);
            expect(serialized).not.toContain(sortKeySecret);
            expect(serialized).not.toContain(csrfToken);
            expect(putItem.sessionToken).toBe(undefined);
            expect(putItem.csrfToken).toBe(undefined);
        });

        it('should create session with default TTL', async () => {
            ddbMock.on(PutCommand).resolves({});

            const { session } = await sessionManager.createSession('user-123', {});

            expect(session.ttlInSeconds).toBe(30 * 24 * 60 * 60); // 30 days default
        });

        it('should generate unique session tokens', async () => {
            ddbMock.on(PutCommand).resolves({});

            const created1 = await sessionManager.createSession('user-123', {});
            const created2 = await sessionManager.createSession('user-123', {});

            expect(created1.sessionToken).not.toBe(created2.sessionToken);
            expect(created1.csrfToken).not.toBe(created2.csrfToken);
        });
    });

    describe('getSession', () => {
        it('should retrieve a valid session', async () => {
            const mockSession = {
                pk: 'hashed-key',
                sk: hashTok('sort-key'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: { userId: '123', username: 'testuser', role: 'user' },
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            ddbMock.on(GetCommand).resolves({ Item: mockSession });
            ddbMock.on(PutCommand).resolves({});

            const session = await sessionManager.getSession('hashed-key:sort-key');

            expect(session).toBeDefined();
            expect(session?.sessionKey).toBe('user-123');
            expect(session?.data.userId).toBe('123');
        });

        it('should return null for invalid session token format', async () => {
            const session = await sessionManager.getSession('invalid-token');
            expect(session).toBeNull();
        });

        it('should return null for expired session', async () => {
            const expiredSession = {
                pk: 'hashed-key',
                sk: hashTok('sort-key'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: {},
                createdAt: Math.floor(Date.now() / 1000) - 7200,
                expiresAt: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
                lastAccessedAt: Math.floor(Date.now() / 1000) - 7200,
                ttlInSeconds: 3600,
            };

            ddbMock.on(GetCommand).resolves({ Item: expiredSession });

            const session = await sessionManager.getSession('hashed-key:sort-key');
            expect(session).toBeNull();
        });

        it('should return null for non-existent session', async () => {
            ddbMock.on(GetCommand).resolves({});

            const session = await sessionManager.getSession('hashed-key:sort-key');
            expect(session).toBeNull();
        });

        it('propagates DynamoDB read failures as LambderSessionReadError instead of null', async () => {
            // Null would read as sessionExpired and make the caller clear the
            // client's cookies: an infra blip must not force a logout.
            ddbMock.on(GetCommand).rejects(new Error('ddb down'));

            await expect(sessionManager.getSession('hashed-key:sort-key'))
                .rejects.toBeInstanceOf(LambderSessionReadError);
        });

        it('should update lastAccessedAt with sliding expiration', async () => {
            const mockSession = {
                pk: 'hashed-key',
                sk: hashTok('sort-key'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: {},
                createdAt: Math.floor(Date.now() / 1000) - 1800,
                expiresAt: Math.floor(Date.now() / 1000) + 1800,
                lastAccessedAt: Math.floor(Date.now() / 1000) - 1800,
                ttlInSeconds: 3600,
            };

            ddbMock.on(GetCommand).resolves({ Item: mockSession });
            ddbMock.on(PutCommand).resolves({});

            const session = await sessionManager.getSession('hashed-key:sort-key');

            expect(session).toBeDefined();
            // Note: The update happens async, so we just verify session is returned
        });
    });

    describe('isSessionValid', () => {
        it('should validate a correct session', () => {
            const session = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: {},
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            const isValid = sessionManager.isSessionValid(
                session,
                'hash:sortkey',
                'csrf-token'
            );

            expect(isValid).toBe(true);
        });

        it('should reject session with wrong token', () => {
            const session = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: {},
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            const isValid = sessionManager.isSessionValid(
                session,
                'wrong:token',
                'csrf-token'
            );

            expect(isValid).toBe(false);
        });

        it('should reject session with wrong CSRF token', () => {
            const session = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: {},
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            const isValid = sessionManager.isSessionValid(
                session,
                'hash:sortkey',
                'wrong-csrf'
            );

            expect(isValid).toBe(false);
        });

        it('should skip CSRF validation when requested', () => {
            const session = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: {},
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            const isValid = sessionManager.isSessionValid(
                session,
                'hash:sortkey',
                null,
                true // Skip CSRF check
            );

            expect(isValid).toBe(true);
        });

        it('should reject expired session', () => {
            const session = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: {},
                createdAt: Math.floor(Date.now() / 1000) - 7200,
                expiresAt: Math.floor(Date.now() / 1000) - 3600, // Expired
                lastAccessedAt: Math.floor(Date.now() / 1000) - 7200,
                ttlInSeconds: 3600,
            };

            const isValid = sessionManager.isSessionValid(
                session,
                'hash:sortkey',
                'csrf-token'
            );

            expect(isValid).toBe(false);
        });
    });

    describe('updateSessionData', () => {
        it('should update session data', async () => {
            const session: LambderSessionContext<UserSessionData> = {
                pk: 'hashed-key',
                sk: hashTok('sort-key'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: {
                    userId: '123',
                    username: 'testuser',
                    role: 'user',
                },
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            ddbMock.on(PutCommand).resolves({});

            const updatedData: UserSessionData = {
                ...session.data,
                preferences: { theme: 'dark', language: 'en' },
            };

            const updatedSession = await sessionManager.updateSessionData(session, updatedData);

            expect(updatedSession.data.preferences?.theme).toBe('dark');
            expect(updatedSession.lastAccessedAt).toBeGreaterThanOrEqual(session.lastAccessedAt);
        });

        it('should extend expiration with sliding expiration enabled', async () => {
            const session: LambderSessionContext = {
                pk: 'hashed-key',
                sk: hashTok('sort-key'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: {},
                createdAt: Math.floor(Date.now() / 1000) - 1800,
                expiresAt: Math.floor(Date.now() / 1000) + 1800,
                lastAccessedAt: Math.floor(Date.now() / 1000) - 1800,
                ttlInSeconds: 3600,
            };

            ddbMock.on(PutCommand).resolves({});

            const originalExpiresAt = session.expiresAt;
            const updatedSession = await sessionManager.updateSessionData(session, { updated: true });

            expect(updatedSession.expiresAt).toBeGreaterThan(originalExpiresAt);
        });
    });

    describe('deleteSession', () => {
        it('should delete a session', async () => {
            ddbMock.on(DeleteCommand).resolves({});

            const session = {
                pk: 'hashed-key',
                sk: hashTok('sort-key'),
            };

            const result = await sessionManager.deleteSession(session);
            expect(result).toBe(true);
        });
    });

    describe('regenerateSession', () => {
        it('should regenerate session with new tokens', async () => {
            const originalSession: LambderSessionContext<UserSessionData> = {
                pk: 'hashed-key',
                sk: hashTok('sort-key'),
                csrfTokenHash: hashTok('old-csrf-token'),
                sessionKey: 'user-123',
                data: {
                    userId: '123',
                    username: 'testuser',
                    role: 'user',
                },
                createdAt: Math.floor(Date.now() / 1000) - 1800,
                expiresAt: Math.floor(Date.now() / 1000) + 1800,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            ddbMock.on(DeleteCommand).resolves({});
            ddbMock.on(PutCommand).resolves({});

            const { session: newSession, sessionToken, csrfToken } = await sessionManager.regenerateSession(originalSession);

            // Fresh raw secrets, stored only as hashes on the new record.
            expect(newSession.sk).toBe(hashTok(sessionToken.split(':')[1]!));
            expect(newSession.sk).not.toBe(originalSession.sk);
            expect(newSession.csrfTokenHash).toBe(hashTok(csrfToken));
            expect(newSession.csrfTokenHash).not.toBe(originalSession.csrfTokenHash);
            expect(newSession.sessionKey).toBe(originalSession.sessionKey);
            expect(newSession.data).toEqual(originalSession.data);
            expect(newSession.ttlInSeconds).toBe(originalSession.ttlInSeconds);
        });
    });

    describe('deleteSessionAll', () => {
        it('should delete all sessions for a partition key', async () => {
            const mockSessions = [
                { pk: 'hashed-key', sk: 'sort-key-1' },
                { pk: 'hashed-key', sk: 'sort-key-2' },
            ];

            ddbMock.on(QueryCommand).resolves({ Items: mockSessions });
            ddbMock.on(DeleteCommand).resolves({});

            const session = { pk: 'hashed-key', sk: 'sort-key-1' };
            const result = await sessionManager.deleteSessionAll(session);

            expect(result).toBe(true);
        });
    });
});

describe('LambderSessionController', () => {
    let sessionManager: LambderSessionManager;
    let sessionController: LambderSessionController<UserSessionData>;
    let mockCtx: LambderRenderContext<any> & { session: LambderSessionContext<UserSessionData> | null };

    beforeEach(() => {
        ddbMock.reset();
        
        sessionManager = new LambderSessionManager({
            tableName: 'test-sessions',
            tableRegion: 'us-east-1',
            partitionKey: 'pk',
            sortKey: 'sk',
            sessionSalt: 'test-salt-12345',
        });

        mockCtx = {
            host: 'localhost',
            path: '/test',
            pathParams: {},
            method: 'POST',
            get: {},
            post: { token: 'csrf-token' },
            cookie: { sessionToken: 'hash:sortkey' },
            session: null,
            apiName: 'test.api',
            apiPayload: {},
            headers: {},
            rawBody: '',
            ip: '',
            header: () => undefined,
            event: {} as any,
            lambdaContext: {} as any,
            _otherInternal: {
                isApiCall: true,
                requestVersion: '1.0',
                eventFormat: 'v1' as const,
                setHeaderFnAccumulator: [],
                addHeaderFnAccumulator: [],
                logToApiResponseAccumulator: [],
            },
        };

        sessionController = new LambderSessionController({
            lambderSessionManager: sessionManager,
            sessionTokenCookieKey: 'sessionToken',
            sessionCsrfCookieKey: 'csrfToken',
            ctx: mockCtx,
        });
    });

    describe('createSession', () => {
        it('should create session and set cookies', async () => {
            ddbMock.on(PutCommand).resolves({});

            const sessionData: UserSessionData = {
                userId: '123',
                username: 'testuser',
                role: 'user',
            };

            const session = await sessionController.createSession('user-123', sessionData);

            expect(session).toBeDefined();
            expect(session.data).toEqual(sessionData);
            expect(mockCtx._otherInternal.addHeaderFnAccumulator.length).toBeGreaterThan(0);
            
            // Check that Set-Cookie headers were added
            const cookieHeaders = mockCtx._otherInternal.addHeaderFnAccumulator.filter(
                h => h.key === 'Set-Cookie'
            );
            expect(cookieHeaders.length).toBe(2); // Session token and CSRF token
        });
    });

    describe('fetchSession', () => {
        it('should fetch and validate session', async () => {
            const mockSession = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: { userId: '123', username: 'testuser', role: 'user' },
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            ddbMock.on(GetCommand).resolves({ Item: mockSession });
            ddbMock.on(PutCommand).resolves({});

            const session = await sessionController.fetchSession();

            expect(session).toBeDefined();
            expect(session.data.userId).toBe('123');
            expect(mockCtx.session).toBe(session);
        });

        it('should throw error if session tokens are invalid', async () => {
            mockCtx.cookie = {}; // No session token

            await expect(sessionController.fetchSession()).rejects.toThrow('Session tokens are invalid');
        });
    });

    describe('fetchSessionIfExists', () => {
        it('should return null if session does not exist', async () => {
            mockCtx.cookie = {}; // No session token

            const session = await sessionController.fetchSessionIfExists();
            expect(session).toBeNull();
        });

        it('should return session if it exists', async () => {
            const mockSession = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: { userId: '123', username: 'testuser', role: 'user' },
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            ddbMock.on(GetCommand).resolves({ Item: mockSession });
            ddbMock.on(PutCommand).resolves({});

            const session = await sessionController.fetchSessionIfExists();
            expect(session).toBeDefined();
            expect(session?.data.userId).toBe('123');
        });
    });

    describe('regenerateSession', () => {
        it('should regenerate session and update cookies', async () => {
            const originalSession: LambderSessionContext<UserSessionData> = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: { userId: '123', username: 'testuser', role: 'user' },
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            (mockCtx as any).session = originalSession;

            ddbMock.on(DeleteCommand).resolves({});
            ddbMock.on(PutCommand).resolves({});

            const newSession = await sessionController.regenerateSession();

            // Fresh secrets: new hashes at rest, new raw values in the cookies.
            expect(newSession.sk).not.toBe(originalSession.sk);
            expect(newSession.csrfTokenHash).not.toBe(originalSession.csrfTokenHash);

            const cookieHeaders = mockCtx._otherInternal.addHeaderFnAccumulator.filter(
                h => h.key === 'Set-Cookie'
            );
            expect(cookieHeaders.length).toBe(2);
            // The cookie carries the raw secret whose hash is the record's range key.
            const tokenCookie = cookieHeaders.find(h => h.value.startsWith('sessionToken='))!.value;
            const rawSecret = tokenCookie.split(';')[0]!.split(':')[1]!;
            expect(hashTok(rawSecret)).toBe(newSession.sk);
        });

        it('should throw error if no session exists', async () => {
            mockCtx.session = null;

            await expect(sessionController.regenerateSession()).rejects.toThrow('Session not found');
        });
    });

    describe('updateSessionData', () => {
        it('should update session data', async () => {
            const session: LambderSessionContext<UserSessionData> = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: { userId: '123', username: 'testuser', role: 'user' },
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            (mockCtx as any).session = session;

            ddbMock.on(PutCommand).resolves({});

            const newData: UserSessionData = {
                ...session.data,
                preferences: { theme: 'dark', language: 'en' },
            };

            const updatedSession = await sessionController.updateSessionData(newData);

            expect(updatedSession.data.preferences?.theme).toBe('dark');
        });
    });

    describe('endSession', () => {
        it('should delete session and clear cookies', async () => {
            const session: LambderSessionContext<UserSessionData> = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: { userId: '123', username: 'testuser', role: 'user' },
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            (mockCtx as any).session = session;

            ddbMock.on(DeleteCommand).resolves({});

            await sessionController.endSession();

            expect(mockCtx.session).toBeNull();
            
            const cookieHeaders = mockCtx._otherInternal.addHeaderFnAccumulator.filter(
                h => h.key === 'Set-Cookie'
            );
            expect(cookieHeaders.length).toBe(2);
            
            // Verify cookies are expired
            cookieHeaders.forEach(header => {
                expect(header.value).toContain('Expires=');
            });
        });
    });

    describe('endSessionAll', () => {
        it('should delete all sessions and clear cookies', async () => {
            const session: LambderSessionContext<UserSessionData> = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: { userId: '123', username: 'testuser', role: 'user' },
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            (mockCtx as any).session = session;

            const mockSessions = [
                { pk: 'hash', sk: 'sortkey' },
                { pk: 'hash', sk: 'sortkey2' },
            ];

            ddbMock.on(QueryCommand).resolves({ Items: mockSessions });
            ddbMock.on(DeleteCommand).resolves({});

            await sessionController.endSessionAll();

            expect(mockCtx.session).toBeNull();
        });
    });
});

describe('Session Endpoint Protection', () => {
    let lambder: Lambder<UserSessionData>;
    
    const createMockEvent = (path: string, method: string, sessionToken?: string, apiName?: string, payload?: any, csrfToken?: string): APIGatewayProxyEvent => {
        const cookieHeader = sessionToken ? `LMDRSESSIONTKID=${sessionToken}` : '';
        return {
            body: apiName ? JSON.stringify({ 
                apiName, 
                payload: payload || {}, 
                token: csrfToken ?? 'csrf-token' 
            }) : null,
            headers: {
                Host: 'localhost',
                Cookie: cookieHeader,
            },
            multiValueHeaders: {},
            httpMethod: method,
            isBase64Encoded: false,
            path,
            pathParameters: null,
            queryStringParameters: null,
            multiValueQueryStringParameters: null,
            stageVariables: null,
            requestContext: {} as any,
            resource: '',
        };
    };

    const createMockContext = (): Context => ({
        callbackWaitsForEmptyEventLoop: false,
        functionName: 'test',
        functionVersion: '1',
        invokedFunctionArn: 'arn',
        memoryLimitInMB: '128',
        awsRequestId: 'request-id',
        logGroupName: 'log-group',
        logStreamName: 'log-stream',
        getRemainingTimeInMillis: () => 1000,
        done: () => {},
        fail: () => {},
        succeed: () => {},
    });

    beforeEach(() => {
        ddbMock.reset();
        
        lambder = new Lambder({
            publicPath: '/public',
            apiPath: '/api',
        })
            .enableDdbSession(
                {
                    tableName: 'test-sessions',
                    tableRegion: 'us-east-1',
                    sessionSalt: 'test-salt',
                    partitionKey: 'pk',
                    sortKey: 'sk',
                }
            )
            // Set up error handler to expose actual error messages for testing
            .setGlobalErrorHandler((err, ctx, responseBuilder) => {
                if (ctx?._otherInternal.isApiCall) {
                    return responseBuilder.api({ error: err.message });
                }
                return responseBuilder.html(`<h1>Error: ${err.message}</h1>`);
            });
    });

    describe('addSessionRoute', () => {
        it('should throw error when no session exists', async () => {
            ddbMock.on(GetCommand).resolves({}); // No session found

            lambder.addSessionRoute('/protected', async (ctx, resolver) => {
                return resolver.html('<h1>Protected Page</h1>');
            });

            const event = createMockEvent('/protected', 'GET', 'hash:sortkey');
            const context = createMockContext();

            const response = await lambder.render(event, context);

            // Missing sessions on routes short-circuit to a 401 response.
            expect(response.statusCode).toBe(401);
            expect(decodeBody(response)).toContain('Session required');
        });

        it('should succeed when valid session exists', async () => {
            const mockSession = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: { userId: '123', username: 'testuser', role: 'user' },
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            ddbMock.on(GetCommand).resolves({ Item: mockSession });
            ddbMock.on(PutCommand).resolves({});

            lambder.addSessionRoute('/protected', async (ctx, resolver) => {
                return resolver.html('<h1>Protected Page</h1>');
            });

            const event = createMockEvent('/protected', 'GET', 'hash:sortkey');
            const context = createMockContext();

            const response = await lambder.render(event, context);

            expect(response.statusCode).toBe(200);
            expect(decodeBody(response)).toContain('Protected Page');
        });

        it('should throw error when session is expired', async () => {
            const expiredSession = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: { userId: '123' },
                createdAt: Math.floor(Date.now() / 1000) - 7200,
                expiresAt: Math.floor(Date.now() / 1000) - 3600, // Expired
                lastAccessedAt: Math.floor(Date.now() / 1000) - 7200,
                ttlInSeconds: 3600,
            };

            ddbMock.on(GetCommand).resolves({ Item: expiredSession });

            lambder.addSessionRoute('/protected', async (ctx, resolver) => {
                return resolver.html('<h1>Protected Page</h1>');
            });

            const event = createMockEvent('/protected', 'GET', 'hash:sortkey');
            const context = createMockContext();

            const response = await lambder.render(event, context);

            // Expired sessions on routes short-circuit to a 401 response.
            expect(response.statusCode).toBe(401);
            expect(decodeBody(response)).toContain('Session required');
        });
    });

    describe('addSessionApi', () => {
        it('should throw error when no session exists', async () => {
            ddbMock.on(GetCommand).resolves({}); // No session found

            lambder.addSessionApi('user.profile', {
                input: z.any(),
                output: z.any()
            }, async (ctx, resolver) => {
                return resolver.api({ userId: ctx.session.data.userId });
            });

            const event = createMockEvent('/api', 'POST', 'hash:sortkey', 'user.profile');
            const context = createMockContext();

            const response = await lambder.render(event, context);

            // Missing sessions on APIs return the protocol's sessionExpired flag
            // (LambderCaller clears cookies and calls sessionExpiredHandler).
            const body = JSON.parse(decodeBody(response) || '{}');
            expect(body.sessionExpired).toBe(true);
            expect(body.payload ?? null).toBeNull();
        });

        it('should succeed when valid session exists', async () => {
            const mockSession = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: { userId: '123', username: 'testuser', role: 'user' },
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            ddbMock.on(GetCommand).resolves({ Item: mockSession });
            ddbMock.on(PutCommand).resolves({});

            lambder.addSessionApi('user.profile', {
                input: z.any(),
                output: z.any()
            }, async (ctx, resolver) => {
                return resolver.api({ userId: ctx.session.data.userId });
            });

            const event = createMockEvent('/api', 'POST', 'hash:sortkey', 'user.profile');
            const context = createMockContext();

            const response = await lambder.render(event, context);

            const body = JSON.parse(decodeBody(response) || '{}');
            expect(body.payload?.userId).toBe('123');
        });

        it('session guards see ctx.session, receive their param, and feed ctx.guardData', async () => {
            const mockSession = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: { userId: '123', role: 'admin' },
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };
            ddbMock.on(GetCommand).resolves({ Item: mockSession });
            ddbMock.on(PutCommand).resolves({});

            lambder
                .defineApiGuards({
                    orgPermission: lambderGuard({
                        session: true,
                        handler: (ctx, _payload, _res, permission: string) => {
                            // The session is fetched before guards run on session APIs.
                            return { subject: ctx.session.sessionKey, permission };
                        },
                    }),
                })
                .addSessionApi('org.action', {
                    input: z.any(),
                    output: z.any(),
                    guards: { orgPermission: 'ORG.MANAGE' },
                }, async (ctx, resolver) => {
                    return resolver.api(ctx.guardData.orgPermission);
                });

            const event = createMockEvent('/api', 'POST', 'hash:sortkey', 'org.action');
            const response = await lambder.render(event, createMockContext());

            const body = JSON.parse(decodeBody(response) || '{}');
            expect(body.payload).toEqual({ subject: 'user-123', permission: 'ORG.MANAGE' });
        });

        it('should throw error when CSRF token is missing', async () => {
            const mockSession = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: { userId: '123' },
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            ddbMock.on(GetCommand).resolves({ Item: mockSession });

            lambder.addSessionApi('user.profile', {
                input: z.any(),
                output: z.any()
            }, async (ctx, resolver) => {
                return resolver.api({ userId: ctx.session.data.userId });
            });

            // Create event without CSRF token
            const event = createMockEvent('/api', 'POST', 'hash:sortkey', 'user.profile', {}, ''); // Empty CSRF token
            const context = createMockContext();

            const response = await lambder.render(event, context);

            const body = JSON.parse(decodeBody(response) || '{}');
            expect(body.sessionExpired).toBe(true);
        });

        it('should throw error when CSRF token is invalid', async () => {
            const mockSession = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: { userId: '123' },
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            ddbMock.on(GetCommand).resolves({ Item: mockSession });

            lambder.addSessionApi('user.profile', {
                input: z.any(),
                output: z.any()
            }, async (ctx, resolver) => {
                return resolver.api({ userId: ctx.session.data.userId });
            });

            // Create event with wrong CSRF token
            const event = createMockEvent('/api', 'POST', 'hash:sortkey', 'user.profile', {}, 'wrong-csrf-token');
            const context = createMockContext();

            const response = await lambder.render(event, context);

            const body = JSON.parse(decodeBody(response) || '{}');
            expect(body.sessionExpired).toBe(true);
        });

        it('should have typed session data in context', async () => {
            const mockSession = {
                pk: 'hash',
                sk: hashTok('sortkey'),
                csrfTokenHash: hashTok('csrf-token'),
                sessionKey: 'user-123',
                data: { userId: '123', username: 'testuser', role: 'admin' as const },
                createdAt: Math.floor(Date.now() / 1000),
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
                lastAccessedAt: Math.floor(Date.now() / 1000),
                ttlInSeconds: 3600,
            };

            ddbMock.on(GetCommand).resolves({ Item: mockSession });
            ddbMock.on(PutCommand).resolves({});

            lambder.addSessionApi('user.profile', {
                input: z.any(),
                output: z.any()
            }, async (ctx, resolver) => {
                // Type test: ctx.session.data should have UserSessionData type
                const userId: string = ctx.session.data.userId;
                const username: string = ctx.session.data.username;
                const role: 'admin' | 'user' | 'guest' = ctx.session.data.role;
                
                return resolver.api({ userId, username, role });
            });

            const event = createMockEvent('/api', 'POST', 'hash:sortkey', 'user.profile');
            const context = createMockContext();

            const response = await lambder.render(event, context);

            const body = JSON.parse(decodeBody(response) || '{}');
            expect(body.payload?.userId).toBe('123');
            expect(body.payload?.username).toBe('testuser');
            expect(body.payload?.role).toBe('admin');
        });
    });

    describe('addSessionApi with dataRefresh', () => {
        const staleSession = () => ({
            pk: 'hash',
            sk: hashTok('sortkey'),
            csrfTokenHash: hashTok('csrf-token'),
            sessionKey: 'user-123',
            data: { userId: '123', username: 'testuser', role: 'user' as const },
            createdAt: Math.floor(Date.now() / 1000) - 1200,
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            lastAccessedAt: Math.floor(Date.now() / 1000),
            ttlInSeconds: 3600,
            dataExpiresAt: Math.floor(Date.now() / 1000) - 10, // Stale data
        });

        const makeRefreshingLambder = (refresh: (session: LambderSessionContext<UserSessionData>) => Promise<UserSessionData | null>) =>
            new Lambder<UserSessionData>({ publicPath: '/public', apiPath: '/api' })
                .enableDdbSession({
                    tableName: 'test-sessions',
                    tableRegion: 'us-east-1',
                    sessionSalt: 'test-salt',
                    partitionKey: 'pk',
                    sortKey: 'sk',
                    dataRefresh: { ttlSeconds: 600, refresh },
                });

        it('should hand handlers renewed data when the session data is stale', async () => {
            ddbMock.on(GetCommand).resolves({ Item: staleSession() });
            ddbMock.on(PutCommand).resolves({});

            const refreshingLambder = makeRefreshingLambder(
                async (session) => ({ ...session.data, role: 'admin' as const })
            );
            refreshingLambder.addSessionApi('user.profile', {
                input: z.any(),
                output: z.any()
            }, async (ctx, resolver) => {
                return resolver.api({ role: ctx.session.data.role });
            });

            const response = await refreshingLambder.render(
                createMockEvent('/api', 'POST', 'hash:sortkey', 'user.profile'),
                createMockContext()
            );

            const body = JSON.parse(decodeBody(response) || '{}');
            expect(body.payload?.role).toBe('admin');
        });

        it('should answer sessionExpired when the refresh callback ends the session', async () => {
            ddbMock.on(GetCommand).resolves({ Item: staleSession() });
            ddbMock.on(DeleteCommand).resolves({});

            const refreshingLambder = makeRefreshingLambder(async () => null);
            refreshingLambder.addSessionApi('user.profile', {
                input: z.any(),
                output: z.any()
            }, async (ctx, resolver) => {
                return resolver.api({ role: ctx.session.data.role });
            });

            const response = await refreshingLambder.render(
                createMockEvent('/api', 'POST', 'hash:sortkey', 'user.profile'),
                createMockContext()
            );

            const body = JSON.parse(decodeBody(response) || '{}');
            expect(body.sessionExpired).toBe(true);
        });
    });
});

// ── dataRefresh: opt-in freshness for session.data ───────────────────────────

describe('LambderSessionManager dataRefresh', () => {
    const nowSec = () => Math.floor(Date.now() / 1000);

    const makeSessionItem = (overrides: Record<string, any> = {}) => ({
        pk: 'hashed-key',
        sk: hashTok('sort-key'),
        csrfTokenHash: hashTok('csrf-token'),
        sessionKey: 'user-123',
        data: { role: 'user' },
        createdAt: nowSec() - 1000,
        expiresAt: nowSec() + 3600,
        lastAccessedAt: nowSec(), // Recent: no sliding write due
        ttlInSeconds: 3600,
        ...overrides,
    });

    const makePlainManager = () => new LambderSessionManager({
        tableName: 'test-sessions',
        tableRegion: 'us-east-1',
        partitionKey: 'pk',
        sortKey: 'sk',
        sessionSalt: 'test-salt-12345',
    });

    const makeManager = (refresh: (session: LambderSessionContext) => Promise<any>) =>
        new LambderSessionManager({
            tableName: 'test-sessions',
            tableRegion: 'us-east-1',
            partitionKey: 'pk',
            sortKey: 'sk',
            sessionSalt: 'test-salt-12345',
            enableSlidingExpiration: true,
            dataRefresh: { ttlSeconds: 600, refresh },
        });

    beforeEach(() => { ddbMock.reset(); });

    it('createSession stamps dataExpiresAt only when configured', async () => {
        ddbMock.on(PutCommand).resolves({});

        const { session } = await makeManager(async (s) => s.data).createSession('user-123', {}, 3600);
        expect(session.dataExpiresAt).toBeGreaterThanOrEqual(nowSec() + 599);

        const { session: plainSession } = await makePlainManager().createSession('user-123', {}, 3600);
        expect(plainSession.dataExpiresAt).toBeUndefined();
    });

    it('does not run refresh before dataExpiresAt', async () => {
        const refresh = vi.fn(async () => ({ role: 'admin' }));
        ddbMock.on(GetCommand).resolves({ Item: makeSessionItem({ dataExpiresAt: nowSec() + 600 }) });
        ddbMock.on(PutCommand).resolves({});

        const session = await makeManager(refresh).getSession('hashed-key:sort-key');

        expect(refresh).not.toHaveBeenCalled();
        expect(session?.data).toEqual({ role: 'user' });
    });

    it('renews stale data and shares one put with the sliding-expiration write', async () => {
        const refresh = vi.fn(async () => ({ role: 'admin' }));
        // Stale data AND a due sliding write: both updates must share one put.
        ddbMock.on(GetCommand).resolves({ Item: makeSessionItem({
            dataExpiresAt: nowSec() - 10,
            lastAccessedAt: nowSec() - 3000,
        }) });
        ddbMock.on(PutCommand).resolves({});

        const session = await makeManager(refresh).getSession('hashed-key:sort-key');

        expect(refresh).toHaveBeenCalledOnce();
        expect(session?.data).toEqual({ role: 'admin' });
        expect(session?.dataExpiresAt).toBeGreaterThanOrEqual(nowSec() + 599);

        const puts = ddbMock.commandCalls(PutCommand);
        expect(puts.length).toBe(1);
        expect(puts[0]!.args[0].input.Item?.data).toEqual({ role: 'admin' });
    });

    it('renews legacy records that predate dataRefresh on first read', async () => {
        const refresh = vi.fn(async () => ({ role: 'admin' }));
        ddbMock.on(GetCommand).resolves({ Item: makeSessionItem() }); // No dataExpiresAt
        ddbMock.on(PutCommand).resolves({});

        const session = await makeManager(refresh).getSession('hashed-key:sort-key');

        expect(refresh).toHaveBeenCalledOnce();
        expect(session?.data).toEqual({ role: 'admin' });
    });

    it('refresh returning null deletes the session and reports no session', async () => {
        ddbMock.on(GetCommand).resolves({ Item: makeSessionItem({ dataExpiresAt: nowSec() - 10 }) });
        ddbMock.on(DeleteCommand).resolves({});

        const session = await makeManager(async () => null).getSession('hashed-key:sort-key');

        expect(session).toBeNull();
        expect(ddbMock.commandCalls(DeleteCommand).length).toBe(1);
    });

    it('a throwing refresh fails the read and keeps the session record', async () => {
        ddbMock.on(GetCommand).resolves({ Item: makeSessionItem({ dataExpiresAt: nowSec() - 10 }) });

        const manager = makeManager(async () => { throw new Error('db down'); });

        await expect(manager.getSession('hashed-key:sort-key')).rejects.toBeInstanceOf(LambderSessionDataRefreshError);
        expect(ddbMock.commandCalls(DeleteCommand).length).toBe(0);
    });

    it('updateSessionData re-stamps dataExpiresAt', async () => {
        ddbMock.on(PutCommand).resolves({});
        const session = makeSessionItem({ dataExpiresAt: nowSec() - 10 }) as LambderSessionContext;

        const updated = await makeManager(async (s) => s.data).updateSessionData(session, { role: 'editor' });

        expect(updated.dataExpiresAt).toBeGreaterThanOrEqual(nowSec() + 599);
    });

    it('refreshSessionData forces a renewal even when data is fresh', async () => {
        const refresh = vi.fn(async () => ({ role: 'admin' }));
        ddbMock.on(PutCommand).resolves({});
        const session = makeSessionItem({ dataExpiresAt: nowSec() + 600 }) as LambderSessionContext;

        const refreshed = await makeManager(refresh).refreshSessionData(session);

        expect(refresh).toHaveBeenCalledOnce();
        expect(refreshed?.data).toEqual({ role: 'admin' });
    });

    it('refreshSessionData throws when dataRefresh is not configured', async () => {
        await expect(
            makePlainManager().refreshSessionData(makeSessionItem() as LambderSessionContext)
        ).rejects.toThrow('dataRefresh is not configured');
    });

    it('regenerateSession carries dataExpiresAt over instead of extending it', async () => {
        ddbMock.on(DeleteCommand).resolves({});
        ddbMock.on(PutCommand).resolves({});
        const oldStamp = nowSec() + 120;
        const session = makeSessionItem({ dataExpiresAt: oldStamp }) as LambderSessionContext;

        const regenerated = await makeManager(async (s) => s.data).regenerateSession(session);

        expect(regenerated.session.dataExpiresAt).toBe(oldStamp);
    });

    it('deleteSessionAllByKey derives the partition key internally', async () => {
        ddbMock.on(QueryCommand).resolves({ Items: [{ pk: 'x', sk: 'a' }, { pk: 'x', sk: 'b' }] });
        ddbMock.on(DeleteCommand).resolves({});

        await makeManager(async (s) => s.data).deleteSessionAllByKey('user-123');

        const expectedPk = nodeCrypto.createHash('sha256').update('user-123test-salt-12345').digest('hex');
        const query = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
        expect(query.ExpressionAttributeValues?.[':pv']).toBe(expectedPk);
        expect(ddbMock.commandCalls(DeleteCommand).length).toBe(2);
    });
});

describe('LambderSessionController dataRefresh', () => {
    const nowSec = () => Math.floor(Date.now() / 1000);

    const makeCtx = (): any => ({
        host: 'localhost',
        path: '/test',
        pathParams: {},
        method: 'POST',
        get: {},
        post: { token: 'csrf-token' },
        cookie: { sessionToken: 'hashed-key:sort-key' },
        session: null,
        apiName: 'test.api',
        apiPayload: {},
        headers: {},
        rawBody: '',
        ip: '',
        header: () => undefined,
        event: {} as any,
        lambdaContext: {} as any,
        _otherInternal: {
            isApiCall: true,
            requestVersion: '1.0',
            eventFormat: 'v1' as const,
            setHeaderFnAccumulator: [],
            addHeaderFnAccumulator: [],
            logToApiResponseAccumulator: [],
        },
    });

    const makeController = (refresh: (session: LambderSessionContext) => Promise<any>) => {
        const manager = new LambderSessionManager({
            tableName: 'test-sessions',
            tableRegion: 'us-east-1',
            partitionKey: 'pk',
            sortKey: 'sk',
            sessionSalt: 'test-salt-12345',
            dataRefresh: { ttlSeconds: 600, refresh },
        });
        const ctx = makeCtx();
        const controller = new LambderSessionController({
            lambderSessionManager: manager,
            sessionTokenCookieKey: 'sessionToken',
            sessionCsrfCookieKey: 'csrfToken',
            ctx,
        });
        return { controller, ctx };
    };

    const makeSessionItem = (overrides: Record<string, any> = {}) => ({
        pk: 'hashed-key',
        sk: hashTok('sort-key'),
        csrfTokenHash: hashTok('csrf-token'),
        sessionKey: 'user-123',
        data: { role: 'user' },
        createdAt: nowSec(),
        expiresAt: nowSec() + 3600,
        lastAccessedAt: nowSec(),
        ttlInSeconds: 3600,
        ...overrides,
    });

    beforeEach(() => { ddbMock.reset(); });

    it('refreshSessionData updates ctx.session in place', async () => {
        const { controller, ctx } = makeController(async () => ({ role: 'admin' }));
        ctx.session = makeSessionItem({ dataExpiresAt: nowSec() + 600 });
        ddbMock.on(PutCommand).resolves({});

        const refreshed = await controller.refreshSessionData();

        expect(refreshed?.data).toEqual({ role: 'admin' });
        expect(ctx.session.data).toEqual({ role: 'admin' });
    });

    it('refreshSessionData ending the session clears cookies and nulls ctx.session', async () => {
        const { controller, ctx } = makeController(async () => null);
        ctx.session = makeSessionItem();
        ddbMock.on(DeleteCommand).resolves({});

        const refreshed = await controller.refreshSessionData();

        expect(refreshed).toBeNull();
        expect(ctx.session).toBeNull();
        const cookieHeaders = ctx._otherInternal.addHeaderFnAccumulator.filter((h: any) => h.key === 'Set-Cookie');
        expect(cookieHeaders.length).toBe(2);
    });

    it('fetchSessionIfExists rethrows dataRefresh failures instead of reporting no session', async () => {
        const { controller } = makeController(async () => { throw new Error('db down'); });
        ddbMock.on(GetCommand).resolves({ Item: makeSessionItem({ dataExpiresAt: nowSec() - 10 }) });

        await expect(controller.fetchSessionIfExists()).rejects.toBeInstanceOf(LambderSessionDataRefreshError);
    });

    it('deleteSessionAllByKey works without a fetched session', async () => {
        const { controller } = makeController(async (s) => s.data);
        ddbMock.on(QueryCommand).resolves({ Items: [{ pk: 'x', sk: 'a' }] });
        ddbMock.on(DeleteCommand).resolves({});

        await controller.deleteSessionAllByKey('user-123');

        expect(ddbMock.commandCalls(DeleteCommand).length).toBe(1);
    });
});
