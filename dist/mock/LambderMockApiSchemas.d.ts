import { z } from "zod";
import { type LambderApiSchemaEntries } from "../shared/wire/LambderApiSchemaEntries.js";
/**
 * The generated `apiSchemas` table, as the schemas the mock validates every
 * call's input with and parses every answer through.
 */
export declare class LambderMockApiSchemas {
    private readonly table;
    private readonly rebuilt;
    constructor(table: LambderApiSchemaEntries);
    /**
     * The schema an entry's input is validated with, as the pipeline takes it
     * at registration: lazy, so it is rebuilt on the first call that reaches
     * it. A name the table does not hold throws here, when the entry is
     * registered, rather than on its first call.
     */
    inputOf(apiName: string): z.ZodType;
    /**
     * An answer a handler returned, parsed through the server's output schema
     * as the server parses its own: what the schema does not declare dropped,
     * its defaults filled. What it rejects, or a parse that throws, is the
     * handler breaking its contract, the error the server crashes with.
     */
    parseOutput(apiName: string, returned: unknown): unknown;
    private assertHeld;
    /** One of an API's schemas, rebuilt the first time it is asked for and kept. */
    private rebuiltSchema;
}
