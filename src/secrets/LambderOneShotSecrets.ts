import type {
    LambderOneShotSecretDraft,
    LambderOneShotSecretRecord,
    LambderOneShotSecretStore,
} from "../shared/contracts/LambderOneShotSecretStore.js";
import { keyedDigest, randomSecret } from "../shared/util/LambderSignedClaims.js";
import { constantTimeEquals } from "../shared/util/LambderTextDigest.js";
import { assertPositiveInteger } from "../shared/util/LambderOptionChecks.js";
import { joinKeyFields } from "../shared/util/joinKeyFields.js";

/*
 * Secrets that are handed out once and given back once: the code emailed to
 * an address, the link in an activation mail, the code texted to a signer,
 * the code an administrator reads out to pair a device. Every one of them has
 * the same life: minted, sent, stored as a digest, tried against, spent. An
 * app that writes that life once per kind of secret writes the races too, and
 * gets them right one at a time.
 *
 * This class holds the life once, over a store that settles the races
 * (LambderOneShotSecretStore). An app declares its kinds, names the scope a
 * secret proves, and gets the plaintext exactly once, from `issue`.
 */

/**
 * The shapes a kind of secret takes, told apart by how they are redeemed. A
 * code is bound to a scope the app names (an address for a purpose, a
 * recipient, a device), redeemed with that scope, and defended by a ceiling on
 * tries, which is what lets it be short. A token carries its own identity, is
 * redeemed by value alone, and has no ceiling: random bytes, long enough that
 * guessing is not a thing, or, for a code somebody types without knowing what
 * it is for (a pairing code), characters of an alphabet, which is guessable
 * and which the app then holds off another way, such as a rate limit per
 * address.
 */
export type LambderOneShotSecretKind =
    | {
        shape: "code";
        /** The characters a code is drawn from, each once. Default: the ten digits. */
        alphabet?: string;
        length: number;
        ttlSeconds: number;
        /** Wrong tries the code survives; the try that would pass this refuses the code as exhausted, right or wrong. */
        maxAttempts: number;
    }
    | {
        shape: "token";
        /** Random bytes behind the token, which is their base64url. Default: 32. */
        bytes?: number;
        alphabet?: undefined;
        length?: undefined;
        ttlSeconds: number;
    }
    | {
        shape: "token";
        /** The characters the token is drawn from, each once, for a token somebody types. */
        alphabet: string;
        length: number;
        bytes?: undefined;
        ttlSeconds: number;
    };

export type LambderOneShotSecretsOptions<TKinds extends Record<string, LambderOneShotSecretKind>> = {
    store: LambderOneShotSecretStore;
    /** Keys every digest at rest, so a copied store cannot be attacked offline. Server side only. */
    secret: string;
    kinds: TKinds;
    /** The clock, in epoch milliseconds. Default: Date.now. */
    now?: () => number;
};

export type LambderOneShotIssueResult =
    | {
        issued: true;
        /** The secret, as it leaves this module the one time it does: a code as written, a token as base64url. */
        plaintext: string;
        /** Epoch seconds. */
        expiresAt: number;
    }
    | { issued: false; refused: "cooldown"; /** Epoch seconds when the cooldown ends. */ retryAt: number };

export type LambderOneShotRedeemResult =
    /** The secret is the one out: spent now, with the scope it proved and what the app stored beside it. */
    | { state: "accepted"; scope: string; meta: Record<string, string>; issuedAt: number }
    /** Not the code that is out; the try was counted. */
    | { state: "wrong"; attemptsLeft: number }
    /** The code that is out has run out of time; ask for a new one. */
    | { state: "expired" }
    /** The code that is out has run out of tries, this one included; ask for a new one. */
    | { state: "exhausted" }
    /** Nothing is out for this scope or this value: never issued, spent, replaced, retired, or unknown. */
    | { state: "none" };

/** The names of the kinds a scoped code is redeemed under. */
export type LambderOneShotCodeKindNames<TKinds> = { [K in keyof TKinds]: TKinds[K] extends { shape: "code" } ? K : never }[keyof TKinds] & string;
/** The names of the kinds a token is redeemed under, by value. */
export type LambderOneShotTokenKindNames<TKinds> = { [K in keyof TKinds]: TKinds[K] extends { shape: "token" } ? K : never }[keyof TKinds] & string;

const DIGITS = "0123456789";

/**
 * How many secrets an issue draws before giving up on a digest another scope
 * holds. A random token never meets one; a short code drawn from a small
 * space with many out at once can, and five taken in a row means the space is
 * too small for the codes out, which is a configuration to change rather than
 * a draw to repeat.
 */
const MAX_DRAWS = 5;

/**
 * Codes and tokens an app hands out once and takes back once, over a store
 * that settles their races.
 *
 * ```ts
 * const secrets = new LambderOneShotSecrets({
 *     store: new LambderDdbOneShotSecretStore({ tableName: "app-policies" }),
 *     secret: ONE_SHOT_SECRET,
 *     kinds: {
 *         emailCode: { shape: "code", length: 6, ttlSeconds: 600, maxAttempts: 5 },
 *         activationLink: { shape: "token", ttlSeconds: 48 * 3600 },
 *     },
 * });
 *
 * const issued = await secrets.issue("emailCode", `register:${email}`, { cooldownSeconds: 30 });
 * if(issued.issued) await sendEmail(email, issued.plaintext);
 *
 * const redeemed = await secrets.redeem("emailCode", `register:${email}`, typedCode);
 * if(redeemed.state !== "accepted") refuse(...);
 * ```
 *
 * The store holds digests only, keyed under the app's secret with the kind
 * and the scope folded in: a code issued to two scopes never collides, and a
 * code cannot be replayed against another kind or scope. The plaintext leaves
 * once, from `issue`; nothing here logs it or stores it.
 */
export class LambderOneShotSecrets<TKinds extends Record<string, LambderOneShotSecretKind>> {
    private readonly store: LambderOneShotSecretStore;
    private readonly secret: string;
    private readonly kinds: TKinds;
    private readonly now: () => number;

    constructor(options: LambderOneShotSecretsOptions<TKinds>){
        if(typeof options.secret !== "string" || options.secret.length === 0) throw new Error("Lambder: LambderOneShotSecrets needs a secret to key its digests with.");
        const names = Object.keys(options.kinds);
        if(names.length === 0) throw new Error("Lambder: LambderOneShotSecrets was given no kinds; declare the kinds of secret the app hands out.");
        for(const name of names){
            const kind = options.kinds[name]!;
            assertPositiveInteger(kind.ttlSeconds, `kinds.${name}.ttlSeconds`);
            if(kind.shape === "code"){
                assertPositiveInteger(kind.length, `kinds.${name}.length`);
                assertPositiveInteger(kind.maxAttempts, `kinds.${name}.maxAttempts`);
                assertAlphabet(kind.alphabet ?? DIGITS, name);
            }else if(kind.shape === "token"){
                if(kind.alphabet !== undefined || kind.length !== undefined){
                    assertPositiveInteger(kind.length, `kinds.${name}.length`);
                    assertAlphabet(kind.alphabet ?? "", name);
                }else{
                    assertPositiveInteger(kind.bytes ?? 32, `kinds.${name}.bytes`);
                }
            }else{
                throw new Error(`Lambder: kinds.${name}.shape must be "code" or "token", got ${JSON.stringify((kind as { shape: unknown }).shape)}.`);
            }
        }
        this.store = options.store;
        this.secret = options.secret;
        this.kinds = options.kinds;
        this.now = options.now ?? (() => Date.now());
    }

    private nowSeconds(): number { return Math.floor(this.now() / 1000); }

    private kindOf(name: string): LambderOneShotSecretKind {
        const kind = Object.prototype.hasOwnProperty.call(this.kinds, name) ? this.kinds[name] : undefined;
        if(!kind) throw new Error(`Lambder: LambderOneShotSecrets knows no kind "${name}".`);
        return kind;
    }

    /**
     * The digest a secret rests as. A code's carries its kind and scope, so
     * the same code issued to two scopes never collides and a code cannot be
     * replayed against another; a token's carries its kind, since a token is
     * found by its digest alone, so two scopes can draw the same one, and the
     * store's claim on the digest at issue is what keeps them apart. The
     * fields are joined escaped, so no two distinct field lists produce one
     * string.
     */
    private digestOf(kind: string, scope: string | null, plaintext: string): Promise<string> {
        return keyedDigest(this.secret, scope === null ? joinKeyFields("token", kind, plaintext) : joinKeyFields("code", kind, scope, plaintext));
    }

    /**
     * Mints one secret for the scope, retiring whatever the scope held, and
     * answers the plaintext: the one time it exists outside the caller's
     * hands. With `cooldownSeconds`, a scope whose current secret was issued
     * less than that ago is refused instead, with the second it may ask
     * again; of two callers racing past the cooldown, exactly one is issued.
     * `meta` is what the app wants back at redemption: an identity, an
     * issuing organization, as small strings.
     *
     * A secret whose digest another scope holds is drawn again, up to
     * MAX_DRAWS times; past that the kind's alphabet and length leave too few
     * secrets for the ones out at once, and the issue throws.
     */
    async issue(kind: keyof TKinds & string, scope: string, options: { cooldownSeconds?: number; meta?: Record<string, string> } = {}): Promise<LambderOneShotIssueResult> {
        const definition = this.kindOf(kind);
        const cooldown = options.cooldownSeconds === undefined ? undefined : assertPositiveInteger(options.cooldownSeconds, "cooldownSeconds");
        const nowSeconds = this.nowSeconds();
        for(let draw = 0; draw < MAX_DRAWS; draw += 1){
            const plaintext = definition.shape === "code" ? drawCode(definition.alphabet ?? DIGITS, definition.length)
                : definition.alphabet !== undefined ? drawCode(definition.alphabet, definition.length)
                : randomSecret(definition.bytes ?? 32);
            const draft: LambderOneShotSecretDraft = {
                kind,
                scope,
                shape: definition.shape,
                digest: await this.digestOf(kind, definition.shape === "code" ? scope : null, plaintext),
                issuedAt: nowSeconds,
                expiresAt: nowSeconds + definition.ttlSeconds,
                meta: { ...(options.meta ?? {}) },
            };
            const outcome = await this.store.issue(draft, { unlessIssuedAfter: cooldown === undefined ? undefined : nowSeconds - cooldown });
            if(outcome.issued) return { issued: true, plaintext, expiresAt: draft.expiresAt };
            if(outcome.refused === "cooldown") return { issued: false, refused: "cooldown", retryAt: outcome.issuedAt + (cooldown ?? 0) };
        }
        throw new Error(`Lambder: kind "${kind}" drew ${MAX_DRAWS} secrets in a row whose digest another scope holds; its alphabet and length leave too few for the ones out at once.`);
    }

    /**
     * Redeems a code for its scope. The try is counted before the code is
     * looked at, in the write that reads the digest, so tries sent together
     * are all counted; a right code past the ceiling is refused as exhausted.
     * An accepted code is spent in the same call, exactly once.
     */
    async redeem(kind: LambderOneShotCodeKindNames<TKinds>, scope: string, candidate: string): Promise<LambderOneShotRedeemResult> {
        const definition = this.kindOf(kind);
        if(definition.shape !== "code") throw new Error(`Lambder: kind "${kind}" is a token, redeemed by value with redeemToken().`);
        const current = await this.store.findByScope(scope);
        if(!current || current.kind !== kind) return { state: "none" };
        if(current.expiresAt <= this.nowSeconds()) return { state: "expired" };
        if(current.attempts >= definition.maxAttempts) return { state: "exhausted" };
        const counted = await this.store.attempt(scope, current.id);
        if(!counted) return { state: "none" };
        // Counted already, so this is the count with the try being made now.
        if(counted.attempts > definition.maxAttempts) return { state: "exhausted" };
        if(!constantTimeEquals(counted.digest, await this.digestOf(kind, scope, candidate))){
            return { state: "wrong", attemptsLeft: Math.max(0, definition.maxAttempts - counted.attempts) };
        }
        return await this.accept(counted);
    }

    /** Redeems a token by its value: found by its digest, spent exactly once. A token of another kind, or none, is "none". */
    async redeemToken(kind: LambderOneShotTokenKindNames<TKinds>, candidate: string): Promise<LambderOneShotRedeemResult> {
        const definition = this.kindOf(kind);
        if(definition.shape !== "token") throw new Error(`Lambder: kind "${kind}" is a code, redeemed with its scope through redeem().`);
        // A token is 43 characters for 32 bytes; anything far past that is not one, and is not worth a digest.
        if(candidate.length === 0 || candidate.length > 512) return { state: "none" };
        const current = await this.store.findByDigest(await this.digestOf(kind, null, candidate));
        if(!current || current.kind !== kind) return { state: "none" };
        if(current.expiresAt <= this.nowSeconds()) return { state: "expired" };
        return await this.accept(current);
    }

    /** Ends whatever the scope holds: after the thing it proved is settled another way, or when what was sent never arrived. */
    async retire(scope: string): Promise<void> {
        await this.store.retire(scope);
    }

    /** Spends the record; a redemption racing this one and winning makes it "none". */
    private async accept(record: LambderOneShotSecretRecord): Promise<LambderOneShotRedeemResult> {
        if(!(await this.store.consume(record.scope, record.id))) return { state: "none" };
        return { state: "accepted", scope: record.scope, meta: { ...record.meta }, issuedAt: record.issuedAt };
    }
}

const assertAlphabet = (alphabet: string, name: string): void => {
    if(alphabet.length < 2 || alphabet.length > 256 || new Set(alphabet).size !== alphabet.length){
        throw new Error(`Lambder: kinds.${name}.alphabet must be 2 to 256 distinct characters.`);
    }
};

/**
 * A code of `length` characters drawn uniformly from `alphabet`. Bytes at or
 * above the largest multiple of the alphabet's size are discarded, so the
 * modulo cannot favour the alphabet's first characters.
 */
const drawCode = (alphabet: string, length: number): string => {
    const webCrypto = globalThis.crypto;
    if(typeof webCrypto?.getRandomValues !== "function"){
        throw new Error("Lambder needs crypto.getRandomValues in this runtime to draw a code. Every browser provides it; Node 20+ provides it as globalThis.crypto.");
    }
    const ceiling = Math.floor(256 / alphabet.length) * alphabet.length;
    const characters: string[] = [];
    const buffer = new Uint8Array(length * 2);
    while(characters.length < length){
        webCrypto.getRandomValues(buffer);
        for(const byte of buffer){
            if(byte >= ceiling) continue;
            characters.push(alphabet[byte % alphabet.length]!);
            if(characters.length === length) break;
        }
    }
    return characters.join("");
};
