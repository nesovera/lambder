import type { LambderIdempotencyStore } from "../shared/contracts/LambderIdempotencyStore.js";
import {
    CONFORMANCE_START_MILLIS as START,
    conformanceClock,
    type LambderConformanceRunner,
    type LambderConformanceSetup,
} from "./LambderConformanceRunner.js";

/*
 * The rules a LambderIdempotencyStore promises the idempotency engine: a
 * claim granted once, settled by its owner alone, replayed as a copy, and
 * released only while pending. The engine relies on each of them, and the
 * compiler checks a method's signature, not its semantics, so every rule is
 * asserted here and driven through each implementation.
 */

export type LambderIdempotencyStoreConformanceOptions = LambderConformanceRunner & {
    /** A store holding nothing, built for one case over the case's clock. */
    create: (setup: LambderConformanceSetup) => LambderIdempotencyStore | Promise<LambderIdempotencyStore>;
    /**
     * A body this store will not hold. The budget is the store's own business
     * (a DynamoDB store measures what it writes after compression, a memory
     * store the bytes), so each says what "too big" means for it.
     */
    oversizedBody: string;
    /** The other side of the same budget: the largest body this store does hold, so the boundary is pinned from both directions. */
    largestStorableBody: string;
};

/**
 * Registers the idempotency store rules as cases of the runner, one `it`
 * each, against the store `create` builds:
 *
 * ```ts
 * import { describe, it, expect } from "vitest";
 * import { lambderIdempotencyStoreConformance } from "lambder/testing";
 *
 * describe("OrderIdempotencyStore", () => {
 *     lambderIdempotencyStoreConformance({
 *         it, expect,
 *         create: ({ now }) => new OrderIdempotencyStore({ pool, now }),
 *         oversizedBody: "x".repeat(2_000_000),
 *         largestStorableBody: "x".repeat(1_000_000),
 *     });
 * });
 * ```
 */
export const lambderIdempotencyStoreConformance = (options: LambderIdempotencyStoreConformanceOptions): void => {
    const { it, expect, oversizedBody, largestStorableBody } = options;
    const answer = { statusCode: 201, headers: { "Content-Type": ["application/json"] }, body: '{"ok":true}', fingerprint: "request-1", ttlSeconds: 60 };

    /** A fresh store and the clock it reads. */
    const begin = async () => {
        const clock = conformanceClock();
        return { clock, store: await options.create(clock) };
    };

    /**
     * A granted claim's owner token, or a failure. Every rule below is about
     * what happens AFTER a claim is granted, so a rule that returned early on
     * a claim that was not new would pass on a store that grants nothing.
     */
    const claimNew = async (store: LambderIdempotencyStore, scopeKey: string, pendingTtlSeconds = 60): Promise<string> => {
        const claim = await store.begin(scopeKey, { pendingTtlSeconds, fingerprint: "request-1" });
        if(claim.state !== "new") throw new Error(`expected a new claim on "${scopeKey}", got "${claim.state}"`);
        return claim.ownerToken;
    };

    it("keeps the request fingerprint through the claim and the settled record, so the engine can tell a retry from another request", async () => {
        const { store } = await begin();
        const owner = await claimNew(store, "scope-f");
        expect(await store.begin("scope-f", { pendingTtlSeconds: 60, fingerprint: "request-2" })).toEqual({ state: "pending", fingerprint: "request-1" });

        expect(await store.complete("scope-f", owner, { ...answer, fingerprint: "request-1" })).toBe("stored");
        expect(await store.peek("scope-f")).toMatchObject({ statusCode: 201, fingerprint: "request-1" });
        expect(await store.begin("scope-f", { pendingTtlSeconds: 60, fingerprint: "request-2" })).toMatchObject({ state: "done", fingerprint: "request-1" });
    });

    it("claims a free scope, refuses a concurrent claim, and hides the record until it is settled", async () => {
        const { store } = await begin();

        const ownerToken = await claimNew(store, "s");
        expect(ownerToken).toBeTruthy();

        expect((await store.begin("s", { pendingTtlSeconds: 60, fingerprint: "request-1" })).state).toBe("pending");
        expect(await store.peek("s")).toBeNull();
    });

    it("settles by the owner, then replays the answer through both peek and begin", async () => {
        const { store } = await begin();
        const ownerToken = await claimNew(store, "s");

        expect(await store.complete("s", ownerToken, answer)).toBe("stored");

        const peeked = await store.peek("s");
        expect(peeked).toEqual({ statusCode: 201, headers: { "Content-Type": ["application/json"] }, body: '{"ok":true}', fingerprint: "request-1" });
        const begun = await store.begin("s", { pendingTtlSeconds: 60, fingerprint: "request-1" });
        expect(begun).toMatchObject({ state: "done", statusCode: 201, body: '{"ok":true}' });
    });

    it("hands back a copy, so a caller writing onto what it read cannot rewrite the record", async () => {
        // The pipeline applies the replaying call's own headers onto the answer
        // it got back. A store that returns its own map lets one call's
        // Set-Cookie become part of the record and reach every later replay.
        const { store } = await begin();
        const ownerToken = await claimNew(store, "s");
        await store.complete("s", ownerToken, answer);

        const peeked = await store.peek("s");
        peeked!.headers["Set-Cookie"] = ["sid=; Max-Age=0"];
        const begun = await store.begin("s", { pendingTtlSeconds: 60, fingerprint: "request-1" });
        if(begun.state === "done") begun.headers["Set-Cookie"] = ["sid=; Max-Age=0"];

        expect((await store.peek("s"))?.headers["Set-Cookie"]).toBeUndefined();
    });

    it("reports a settle from a non-owner as lost, and writes nothing", async () => {
        const { store } = await begin();
        await claimNew(store, "s");

        expect(await store.complete("s", "not-the-owner", answer)).toBe("lost");
        expect(await store.peek("s")).toBeNull();
    });

    it("reports a body it cannot hold as too-large, and writes nothing", async () => {
        const { store } = await begin();
        const ownerToken = await claimNew(store, "s");

        expect(await store.complete("s", ownerToken, { ...answer, body: oversizedBody })).toBe("too-large");
        expect(await store.peek("s")).toBeNull();
        // The claim survives, so the caller can release it and let retries run.
        await store.abandon("s", ownerToken);
        expect((await store.begin("s", { pendingTtlSeconds: 60, fingerprint: "request-1" })).state).toBe("new");
    });

    it("decides size before ownership, the only order a single conditional write allows", async () => {
        const { store } = await begin();
        await claimNew(store, "s");

        // A store settles in one write, so the only thing it can judge before
        // reaching the table is whether the body fits. Both answers are safe
        // for the caller; what matters is that every store gives the same one.
        expect(await store.complete("s", "not-the-owner", { ...answer, body: oversizedBody })).toBe("too-large");
    });

    it("releases a claim only for its owner", async () => {
        const { store } = await begin();
        const ownerToken = await claimNew(store, "s");

        await store.abandon("s", "not-the-owner");
        expect((await store.begin("s", { pendingTtlSeconds: 60, fingerprint: "request-1" })).state).toBe("pending");

        await store.abandon("s", ownerToken);
        expect((await store.begin("s", { pendingTtlSeconds: 60, fingerprint: "request-1" })).state).toBe("new");
    });

    it("lets a pending claim expire, so a crashed original does not block retries forever", async () => {
        const { clock, store } = await begin();
        await claimNew(store, "s", 30);

        clock.set(START + 31_000);

        expect((await store.begin("s", { pendingTtlSeconds: 30, fingerprint: "request-1" })).state).toBe("new");
    });

    it("reports an owner settling after its own claim expired as lost", async () => {
        // A claim that ran out is a claim the owner does not hold, whatever
        // the storage does about it. DynamoDB's TTL deletion is lazy, so a
        // store that checked only the owner token would usually still find
        // the item and say "stored", and the answer would depend on whether
        // AWS had swept yet.
        const { clock, store } = await begin();
        const ownerToken = await claimNew(store, "s", 30);

        clock.set(START + 31_000);

        expect(await store.complete("s", ownerToken, answer)).toBe("lost");
        expect(await store.peek("s")).toBeNull();
    });

    it("stops replaying a settled record once its ttl runs out", async () => {
        const { clock, store } = await begin();
        const ownerToken = await claimNew(store, "s");
        await store.complete("s", ownerToken, { ...answer, ttlSeconds: 60 });

        clock.set(START + 61_000);

        expect(await store.peek("s")).toBeNull();
        expect((await store.begin("s", { pendingTtlSeconds: 60, fingerprint: "request-1" })).state).toBe("new");
    });

    it("replays an empty body", async () => {
        // A 204, or a 200 with an empty body, is an answer like any other, and
        // the replay has to be the same answer. A compressed empty body must
        // not declare a length the codec refuses on the way back: peek and
        // begin would throw for the record's whole TTL, the engine would fail
        // open on each, and every retry would execute again.
        const { store } = await begin();
        const ownerToken = await claimNew(store, "s");

        expect(await store.complete("s", ownerToken, { ...answer, statusCode: 204, body: "" })).toBe("stored");

        expect(await store.peek("s")).toEqual({ statusCode: 204, headers: { "Content-Type": ["application/json"] }, body: "", fingerprint: "request-1" });
        expect(await store.begin("s", { pendingTtlSeconds: 60, fingerprint: "request-1" })).toMatchObject({ state: "done", statusCode: 204, body: "" });
    });

    it("keeps scopes apart", async () => {
        const { store } = await begin();
        const ownerToken = await claimNew(store, "a");
        await store.complete("a", ownerToken, answer);

        expect(await store.peek("b")).toBeNull();
        expect((await store.begin("b", { pendingTtlSeconds: 60, fingerprint: "request-1" })).state).toBe("new");
    });

    it("takes a copy of what it is given, so a caller writing onto the record afterwards cannot rewrite it", async () => {
        // The other half of the copy rule. The pipeline hands complete() the
        // answer object and goes on writing the call's own headers into it
        // afterwards, so a store that kept the caller's map would take one
        // request's Set-Cookie into the stored record and replay it to
        // everybody else.
        const { store } = await begin();
        const ownerToken = await claimNew(store, "s");
        const record: { statusCode: number; headers: Record<string, string[]>; body: string; fingerprint: string; ttlSeconds: number } =
            { statusCode: 201, headers: { "Content-Type": ["application/json"] }, body: '{"ok":true}', fingerprint: "request-1", ttlSeconds: 60 };

        expect(await store.complete("s", ownerToken, record)).toBe("stored");
        record.headers["Set-Cookie"] = ["sid=planted"];
        record.headers["Content-Type"] = ["text/plain"];
        record.statusCode = 500;

        expect(await store.peek("s")).toEqual({
            statusCode: 201,
            headers: { "Content-Type": ["application/json"] },
            body: '{"ok":true}',
            fingerprint: "request-1",
        });
    });

    it("holds a body that is exactly at its budget, the other side of the too-large boundary", async () => {
        const { store } = await begin();
        const ownerToken = await claimNew(store, "s");

        expect(await store.complete("s", ownerToken, { ...answer, body: largestStorableBody })).toBe("stored");
        expect((await store.peek("s"))?.body).toBe(largestStorableBody);
    });

    it("counts the expiry second itself as expired, on the claim and on the record", async () => {
        // Whether expiry is `<=` or `<` decides what happens in the second a
        // claim runs out, and implementations settle it in different places:
        // one compares in the process, another in a database condition. On
        // the boundary second the claim is gone and the record no longer
        // replays.
        const { clock, store } = await begin();
        await claimNew(store, "s", 30);
        clock.set(START + 30_000);
        expect((await store.begin("s", { pendingTtlSeconds: 30, fingerprint: "request-1" })).state).toBe("new");

        clock.set(START);
        const second = await options.create(clock);
        const secondToken = await claimNew(second, "s");
        await second.complete("s", secondToken, { ...answer, ttlSeconds: 60 });
        clock.set(START + 60_000);
        expect(await second.peek("s")).toBeNull();
    });

    it("lets the owner settle the same scope twice, so a retried complete is not a lost claim", async () => {
        const { store } = await begin();
        const ownerToken = await claimNew(store, "s");

        expect(await store.complete("s", ownerToken, answer)).toBe("stored");
        expect(await store.complete("s", ownerToken, { ...answer, body: '{"ok":2}' })).toBe("stored");
        expect((await store.peek("s"))?.body).toBe('{"ok":2}');
    });

    it("keeps the settled record when its own owner abandons after completing", async () => {
        // The engine abandons after a complete() that threw, and one whose
        // response was lost may have landed. A settled record still carries
        // the owner token, so an abandon conditional on the token alone would
        // delete the stored answer, hand the client's retry a free scope, and
        // run the operation twice. Only a pending claim is released.
        const { store } = await begin();
        const ownerToken = await claimNew(store, "s");
        await store.complete("s", ownerToken, answer);

        await store.abandon("s", ownerToken);

        expect(await store.peek("s")).toMatchObject({ statusCode: 201, body: '{"ok":true}', fingerprint: "request-1" });
        expect((await store.begin("s", { pendingTtlSeconds: 60, fingerprint: "request-1" })).state).toBe("done");
    });

    it("treats a zero pendingTtlSeconds as a claim that is already over, rather than one that never ends", async () => {
        // The engine validates the option, so this is about what a store does
        // when one reaches it anyway: the claim expires in the second it is
        // taken, so the next request claims the scope rather than seeing a
        // pending original, and the first owner has already lost it.
        const { store } = await begin();
        const ownerToken = await claimNew(store, "s", 0);

        expect((await store.begin("s", { pendingTtlSeconds: 0, fingerprint: "request-1" })).state).toBe("new");
        expect(await store.complete("s", ownerToken, answer)).toBe("lost");
    });

    it("grants exactly one claim when two requests claim the same scope at once", async () => {
        // The rule the whole store exists for: begin() has to be atomic, not
        // read-then-write.
        const { store } = await begin();

        const claims = await Promise.all([
            store.begin("s", { pendingTtlSeconds: 60, fingerprint: "request-1" }),
            store.begin("s", { pendingTtlSeconds: 60, fingerprint: "request-1" }),
        ]);

        expect(claims.filter((claim) => claim.state === "new")).toHaveLength(1);
        expect(claims.filter((claim) => claim.state === "pending")).toHaveLength(1);
    });
};
