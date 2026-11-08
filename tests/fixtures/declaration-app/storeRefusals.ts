import { storeInit } from "./storeInit.js";

/** The one refuse every server file raises with, typed to the whole vocabulary, annotated so a guard clause narrows after it. */
export const refuse: typeof storeInit.refuse = storeInit.refuse;

/** A refusal helper of the app's, raising one declared code. */
export function refuseClosed(): never {
    return refuse("This order is closed.", { code: "order-closed" });
}
