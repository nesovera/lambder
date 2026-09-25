import { readFileSync } from "fs";
import { describeSignatureChanges, readSignatureMap, VERIFY_REPORT_PREFIX } from "./writeApiSignatures.js";
const request = JSON.parse(process.argv[2] ?? "null");
const namespace = await import(request.moduleUrl);
const source = namespace[request.exportName];
let verdict;
if (typeof source?.apiSignatureEntries !== "function") {
    verdict = { failure: `${request.moduleUrl} has no export "${request.exportName}" that lists API signatures: name the export holding the instance in exportName` };
}
else {
    const { movedLines, summary } = describeSignatureChanges(await source.apiSignatureEntries(), readSignatureMap(readFileSync(request.file, "utf8")));
    verdict = { same: movedLines.length === 0, lines: [summary, ...movedLines] };
}
// Waited for: a write to a pipe can still be pending when the process exits,
// and the parent reads the pipe.
await new Promise((resolveWrite) => process.stdout.write(`\n${VERIFY_REPORT_PREFIX}${JSON.stringify(verdict)}\n`, () => resolveWrite()));
// The app's module may hold the process open (a client's sockets, a timer),
// and this process exists for the one comparison.
process.exit(0);
