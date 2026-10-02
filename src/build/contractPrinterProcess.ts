import { CONTRACT_REPORT_PREFIX } from "./generateApiFiles.js";
import { writeApiContract, type LambderApiContractFileOptions, type LambderApiContractFileResult } from "./writeApiContract.js";

/*
 * The process generateApiFiles prints each contract in.
 *
 * Node runs this file as its entry with nothing but the heap generateApiFiles
 * gives it, and writeApiContract's options as the one argument. Reading a
 * contract compiles the server through the TypeScript compiler alone, which
 * imports none of the app's modules, so no loader is needed here; and a large
 * server needs gigabytes of heap for it, which a generator script running
 * under a loader would otherwise have to be started with. It writes or
 * checks the file, and prints its result, or what it threw, as one line.
 */

/** writeApiContract's options as they cross the process boundary: the module as a string, a URL by its href. */
export type ContractPrinterRequest = Omit<LambderApiContractFileOptions, "module"> & { module: string };

/** The result, or the messages of what was thrown, outermost first, down its chain of causes. */
export type ContractPrinterReport = { result: LambderApiContractFileResult } | { thrown: string[] };

const request = JSON.parse(process.argv[2] ?? "null") as ContractPrinterRequest;
let report: ContractPrinterReport;
try {
    report = { result: await writeApiContract(request) };
} catch(err) {
    const thrown = err instanceof Error ? [] : [String(err)];
    for(let cause: unknown = err; cause instanceof Error && thrown.length < 8; cause = cause.cause) thrown.push(cause.message);
    report = { thrown };
}

// Waited for: a write to a pipe can still be pending when the process exits,
// and the parent reads the pipe.
await new Promise<void>((resolveWrite) => process.stdout.write(`\n${CONTRACT_REPORT_PREFIX}${JSON.stringify(report)}\n`, () => resolveWrite()));
process.exit(0);
