/*
 * The server's input and output schemas as plain data: what
 * writeApiSchemas (lambder/build) writes, from the zod schemas
 * `lambder.apiSchemaEntries()` reports, to a module the mock validates its
 * calls against (the `apiSchemas` option of initLambderMock().create()).
 * Development only: the module names every endpoint and every field it
 * takes and gives, so no production bundle imports it.
 */
/**
 * The keyword the writer puts on every object that drops the keys it does
 * not declare, as a zod object does by default. JSON Schema has no word for
 * dropping a key: such an object accepts any other key, which is what an
 * absent `additionalProperties` says, and the parse leaves it out, which is
 * what this says. An object that refuses other keys (z.strictObject) carries
 * `additionalProperties: false`, and one that keeps them (z.looseObject, a
 * catchall) the schema they are held to, as zod writes both.
 */
export const LAMBDER_STRIP_UNKNOWN_KEYS = "x-lambder-strip-unknown-keys";
