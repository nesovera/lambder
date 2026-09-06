/**
 * Testing entry point (`import ... from "lambder/testing"`).
 *
 * Mock tooling that neither the server nor the production client bundle
 * should carry: the MSW adapter that serves an app's typed API contract
 * from in-browser mock handlers during development and tests.
 */

export { default as LambderMSW } from "./client/LambderMSW.js";
export type { LambderMswModule } from "./client/LambderMSW.js";
