import { initLambderMock } from "../../../src/mock.js";
import type { lambder } from "./server.js";

// A mock whose init declares no refusal vocabulary: its guards' ctx.refuse
// takes any code, so a guard is held only to a refusals option of its own.
const plainMock = initLambderMock<typeof lambder.ApiContract, { userId: string }>();

/** Says nothing of what it may send, so nothing it reaches can be checked. */
export const plainSignedIn = plainMock.guard({ handler: () => {} });

/** Declares that it sends no code, which is something to check against. */
export const plainOpen = plainMock.guard({ refusals: [], handler: () => {} });
