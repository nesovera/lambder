import type {
    LambderOneShotSecretDraft,
    LambderOneShotSecretRecord,
    LambderOneShotSecretShape,
    LambderOneShotSecretStore,
} from "../shared/contracts/LambderOneShotSecretStore.js";
import {
    CONFORMANCE_START_MILLIS as START,
    conformanceClock,
    type LambderConformanceRunner,
    type LambderConformanceSetup,
} from "./LambderConformanceRunner.js";

/*
 * The rules a LambderOneShotSecretStore promises LambderOneShotSecrets: one
 * live record per scope, retired in the act of issuing its successor, a
 * cooldown that is a condition on the issuing write, a token's digest claimed
 * by one scope at a time, a try counted in the write that reads it, and a
 * consume that exactly one of two racing redemptions wins. Every race a
 * one-shot secret meets is settled by the store, so this is where each one is
 * asserted.
 *
 * The cases run once per shape the store holds. A code is found through its
 * scope and tried against it; a token is found by its digest and never
 * tried. So the cases about counting tries run for codes, and the ones about
 * finding and claiming a digest run for tokens.
 *
 * A store an app writes over its own rows usually holds secrets in columns
 * it already has, which constrains what a case may write: a scope has to be
 * a row that exists, the kind and the meta have to fit its columns, and a
 * store that keeps the issue time but not the expiry (or the other way
 * round) derives one from the other with a fixed lifetime. The options
 * carry each of those, and the cases never name an id the store did not
 * hand out itself.
 */

export type LambderOneShotSecretStoreConformanceOptions = LambderConformanceRunner & {
    /**
     * A store holding nothing under either scope, built for one case over
     * the case's clock. A store over a database empties what the previous
     * case wrote here, since cases reuse the same digests.
     */
    create: (setup: LambderConformanceSetup) => LambderOneShotSecretStore | Promise<LambderOneShotSecretStore>;
    /** Two scopes the store can hold a secret under; the second is the one a case keeps apart from the first. Default: two addresses under one purpose. */
    scopes?: readonly [string, string];
    /**
     * The kind the cases write for each shape the store holds, which the
     * store has to hand back as written. A store that holds only codes, or
     * only tokens, names that shape alone, and the cases for the other are
     * left out. Default: `{ code: "emailCode", token: "activationLink" }`.
     */
    kinds?: Partial<Record<LambderOneShotSecretShape, string>>;
    /** The meta written with a record of each scope, which the store has to hand back as written. `[{}, {}]` for a store that keeps none. Default: one small map per scope. */
    meta?: readonly [Record<string, string>, Record<string, string>];
    /** Seconds from a record's issue to its expiry, the same for every record a case writes, as a store that derives one from the other needs. Default: 600. */
    lifetimeSeconds?: number;
};

/**
 * Registers the one-shot secret store rules as cases of the runner, one `it`
 * each and once per shape, against the store `create` builds:
 *
 * ```ts
 * import { describe, it, expect } from "vitest";
 * import { lambderOneShotSecretStoreConformance } from "lambder/testing";
 *
 * describe("TicketCodeStore", () => {
 *     lambderOneShotSecretStoreConformance({
 *         it, expect,
 *         create: async () => { await emptyTicketCodes(); return new TicketCodeStore(pool); },
 *         scopes: [ticketA.id, ticketB.id],
 *         kinds: { code: "ticketCode" },
 *         meta: [{}, {}],
 *     });
 * });
 * ```
 */
export const lambderOneShotSecretStoreConformance = (options: LambderOneShotSecretStoreConformanceOptions): void => {
    const [scopeA, scopeB] = options.scopes ?? ["register:ada@example.com", "register:grace@example.com"];
    const kinds = options.kinds ?? { code: "emailCode", token: "activationLink" };
    const shapes = (["code", "token"] as const).filter((shape) => kinds[shape] !== undefined);
    if(shapes.length === 0) throw new Error("lambderOneShotSecretStoreConformance: kinds names no shape; give the kind the store holds as a code, as a token, or both.");
    const { expect } = options;
    const [metaA, metaB] = options.meta ?? [{ holder: "ada" }, { holder: "grace" }];
    const lifetimeSeconds = options.lifetimeSeconds ?? 600;
    const startSeconds = Math.floor(START / 1000);

    const begin = async () => {
        const clock = conformanceClock();
        return { clock, store: await options.create(clock) };
    };

    // Every case once per shape the store holds, named for it.
    for(const shape of shapes){
        const kind = kinds[shape]!;
        const isToken = shape === "token";
        const it = (name: string, run: () => Promise<void>) => options.it(`${shape}: ${name}`, run);

        /** A record of scope A issued at the start, unless a case says otherwise; the expiry always follows from the issue time. */
        const draft = (over: { scope?: string; digest?: string; issuedAt?: number; meta?: Record<string, string> } = {}): LambderOneShotSecretDraft => {
            const issuedAt = over.issuedAt ?? startSeconds;
            return {
                kind,
                scope: over.scope ?? scopeA,
                shape,
                digest: over.digest ?? "digest-1",
                issuedAt,
                expiresAt: issuedAt + lifetimeSeconds,
                meta: over.meta ?? (over.scope === scopeB ? metaB : metaA),
            };
        };

        /** The record a store holds for a draft: the draft less its shape, with the id it handed out and no tries. */
        const recordFor = (written: LambderOneShotSecretDraft, id: string): LambderOneShotSecretRecord => {
            const { shape: _shape, ...record } = written;
            return { ...record, id, attempts: 0 };
        };

        /** An issue that went through, or a failure: every rule below is about a record that exists. */
        const issued = async (store: LambderOneShotSecretStore, over: Parameters<typeof draft>[0] = {}): Promise<string> => {
            const outcome = await store.issue(draft(over), {});
            if(!outcome.issued) throw new Error(`expected the secret to be issued, refused as ${outcome.refused}`);
            return outcome.id;
        };

        it("holds one record per scope, found by its scope (and a token by its digest), with what was written and no tries", async () => {
            const { store } = await begin();
            const id = await issued(store);

            const byScope = await store.findByScope(scopeA);
            expect(byScope).toEqual(recordFor(draft(), id));
            expect(await store.findByScope(scopeB)).toBeNull();
            if(isToken){
                expect(await store.findByDigest("digest-1")).toEqual(byScope);
                expect(await store.findByDigest("digest-9")).toBeNull();
            }
        });

        it("retires the scope's older record in the act of issuing, so it can be neither found nor spent", async () => {
            const { store } = await begin();
            const first = await issued(store, { digest: "digest-1" });
            const second = await issued(store, { digest: "digest-2", issuedAt: startSeconds + 30 });

            expect(second).not.toBe(first);
            expect((await store.findByScope(scopeA))?.digest).toBe("digest-2");
            if(isToken){
                expect(await store.findByDigest("digest-1")).toBeNull();
                expect((await store.findByDigest("digest-2"))?.id).toBe(second);
            }else{
                expect(await store.attempt(scopeA, first)).toBeNull();
            }
            expect(await store.consume(scopeA, first)).toBe(false);
        });

        it("leaves exactly one live record when two issues for one scope race", async () => {
            // Retire-then-write done as two statements lets both writers retire
            // nothing and both write, and the scope then holds two live secrets.
            // A second of apart, so a store whose id is the issue time tells the
            // two apart.
            const { store } = await begin();
            const [idA, idB] = await Promise.all([
                issued(store, { digest: "digest-a" }),
                issued(store, { digest: "digest-b", issuedAt: startSeconds + 1 }),
            ]);

            const current = await store.findByScope(scopeA);
            if(isToken){
                const live = [await store.findByDigest("digest-a"), await store.findByDigest("digest-b")].filter((record) => record !== null);
                expect(live).toHaveLength(1);
                expect(current?.digest).toBe(live[0]!.digest);
            }
            // Only the scope's current record can be spent.
            expect([await store.consume(scopeA, idA), await store.consume(scopeA, idB)].filter(Boolean)).toHaveLength(1);
            expect(current).not.toBeNull();
        });

        it("refuses an issue inside the cooldown, naming when the current record was issued, and writes nothing", async () => {
            const { store } = await begin();
            await issued(store, { digest: "digest-1", issuedAt: startSeconds });

            const refused = await store.issue(draft({ digest: "digest-2", issuedAt: startSeconds + 10 }), { unlessIssuedAfter: startSeconds - 1 });
            expect(refused).toEqual({ issued: false, refused: "cooldown", issuedAt: startSeconds });
            expect((await store.findByScope(scopeA))?.digest).toBe("digest-1");
            if(isToken) expect(await store.findByDigest("digest-2")).toBeNull();

            // At the threshold itself the cooldown is over, and a scope with no record has none.
            expect((await store.issue(draft({ digest: "digest-3", issuedAt: startSeconds + 30 }), { unlessIssuedAfter: startSeconds })).issued).toBe(true);
            expect((await store.issue(draft({ scope: scopeB, digest: "digest-4" }), { unlessIssuedAfter: startSeconds + 1000 })).issued).toBe(true);
        });

        it("grants exactly one of two issues racing past a cooldown", async () => {
            const { store } = await begin();
            await issued(store, { digest: "digest-0", issuedAt: startSeconds - 100 });
            const [a, b] = await Promise.all([
                store.issue(draft({ digest: "digest-a" }), { unlessIssuedAfter: startSeconds - 30 }),
                store.issue(draft({ digest: "digest-b" }), { unlessIssuedAfter: startSeconds - 30 }),
            ]);
            expect([a.issued, b.issued].filter(Boolean)).toHaveLength(1);
        });

        if(isToken){
            it("refuses a digest another scope's record holds, writes nothing, and leaves it with its holder", async () => {
                // Two scopes that drew the same token would share one digest,
                // and whoever typed it would redeem the other's record.
                const { store } = await begin();
                const holderId = await issued(store, { digest: "digest-x" });

                expect(await store.issue(draft({ scope: scopeB, digest: "digest-x" }), {})).toEqual({ issued: false, refused: "digestTaken" });
                expect(await store.findByScope(scopeB)).toBeNull();
                expect(await store.findByDigest("digest-x")).toEqual(recordFor(draft({ digest: "digest-x" }), holderId));
            });

            it("grants a digest to exactly one of two scopes racing for it", async () => {
                const { store } = await begin();
                const [a, b] = await Promise.all([
                    store.issue(draft({ digest: "digest-x" }), {}),
                    store.issue(draft({ scope: scopeB, digest: "digest-x" }), {}),
                ]);

                expect([a, b].filter((outcome) => outcome.issued)).toHaveLength(1);
                expect([a, b].filter((outcome) => !outcome.issued && outcome.refused === "digestTaken")).toHaveLength(1);
                const winner = a.issued ? scopeA : scopeB;
                expect((await store.findByDigest("digest-x"))?.scope).toBe(winner);
                expect(await store.findByScope(winner === scopeA ? scopeB : scopeA)).toBeNull();
            });
        }else{
            it("counts a try in the act that reads the record, on the record named and no other", async () => {
                const { store } = await begin();
                const id = await issued(store);

                const first = await store.attempt(scopeA, id);
                expect(first).toMatchObject({ id, digest: "digest-1", attempts: 1, meta: metaA });
                expect((await store.attempt(scopeA, id))?.attempts).toBe(2);
                expect((await store.findByScope(scopeA))?.attempts).toBe(2);
                // The record is scope A's: named under another scope, it is not the one there.
                expect(await store.attempt(scopeB, id)).toBeNull();
                expect((await store.findByScope(scopeA))?.attempts).toBe(2);
            });

            it("counts tries sent together every one, so a ceiling cannot be raced past", async () => {
                const { store } = await begin();
                const id = await issued(store);
                const counted = await Promise.all(Array.from({ length: 5 }, () => store.attempt(scopeA, id)));
                expect(counted.map((record) => record?.attempts).sort()).toEqual([1, 2, 3, 4, 5]);
            });
        }

        it("consumes the record named exactly once, after which nothing finds it", async () => {
            const { store } = await begin();
            const id = await issued(store);
            expect(await store.consume(scopeB, id)).toBe(false);
            expect(await store.consume(scopeA, id)).toBe(true);
            expect(await store.consume(scopeA, id)).toBe(false);
            expect(await store.findByScope(scopeA)).toBeNull();
            if(isToken) expect(await store.findByDigest("digest-1")).toBeNull();
            else expect(await store.attempt(scopeA, id)).toBeNull();
        });

        it("accepts exactly one of two consumes racing for one record", async () => {
            const { store } = await begin();
            const id = await issued(store);
            const outcomes = await Promise.all([store.consume(scopeA, id), store.consume(scopeA, id)]);
            expect(outcomes.filter(Boolean)).toHaveLength(1);
        });

        it("retires whatever the scope holds and nothing of another scope, and nothing when it holds nothing", async () => {
            const { store } = await begin();
            await issued(store, { digest: "digest-a" });
            await issued(store, { scope: scopeB, digest: "digest-b" });
            await store.retire(scopeA);
            expect(await store.findByScope(scopeA)).toBeNull();
            if(isToken) expect(await store.findByDigest("digest-a")).toBeNull();
            expect((await store.findByScope(scopeB))?.digest).toBe("digest-b");
            await store.retire(scopeA);
        });

        it("keeps an expired record until its own housekeeping removes it, so the class can say expired rather than none", async () => {
            const { clock, store } = await begin();
            const id = await issued(store);
            clock.set(START + (lifetimeSeconds + 1) * 1000);
            expect((await store.findByScope(scopeA))?.id).toBe(id);
            if(isToken) expect((await store.findByDigest("digest-1"))?.id).toBe(id);
        });

        it("keeps scopes apart, and hands back copies", async () => {
            const { store } = await begin();
            const idA = await issued(store, { digest: "digest-a" });
            const idB = await issued(store, { scope: scopeB, digest: "digest-b" });
            const a = (await store.findByScope(scopeA))!;
            a.meta["planted"] = "changed";
            a.digest = "changed";
            expect(await store.findByScope(scopeA)).toEqual(recordFor(draft({ digest: "digest-a" }), idA));
            expect(await store.findByScope(scopeB)).toEqual(recordFor(draft({ scope: scopeB, digest: "digest-b" }), idB));
            if(isToken) expect((await store.findByDigest("digest-b"))?.scope).toBe(scopeB);
        });
    }
};
