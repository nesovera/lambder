/**
 * Drops the call summary lines from the suite's output.
 *
 * An instance writes one JSON line per API call, and per request a route
 * answered, on stdout unless told otherwise (the callSummary option), and
 * many tests render events through an instance built with the defaults,
 * because the wire and the pipeline are what they test. Those lines are the framework working, not anything a test
 * reports, and vitest cannot attribute them to a test, since they bypass the
 * console. The tests about the summaries read them through a test app, or
 * through a spy on process.stdout.write, which records every line before
 * this filter drops it.
 */

// The line's start as writeCallSummaryLine writes it (src/core/LambderCallSummary.ts).
const SUMMARY_LINE_START = '{"kind":"lambder.call"';

const writeThrough = process.stdout.write.bind(process.stdout) as (...args: unknown[]) => boolean;

process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
    typeof chunk === 'string' && chunk.startsWith(SUMMARY_LINE_START) ? true : writeThrough(chunk, ...rest)
) as typeof process.stdout.write;
