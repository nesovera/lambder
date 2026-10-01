import { z } from "zod";

/** The fixture's refusal codes, which the server's init and the mock's both declare. */
export const orderRefusals = {
    "order-closed": {},
    "order-missing": { data: z.object({ orderId: z.string() }) },
    "not-staff": { notAuthorized: true },
    "wallet-short": {},
} as const;
