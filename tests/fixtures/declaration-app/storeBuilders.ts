import { storeApp } from "./storeApp.js";

// The builders destructured, as many apps hand them out: their declarations
// write the app's types out in full, every name in them still has to be one a
// declaration file can reach.
export const { defineApi, defineApiGroup, lazyApiGroup } = storeApp;
