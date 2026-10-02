import type { LambderOneShotSecretStore } from "../shared/contracts/LambderOneShotSecretStore.js";
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
export type LambderOneShotSecretKind = {
    shape: "code";
    /** The characters a code is drawn from, each once. Default: the ten digits. */
    alphabet?: string;
    length: number;
    ttlSeconds: number;
    /** Wrong tries the code survives; the try that would pass this refuses the code as exhausted, right or wrong. */
    maxAttempts: number;
} | {
    shape: "token";
    /** Random bytes behind the token, which is their base64url. Default: 32. */
    bytes?: number;
    alphabet?: undefined;
    length?: undefined;
    ttlSeconds: number;
} | {
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
export type LambderOneShotIssueResult = {
    issued: true;
    /** The secret, as it leaves this module the one time it does: a code as written, a token as base64url. */
    plaintext: string;
    /** Epoch seconds. */
    expiresAt: number;
} | {
    issued: false;
    refused: "cooldown"; /** Epoch seconds when the cooldown ends. */
    retryAt: number;
};
export type LambderOneShotRedeemResult = 
/** The secret is the one out: spent now, with the scope it proved and what the app stored beside it. */
{
    state: "accepted";
    scope: string;
    meta: Record<string, string>;
    issuedAt: number;
}
/** Not the code that is out; the try was counted. */
 | {
    state: "wrong";
    attemptsLeft: number;
}
/** The code that is out has run out of time; ask for a new one. */
 | {
    state: "expired";
}
/** The code that is out has run out of tries, this one included; ask for a new one. */
 | {
    state: "exhausted";
}
/** Nothing is out for this scope or this value: never issued, spent, replaced, retired, or unknown. */
 | {
    state: "none";
};
/** The names of the kinds a scoped code is redeemed under. */
export type LambderOneShotCodeKindNames<TKinds> = {
    [K in keyof TKinds]: TKinds[K] extends {
        shape: "code";
    } ? K : never;
}[keyof TKinds] & string;
/** The names of the kinds a token is redeemed under, by value. */
export type LambderOneShotTokenKindNames<TKinds> = {
    [K in keyof TKinds]: TKinds[K] extends {
        shape: "token";
    } ? K : never;
}[keyof TKinds] & string;
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
export declare class LambderOneShotSecrets<TKinds extends Record<string, LambderOneShotSecretKind>> {
    private readonly store;
    private readonly secret;
    private readonly kinds;
    private readonly now;
    constructor(options: LambderOneShotSecretsOptions<TKinds>);
    private nowSeconds;
    private kindOf;
    /**
     * The digest a secret rests as. A code's carries its kind and scope, so
     * the same code issued to two scopes never collides and a code cannot be
     * replayed against another; a token's carries its kind, since a token is
     * found by its digest alone, so two scopes can draw the same one, and the
     * store's claim on the digest at issue is what keeps them apart. The
     * fields are joined escaped, so no two distinct field lists produce one
     * string.
     */
    private digestOf;
    /**
     * Mints one secret for the scope, retiring whatever the scope held, and
     * answers the plaintext: the one time it exists outside the caller's
     * hands. With `cooldownSeconds`, a scope whose current secret was issued
     * less than that ago is refused instead, with the second it may ask
     * again; of two callers racing past the cooldown, exactly one is issued.
     * `meta` is what the app wants back at redemption: an identity, an
     * issuing store, as small strings.
     *
     * A secret whose digest another scope holds is drawn again, up to
     * MAX_DRAWS times; past that the kind's alphabet and length leave too few
     * secrets for the ones out at once, and the issue throws.
     */
    issue(kind: keyof TKinds & string, scope: string, options?: {
        cooldownSeconds?: number;
        meta?: Record<string, string>;
    }): Promise<LambderOneShotIssueResult>;
    /**
     * Redeems a code for its scope. The try is counted before the code is
     * looked at, in the write that reads the digest, so tries sent together
     * are all counted; a right code past the ceiling is refused as exhausted.
     * An accepted code is spent in the same call, exactly once.
     */
    redeem(kind: LambderOneShotCodeKindNames<TKinds>, scope: string, candidate: string): Promise<LambderOneShotRedeemResult>;
    /** Redeems a token by its value: found by its digest, spent exactly once. A token of another kind, or none, is "none". */
    redeemToken(kind: LambderOneShotTokenKindNames<TKinds>, candidate: string): Promise<LambderOneShotRedeemResult>;
    /** Ends whatever the scope holds: after the thing it proved is settled another way, or when what was sent never arrived. */
    retire(scope: string): Promise<void>;
    /** Spends the record; a redemption racing this one and winning makes it "none". */
    private accept;
}
