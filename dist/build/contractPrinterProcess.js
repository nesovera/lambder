import { CONTRACT_REPORT_PREFIX } from "./generateApiFiles.js";
import { writeApiContract } from "./writeApiContract.js";
const request = JSON.parse(process.argv[2] ?? "null");
let report;
try {
    report = { result: await writeApiContract(request) };
}
catch (err) {
    const thrown = err instanceof Error ? [] : [String(err)];
    for (let cause = err; cause instanceof Error && thrown.length < 8; cause = cause.cause)
        thrown.push(cause.message);
    report = { thrown };
}
// Waited for: a write to a pipe can still be pending when the process exits,
// and the parent reads the pipe.
await new Promise((resolveWrite) => process.stdout.write(`\n${CONTRACT_REPORT_PREFIX}${JSON.stringify(report)}\n`, () => resolveWrite()));
process.exit(0);
