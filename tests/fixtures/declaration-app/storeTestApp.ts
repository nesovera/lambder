import { lambderTestApp } from "lambder/testing";
import { lambder, type StoreApiContract } from "./storeEntry.js";
import type { StoreSession } from "./storeInit.js";

/** The real server under test, typed by its contract, and a visitor of it. */
export const storeTestApp = lambderTestApp<StoreSession, StoreApiContract>(lambder, { host: "shop.example.com" });
export const storeVisitor = storeTestApp.visitor();
export const signInStaff = () => storeTestApp.signIn("staff-1", { customerId: "c-1", staff: true });
