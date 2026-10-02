import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";

/*
 * Passwords at rest: argon2id through node's own crypto (`crypto.argon2`,
 * Node 24.7 and later), written and read as the PHC string every argon2
 * library speaks:
 *
 *   $argon2id$v=19$m=65536,t=3,p=4$<salt>$<tag>
 *
 * standard base64 without padding. node:crypto is a raw KDF with no notion of
 * that string, so the encoding and the parsing either side of it live here.
 * The string carries its own salt and cost, so the cost can be raised later
 * without invalidating a stored hash: a hash verifies under the parameters it
 * names, and needsRehash says when one was written under weaker ones.
 *
 * Server-only, and only on the root entry: the argon2 binding is native, and
 * a browser has no use for a password's stored form.
 */

/** The cost of a hash this instance writes. Every field is optional; the defaults are argon2id's widely used 64 MiB, 3 passes, 4 lanes. */
export type LambderPasswordHasherOptions = {
    /** Memory per hash, in KiB. At least 8 per lane. Default: 65536 (64 MiB). */
    memoryKib?: number;
    /** Passes over that memory. Default: 3. */
    passes?: number;
    /** Lanes computed in parallel. Default: 4. */
    parallelism?: number;
};

type Argon2Variant = "argon2id" | "argon2i" | "argon2d";
type Argon2Cost = { memoryKib: number; passes: number; parallelism: number };
type ParsedPasswordHash = Argon2Cost & { variant: Argon2Variant; salt: Buffer; tag: Buffer };
type NodeCrypto = typeof import("node:crypto");

/** The only argon2 encoding version: 0x13. A string naming another is not an argon2 hash anything writes today. */
const ARGON2_VERSION = 19;
const SALT_BYTES = 16;
const TAG_BYTES = 32;

/**
 * The most a cost may ask: 2 GiB of memory (RFC 9106's largest recommended
 * setting), 4 GiB of memory over all passes (libsodium's strongest preset,
 * 1 GiB over 4), and the PHC format's 255 lanes. A verify runs under the cost
 * the stored string names, before anyone is signed in, so a string naming
 * hours of passes or more memory than the function has (an imported hash, a
 * corrupt row) would stall every sign-in attempt on its account. A string
 * over them matches no password, and a hasher is not built with a cost over
 * them, so it never writes one.
 */
const MAX_MEMORY_KIB = 2 * 1024 * 1024;
const MAX_MEMORY_OVER_PASSES_KIB = 4 * 1024 * 1024;
const MAX_PARALLELISM = 255;

/** The salt of the hash a verify computes when there is no stored hash to check; its result is thrown away. */
const NO_HASH_SALT = Buffer.alloc(SALT_BYTES);

/**
 * The PHC string. The parameter section is read as an unordered set: the PHC
 * format fixes no order, and implementations differ (the `argon2` npm package
 * writes `m,t,p`, others `m,p,t`).
 */
const PHC_PATTERN = /^\$(argon2id|argon2i|argon2d)\$v=(\d+)\$([a-z]+=\d+(?:,[a-z]+=\d+)*)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

const toPhcBase64 = (bytes: Buffer): string => bytes.toString("base64").replace(/=+$/, "");

/** What is wrong with a cost of positive integers, or null for one inside argon2's floor and the ceilings above. */
const costProblemOf = ({ memoryKib, passes, parallelism }: Argon2Cost): string | null =>
    memoryKib < 8 * parallelism ? `memoryKib must be at least 8 per lane (${8 * parallelism} for parallelism ${parallelism}), got ${memoryKib}`
    : parallelism > MAX_PARALLELISM ? `parallelism must be at most ${MAX_PARALLELISM}, got ${parallelism}`
    : memoryKib > MAX_MEMORY_KIB ? `memoryKib must be at most ${MAX_MEMORY_KIB} (2 GiB), got ${memoryKib}`
    : memoryKib * passes > MAX_MEMORY_OVER_PASSES_KIB ? `memoryKib times passes must be at most ${MAX_MEMORY_OVER_PASSES_KIB} (4 GiB over all passes), got ${memoryKib * passes}`
    : null;

const parseCost = (section: string): Argon2Cost | null => {
    const values = new Map<string, number>();
    for(const pair of section.split(",")){
        const [key, value] = pair.split("=");
        if(!key || !value || values.has(key)) return null;
        values.set(key, Number(value));
    }
    const memoryKib = values.get("m"), passes = values.get("t"), parallelism = values.get("p");
    if(memoryKib === undefined || passes === undefined || parallelism === undefined || values.size !== 3) return null;
    if(![memoryKib, passes, parallelism].every((value) => Number.isSafeInteger(value) && value >= 1)) return null;
    const cost = { memoryKib, passes, parallelism };
    return costProblemOf(cost) === null ? cost : null;
};

const parsePasswordHash = (stored: string): ParsedPasswordHash | null => {
    const match = PHC_PATTERN.exec(stored);
    if(!match) return null;
    const [, variant, version, costSection, saltBase64, tagBase64] = match;
    if(Number(version) !== ARGON2_VERSION) return null;
    const cost = parseCost(costSection!);
    if(!cost) return null;
    const salt = Buffer.from(saltBase64!, "base64");
    const tag = Buffer.from(tagBase64!, "base64");
    // argon2's own floors: an 8-byte salt and a 4-byte tag.
    if(salt.length < 8 || tag.length < 4) return null;
    return { variant: variant as Argon2Variant, ...cost, salt, tag };
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
export class LambderPasswordHasher {
    readonly #crypto: NodeCrypto;
    readonly #cost: Argon2Cost;

    /**
     * Throws where the runtime has no argon2 (Node before 24.7, or a browser),
     * here rather than on the first sign-in: a hasher that cannot hash would
     * otherwise read as a wrong password for every account.
     */
    constructor(options: LambderPasswordHasherOptions = {}) {
        const nodeCrypto = typeof process === "object" && typeof process.getBuiltinModule === "function"
            ? process.getBuiltinModule("node:crypto") as NodeCrypto | undefined
            : undefined;
        if(typeof nodeCrypto?.argon2 !== "function"){
            throw new Error("Lambder: LambderPasswordHasher needs argon2 from node:crypto, which Node 24.7 and later provide; this runtime has none.");
        }
        this.#crypto = nodeCrypto;
        const memoryKib = assertPositiveInteger(options.memoryKib ?? 65536, "memoryKib");
        const passes = assertPositiveInteger(options.passes ?? 3, "passes");
        const parallelism = assertPositiveInteger(options.parallelism ?? 4, "parallelism");
        const problem = costProblemOf({ memoryKib, passes, parallelism });
        if(problem) throw new Error(`Lambder: LambderPasswordHasher ${problem}.`);
        this.#cost = { memoryKib, passes, parallelism };
    }

    /** The PHC string of `password` under this instance's cost and a fresh random salt: the value to store. */
    async hash(password: string): Promise<string> {
        if(typeof password !== "string") throw new TypeError("Lambder: LambderPasswordHasher.hash takes the password as a string.");
        const { memoryKib, passes, parallelism } = this.#cost;
        const salt = this.#crypto.randomBytes(SALT_BYTES);
        const tag = await this.#derive("argon2id", password, salt, this.#cost, TAG_BYTES);
        return `$argon2id$v=${ARGON2_VERSION}$m=${memoryKib},t=${passes},p=${parallelism}$${toPhcBase64(salt)}$${toPhcBase64(tag)}`;
    }

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
    async verify(stored: string | null | undefined, password: string): Promise<boolean> {
        if(typeof password !== "string") return false;
        const parsed = typeof stored === "string" ? parsePasswordHash(stored) : null;
        if(!parsed){
            await this.#derive("argon2id", password, NO_HASH_SALT, this.#cost, TAG_BYTES);
            return false;
        }
        const actual = await this.#derive(parsed.variant, password, parsed.salt, parsed, parsed.tag.length);
        return actual.length === parsed.tag.length && this.#crypto.timingSafeEqual(actual, parsed.tag);
    }

    /**
     * Whether `stored` was written under something other than what this
     * instance writes: another variant, another cost, a shorter salt or tag,
     * or no argon2 hash at all. Asked after a successful verify, when the
     * plaintext is at hand to hash again; that is how a raised cost reaches
     * the passwords stored before it.
     */
    needsRehash(stored: string): boolean {
        const parsed = typeof stored === "string" ? parsePasswordHash(stored) : null;
        if(!parsed) return true;
        return parsed.variant !== "argon2id"
            || parsed.memoryKib !== this.#cost.memoryKib
            || parsed.passes !== this.#cost.passes
            || parsed.parallelism !== this.#cost.parallelism
            || parsed.salt.length < SALT_BYTES
            || parsed.tag.length !== TAG_BYTES;
    }

    #derive(variant: Argon2Variant, password: string, salt: Buffer, cost: Argon2Cost, tagBytes: number): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            this.#crypto.argon2(variant, {
                message: Buffer.from(password, "utf8"),
                nonce: salt,
                memory: cost.memoryKib,
                passes: cost.passes,
                parallelism: cost.parallelism,
                tagLength: tagBytes,
            }, (error, derived) => error ? reject(error) : resolve(Buffer.from(derived)));
        });
    }
}
