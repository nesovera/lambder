import type { LambderOneShotSecretShape, LambderOneShotSecretStore } from "../shared/contracts/LambderOneShotSecretStore.js";
import { type LambderConformanceRunner, type LambderConformanceSetup } from "./LambderConformanceRunner.js";
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
export declare const lambderOneShotSecretStoreConformance: (options: LambderOneShotSecretStoreConformanceOptions) => void;
