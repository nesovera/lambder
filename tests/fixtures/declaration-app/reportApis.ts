import { z } from "zod";
import { defineApi, defineApiGroup } from "./storeBuilders.js";

/** A group the entry loads lazily, declared with the destructured builders. */
export const reportApis = defineApiGroup("reports", {
    daily: defineApi({
        input: z.object({ day: z.string() }),
        output: z.object({ orders: z.number() }),
        guards: { open: "The daily count is public." },
    }, async () => ({ orders: 3 })),
});
