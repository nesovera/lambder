import { afterEach, describe, expect, it, vi } from 'vitest';
import { LambderPasswordHasher } from '../../src/index.js';

/** A cost small enough to keep the suite fast; the defaults are tested once on their own. */
const quick = () => new LambderPasswordHasher({ memoryKib: 64, passes: 1, parallelism: 1 });

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

describe('LambderPasswordHasher', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('writes an argon2id PHC string under the default cost, which verifies the password and nothing else', async () => {
        const passwords = new LambderPasswordHasher();
        const stored = await passwords.hash('correct horse battery staple');

        const match = PHC.exec(stored);
        expect(match, stored).not.toBeNull();
        expect(match!.slice(1, 4)).toEqual(['65536', '3', '4']);
        expect(Buffer.from(match![4]!, 'base64')).toHaveLength(16);
        expect(Buffer.from(match![5]!, 'base64')).toHaveLength(32);

        expect(await passwords.verify(stored, 'correct horse battery staple')).toBe(true);
        expect(await passwords.verify(stored, 'correct horse battery stapler')).toBe(false);
        expect(passwords.needsRehash(stored)).toBe(false);
    });

    it('salts every hash afresh', async () => {
        const passwords = quick();
        const [first, second] = [await passwords.hash('hunter2'), await passwords.hash('hunter2')];
        expect(first).not.toBe(second);
        expect(await passwords.verify(first, 'hunter2')).toBe(true);
        expect(await passwords.verify(second, 'hunter2')).toBe(true);
    });

    it('verifies the reference implementation\'s published argon2i vector', async () => {
        // phc-winner-argon2's README: echo -n "password" | ./argon2 somesalt -t 2 -m 16 -p 4 -l 24
        const reference = '$argon2i$v=19$m=65536,t=2,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG';
        const passwords = quick();
        expect(await passwords.verify(reference, 'password')).toBe(true);
        expect(await passwords.verify(reference, 'Password')).toBe(false);
        expect(passwords.needsRehash(reference)).toBe(true);
    });

    it('reads the cost parameters in any order', async () => {
        const passwords = quick();
        const stored = await passwords.hash('order of things');
        const reordered = stored.replace('m=64,t=1,p=1', 'p=1,m=64,t=1');
        expect(reordered).not.toBe(stored);
        expect(await passwords.verify(reordered, 'order of things')).toBe(true);
        expect(passwords.needsRehash(reordered)).toBe(false);
    });

    it('verifies under the cost a stored hash names, and says when that cost is not its own', async () => {
        const older = new LambderPasswordHasher({ memoryKib: 32, passes: 1, parallelism: 1 });
        const stored = await older.hash('ticket-4417');
        const current = quick();
        expect(await current.verify(stored, 'ticket-4417')).toBe(true);
        expect(current.needsRehash(stored)).toBe(true);
        expect(older.needsRehash(stored)).toBe(false);
    });

    it('answers false, never throws, for a stored value that is not an argon2 hash', async () => {
        const passwords = quick();
        const valid = await passwords.hash('pw');
        const [, , , cost, salt, tag] = valid.split('$');
        const unusable: (string | null | undefined)[] = [
            null,
            undefined,
            '',
            'pw',
            '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
            `$argon2id$v=16$${cost}$${salt}$${tag}`,
            `$argon2id$v=19$m=64,t=1$${salt}$${tag}`,
            `$argon2id$v=19$m=64,t=1,p=1,x=2$${salt}$${tag}`,
            `$argon2id$v=19$m=64,m=64,t=1,p=1$${salt}$${tag}`,
            `$argon2id$v=19$m=7,t=1,p=1$${salt}$${tag}`,
            `$argon2id$v=19$m=64,t=0,p=1$${salt}$${tag}`,
            `$argon2id$v=19$${cost}$${salt}$${tag}==`,
            `$argon2id$v=19$${cost}$c2FsdA$${tag}`,
            `$argon2id$v=19$${cost}$${salt}$`,
            `$argon2x$v=19$${cost}$${salt}$${tag}`,
            // Past the ceilings, which would stall a sign-in rather than answer it.
            `$argon2id$v=19$m=8,t=4294967295,p=1$${salt}$${tag}`,
            `$argon2id$v=19$m=4194304,t=1,p=1$${salt}$${tag}`,
            `$argon2id$v=19$m=1048576,t=5,p=1$${salt}$${tag}`,
            `$argon2id$v=19$m=4096,t=1,p=256$${salt}$${tag}`,
            `$argon2id$v=19$m=134217728,t=1,p=16777216$${salt}$${tag}`,
        ];
        for(const stored of unusable){
            expect(await passwords.verify(stored, 'pw'), String(stored)).toBe(false);
            if(typeof stored === 'string') expect(passwords.needsRehash(stored), stored).toBe(true);
        }
        expect(await passwords.verify(valid, 42 as unknown as string)).toBe(false);
    });

    it('hashes the password as its UTF-8 bytes, as given', async () => {
        const passwords = quick();
        const composed = 'café';
        const decomposed = 'café';
        const stored = await passwords.hash(composed);
        expect(await passwords.verify(stored, composed)).toBe(true);
        expect(await passwords.verify(stored, decomposed)).toBe(false);
        expect(await passwords.verify(stored, decomposed.normalize('NFC'))).toBe(true);
    });

    it('refuses a cost it could not write, at construction', () => {
        expect(() => new LambderPasswordHasher({ memoryKib: 0 })).toThrow(/memoryKib must be a positive integer/);
        expect(() => new LambderPasswordHasher({ passes: 1.5 })).toThrow(/passes must be a positive integer/);
        expect(() => new LambderPasswordHasher({ parallelism: -1 })).toThrow(/parallelism must be a positive integer/);
        expect(() => new LambderPasswordHasher({ memoryKib: 31, parallelism: 4 })).toThrow(/at least 8 per lane \(32 for parallelism 4\), got 31/);
        // Nor one past the ceilings it would refuse to verify.
        expect(() => new LambderPasswordHasher({ memoryKib: 4194304 })).toThrow(/memoryKib must be at most 2097152 \(2 GiB\), got 4194304/);
        expect(() => new LambderPasswordHasher({ memoryKib: 1048576, passes: 5 })).toThrow(/memoryKib times passes must be at most 4194304/);
        expect(() => new LambderPasswordHasher({ parallelism: 256, memoryKib: 4096 })).toThrow(/parallelism must be at most 255, got 256/);
    });

    it('computes a hash under its own cost when there is none to check, so a missing account answers in a wrong password\'s time', async () => {
        // The hasher takes node:crypto through getBuiltinModule, so the
        // count is taken there, over the real argon2.
        const realCrypto = process.getBuiltinModule('node:crypto');
        const derive = vi.fn(realCrypto.argon2);
        vi.spyOn(process, 'getBuiltinModule').mockReturnValue(Object.assign(Object.create(realCrypto), { argon2: derive }) as never);
        const passwords = quick();
        for(const stored of [undefined, null, 'not a hash', '$argon2id$v=19$m=8,t=4294967295,p=1$c29tZXNhbHQ$c29tZXRhZw']){
            derive.mockClear();
            expect(await passwords.verify(stored, 'pw')).toBe(false);
            expect(derive).toHaveBeenCalledTimes(1);
            expect(derive.mock.calls[0]![1]).toMatchObject({ memory: 64, passes: 1, parallelism: 1, tagLength: 32 });
        }
    });

    it('refuses to hash anything but a string', async () => {
        await expect(quick().hash(undefined as unknown as string)).rejects.toThrow(TypeError);
    });

    it('fails at construction on a runtime without argon2, not on the first sign-in', () => {
        vi.spyOn(process, 'getBuiltinModule').mockReturnValue({} as never);
        expect(() => new LambderPasswordHasher()).toThrow(/needs argon2 from node:crypto, which Node 24\.7 and later provide/);
    });

    it('is on the root entry only', async () => {
        const client = await import('../../src/client.js');
        expect('LambderPasswordHasher' in client).toBe(false);
    });
});
