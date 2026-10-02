import { refuse as deny } from "../../../src/index.js";
import { init } from "./server.js";

// Lambder's refuse functions under names of the app's own: what a call raises
// is read off the function it resolves to, whatever it is written as.

/** The init's refuse held in a constant of another name. */
const raise = init.refuse;
export const requireShippable = (): never => raise("Not shippable.", { code: "wallet-short" });

/** The free refuse imported under another name, with no code. */
export const denyPlainly = (): never => deny("Not now.");
