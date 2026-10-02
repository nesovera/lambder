import type { LambderSessionRecord, LambderSessionStore } from "../shared/contracts/LambderSessionStore.js";
import {
    CONFORMANCE_START_MILLIS as START,
    conformanceClock,
    type LambderConformanceRunner,
    type LambderConformanceSetup,
} from "./LambderConformanceRunner.js";

/*
 * The rules a LambderSessionStore promises the session manager: a record
 * minted once, found under its two hashes, isolated per partition, never
 * brought back once deleted, and a dataVersion that moves on every write of
 * data so a conditioned refresh can tell it lost a race with a revocation.
 * Tests of an app usually run on a memory store while production runs on
 * another, which is only sound while the two agree on each of these.
 */

export type LambderSessionStoreConformanceOptions = LambderConformanceRunner & {
    /** A store holding no sessions, built for one case over the case's clock. */
    create: (setup: LambderConformanceSetup) => LambderSessionStore | Promise<LambderSessionStore>;
    /** What the store's `isMemoryOnly` must say: true only for a store nothing outlives the process of. Default: false. */
    isMemoryOnly?: boolean;
};

/**
 * Registers the session store rules as cases of the runner, one `it` each,
 * against the store `create` builds:
 *
 * ```ts
 * import { describe, it, expect } from "vitest";
 * import { lambderSessionStoreConformance } from "lambder/testing";
 *
 * describe("PostgresSessionStore", () => {
 *     lambderSessionStoreConformance({ it, expect, create: async () => { await emptySessions(); return new PostgresSessionStore(pool); } });
 * });
 * ```
 *
 * The records a case writes are dated from the case's clock, which starts at
 * a fixed moment far in the future and stands still unless a case moves it: a
 * store that expires records by the system clock, rather than by `now`, never
 * sees one expire.
 */
export const lambderSessionStoreConformance = (options: LambderSessionStoreConformanceOptions): void => {
    const { it, expect } = options;
    const isMemoryOnly = options.isMemoryOnly ?? false;
    const startSeconds = Math.floor(START / 1000);

    const begin = async () => await options.create(conformanceClock());

    const sessionRecord = (over: Partial<LambderSessionRecord> = {}): LambderSessionRecord => ({
        sessionKeyHash: "partition-a",
        secretHash: "secret-1",
        csrfTokenHash: "csrf-1",
        sessionKey: "user-1",
        data: { name: "Ada" },
        createdAt: startSeconds,
        expiresAt: startSeconds + 3600,
        lastAccessedAt: startSeconds,
        ttlInSeconds: 3600,
        dataVersion: 0,
        ...over,
    });

    it("says whether it outlives the process, which is what gates non-cryptographic hashing", async () => {
        expect((await begin()).isMemoryOnly).toBe(isMemoryOnly);
    });

    it("round-trips a record under its two hashes", async () => {
        const store = await begin();
        await store.create(sessionRecord());

        const read = await store.get("partition-a", "secret-1");
        expect(read).toMatchObject({ sessionKey: "user-1", csrfTokenHash: "csrf-1", data: { name: "Ada" }, dataVersion: 0 });
    });

    it("answers null for a record that is absent, never throws", async () => {
        const store = await begin();
        expect(await store.get("partition-a", "nope")).toBeNull();
        expect(await store.get("no-such-partition", "secret-1")).toBeNull();
    });

    it("refuses to create a record over an existing one: a session is minted once", async () => {
        const store = await begin();
        await store.create(sessionRecord());
        await expect(store.create(sessionRecord({ data: { name: "Grace" } }))).rejects.toThrow();

        expect(await store.get("partition-a", "secret-1")).toMatchObject({ data: { name: "Ada" } });
        expect(await store.listSecretHashes("partition-a")).toEqual(["secret-1"]);
    });

    it("lists the secret hashes of one partition and nothing from another", async () => {
        const store = await begin();
        await store.create(sessionRecord({ secretHash: "secret-1" }));
        await store.create(sessionRecord({ secretHash: "secret-2" }));
        await store.create(sessionRecord({ sessionKeyHash: "partition-b", secretHash: "secret-3" }));

        expect((await store.listSecretHashes("partition-a")).sort()).toEqual(["secret-1", "secret-2"]);
        expect(await store.listSecretHashes("partition-b")).toEqual(["secret-3"]);
        expect(await store.listSecretHashes("partition-empty")).toEqual([]);
    });

    it("deletes one session without touching its siblings", async () => {
        const store = await begin();
        await store.create(sessionRecord({ secretHash: "secret-1" }));
        await store.create(sessionRecord({ secretHash: "secret-2" }));

        expect(await store.delete("partition-a", "secret-1")).toMatchObject({ secretHash: "secret-1", sessionKey: "user-1" });

        expect(await store.get("partition-a", "secret-1")).toBeNull();
        expect(await store.get("partition-a", "secret-2")).not.toBeNull();
    });

    it("hands back the record as it was stored when deleted, a later write included", async () => {
        const store = await begin();
        await store.create(sessionRecord());
        await store.update("partition-a", "secret-1", { data: { name: "Grace" } });
        expect((await store.delete("partition-a", "secret-1"))?.data).toEqual({ name: "Grace" });
    });

    it("deleting a record that is already gone is a no-op that answers null, not an error", async () => {
        const store = await begin();
        await expect(store.delete("partition-a", "never-existed")).resolves.toBeNull();
    });

    it("updates the named fields of a live record and leaves the rest", async () => {
        const store = await begin();
        await store.create(sessionRecord());
        const at = startSeconds + 30;

        expect(await store.update("partition-a", "secret-1", { dataExpiresAt: at })).toBe("updated");
        expect(await store.update("partition-a", "secret-1", { data: { name: "Grace" }, expiresAt: at + 7200, lastAccessedAt: at })).toBe("updated");

        expect(await store.get("partition-a", "secret-1")).toMatchObject({
            data: { name: "Grace" }, dataExpiresAt: at, expiresAt: at + 7200, lastAccessedAt: at,
            sessionKey: "user-1", csrfTokenHash: "csrf-1", createdAt: startSeconds,
        });
    });

    it("never brings back a record that vanished: an update of one answers missing", async () => {
        // A logout that lands while a renewal is in flight must stay a
        // logout, so an update of a deleted record writes nothing at all.
        const store = await begin();
        await store.create(sessionRecord());
        await store.delete("partition-a", "secret-1");

        expect(await store.update("partition-a", "secret-1", { expiresAt: startSeconds + 7200 })).toBe("missing");
        expect(await store.update("partition-a", "secret-1", { data: { name: "Grace" } }, { dataVersion: 0 })).toBe("missing");
        expect(await store.get("partition-a", "secret-1")).toBeNull();
    });

    it("moves dataVersion by one on each write of data or dataExpiresAt, and on no other write", async () => {
        const store = await begin();
        await store.create(sessionRecord());
        const at = startSeconds + 30;
        const versionNow = async () => (await store.get("partition-a", "secret-1"))?.dataVersion;

        await store.update("partition-a", "secret-1", { lastAccessedAt: at, expiresAt: at + 3600 });
        expect(await versionNow()).toBe(0);
        await store.update("partition-a", "secret-1", { data: { name: "Grace" } });
        expect(await versionNow()).toBe(1);
        await store.update("partition-a", "secret-1", { dataExpiresAt: at });
        expect(await versionNow()).toBe(2);
        // One write carrying both, and the slide beside them, is one step.
        await store.update("partition-a", "secret-1", { data: { name: "Lin" }, dataExpiresAt: at + 600, lastAccessedAt: at });
        expect(await versionNow()).toBe(3);
    });

    it("applies a conditioned update only while dataVersion is the one it was read with, and says stale otherwise", async () => {
        const store = await begin();
        await store.create(sessionRecord());
        const at = startSeconds + 30;

        expect(await store.update("partition-a", "secret-1", { data: { name: "Grace" }, dataExpiresAt: at }, { dataVersion: 1 })).toBe("stale");
        expect(await store.update("partition-a", "secret-1", { data: { name: "Grace" }, dataExpiresAt: at }, { dataVersion: 0 })).toBe("updated");
        // That write moved the version, so the one it named no longer holds.
        expect(await store.update("partition-a", "secret-1", { data: { name: "Lin" } }, { dataVersion: 0 })).toBe("stale");
        expect(await store.update("partition-a", "secret-1", { data: { name: "Lin" } }, { dataVersion: 1 })).toBe("updated");

        expect(await store.get("partition-a", "secret-1")).toMatchObject({ data: { name: "Lin" }, dataExpiresAt: at, dataVersion: 2 });
    });

    it("answers stale after a mark that wrote the deadline already stored, in the second a refresh read it", async () => {
        // The record falls due this second, a read starts its refresh, and a
        // revocation marks it due in that same second. The deadline reads
        // exactly as the refresh read it, so a condition on the deadline
        // would let the refresh land data derived before the revocation for
        // a whole data TTL. Only the version shows the mark.
        const store = await begin();
        await store.create(sessionRecord({ dataExpiresAt: startSeconds }));
        const read = (await store.get("partition-a", "secret-1"))!;

        expect(await store.update("partition-a", "secret-1", { dataExpiresAt: startSeconds })).toBe("updated");

        expect(await store.update("partition-a", "secret-1", { data: { name: "Grace" }, dataExpiresAt: startSeconds + 600 }, { dataVersion: read.dataVersion })).toBe("stale");
        expect(await store.get("partition-a", "secret-1")).toMatchObject({ data: { name: "Ada" }, dataExpiresAt: startSeconds });
    });

    it("answers stale after a second mark in the second of the first, which a refresh of the first did not see", async () => {
        // The first revocation marks the record due, a read starts a refresh
        // that sees only that one, and a second revocation marks it again in
        // the same second. Both marks write the same deadline, so only the
        // version tells the refresh that it is one revocation behind.
        const store = await begin();
        await store.create(sessionRecord({ dataExpiresAt: startSeconds + 600 }));
        await store.update("partition-a", "secret-1", { dataExpiresAt: startSeconds });
        const read = (await store.get("partition-a", "secret-1"))!;

        await store.update("partition-a", "secret-1", { dataExpiresAt: startSeconds });

        expect(await store.update("partition-a", "secret-1", { data: { name: "Grace" }, dataExpiresAt: startSeconds + 600 }, { dataVersion: read.dataVersion })).toBe("stale");
        expect(await store.get("partition-a", "secret-1")).toMatchObject({ data: { name: "Ada" }, dataExpiresAt: startSeconds, dataVersion: 2 });
    });

    it("holds data with an undefined inside it the way JSON does, rather than refusing it", async () => {
        const store = await begin();
        await store.create(sessionRecord({ data: { name: "Ada", nickname: undefined } }));
        await store.update("partition-a", "secret-1", { data: { name: "Grace", nickname: undefined } });

        expect((await store.get("partition-a", "secret-1"))?.data).toEqual({ name: "Grace" });
    });
};
