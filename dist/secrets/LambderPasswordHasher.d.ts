/** The cost of a hash this instance writes. Every field is optional; the defaults are argon2id's widely used 64 MiB, 3 passes, 4 lanes. */
export type LambderPasswordHasherOptions = {
    /** Memory per hash, in KiB. At least 8 per lane. Default: 65536 (64 MiB). */
    memoryKib?: number;
    /** Passes over that memory. Default: 3. */
    passes?: number;
    /** Lanes computed in parallel. Default: 4. */
    parallelism?: number;
};
/**
 * Hashes passwords with argon2id and verifies them against stored PHC
 * strings, its own and those other argon2 libraries wrote (argon2id, argon2i
 * or argon2d, any parameter order).
 *
 * ```ts
 * const passwords = new LambderPasswordHasher();
 * const stored = await passwords.hash(newPassword);           // store this
 * if(await passwords.verify(row?.passwordHash, attempt)){     // a missing row too, so it takes as long
 *     if(passwords.needsRehash(row!.passwordHash)) await savePasswordHash(await passwords.hash(attempt));
 * }
 * ```
 *
 * The password is hashed as its UTF-8 bytes, as given: an app that wants one
 * password typed on two keyboards to match normalizes it (`normalize("NFC")`)
 * before both calls, the same way every time.
 */
export declare class LambderPasswordHasher {
    #private;
    /**
     * Throws where the runtime has no argon2 (Node before 24.7, or a browser),
     * here rather than on the first sign-in: a hasher that cannot hash would
     * otherwise read as a wrong password for every account.
     */
    constructor(options?: LambderPasswordHasherOptions);
    /** The PHC string of `password` under this instance's cost and a fresh random salt: the value to store. */
    hash(password: string): Promise<string>;
    /**
     * Whether `password` is the one `stored` was made from, under the variant
     * and cost `stored` names. False, never a throw, for anything that is not
     * an argon2 PHC string within the cost ceilings: an account with no
     * password stores null, and a value of another scheme or a corrupt one
     * matches no password. Without a usable hash it still computes one under
     * this instance's cost, so an account that does not exist (pass
     * `undefined`) answers in the time a wrong password does, and the time
     * says nothing about which accounts exist.
     */
    verify(stored: string | null | undefined, password: string): Promise<boolean>;
    /**
     * Whether `stored` was written under something other than what this
     * instance writes: another variant, another cost, a shorter salt or tag,
     * or no argon2 hash at all. Asked after a successful verify, when the
     * plaintext is at hand to hash again; that is how a raised cost reaches
     * the passwords stored before it.
     */
    needsRehash(stored: string): boolean;
}
