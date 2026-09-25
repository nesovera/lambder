import { readFileSync } from "fs";
import { describeSignatureChanges, readSignatureMap, VERIFY_REPORT_PREFIX, type LambderApiSignatureSource } from "./writeApiSignatures.js";

/*
 * The fresh process writeApiSignatures starts to verify a file it wrote.
 *
 * Node runs this file as its entry, with the parent's loader flags and the
 * request as the one argument. It imports the module that holds the
 * instance, digests the signatures there, compares them with the file, and
 * prints its verdict as one line. The calling script is never loaded here,
 * so nothing a generator does before or after its call runs twice.
 */

/** What the parent asks for: which export of which module to digest, and the file to compare it with. */
export type FreshProcessRequest = { moduleUrl: string; exportName: string; file: string };

/** The comparison, or why none could be made. */
export type FreshProcessVerdict = { same: boolean; lines: string[] } | { failure: string };

const request = JSON.parse(process.argv[2] ?? "null") as FreshProcessRequest;
const namespace = await import(request.moduleUrl) as Record<string, unknown>;
const source = namespace[request.exportName] as Partial<LambderApiSignatureSource> | null | undefined;
let verdict: FreshProcessVerdict;
if(typeof source?.apiSignatureEntries !== "function"){
    verdict = { failure: `${request.moduleUrl} has no export "${request.exportName}" that lists API signatures: name the export holding the instance in exportName` };
}else{
    const { movedLines, summary } = describeSignatureChanges(await source.apiSignatureEntries(), readSignatureMap(readFileSync(request.file, "utf8")));
    verdict = { same: movedLines.length === 0, lines: [summary, ...movedLines] };
}

// Waited for: a write to a pipe can still be pending when the process exits,
// and the parent reads the pipe.
await new Promise<void>((resolveWrite) => process.stdout.write(`\n${VERIFY_REPORT_PREFIX}${JSON.stringify(verdict)}\n`, () => resolveWrite()));
// The app's module may hold the process open (a client's sockets, a timer),
// and this process exists for the one comparison.
process.exit(0);
