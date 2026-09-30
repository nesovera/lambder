/** One JSON line on stdout, written directly rather than through console.log, which on Lambda prefixes a timestamp and a level that would stop the line reading as JSON. */
export const writeCallSummaryLine = (summary) => {
    const line = `${JSON.stringify(summary)}\n`;
    if (typeof process !== "undefined" && typeof process.stdout?.write === "function")
        process.stdout.write(line);
    else
        console.log(line.trimEnd());
};
/** Milliseconds as the line records them: to a tenth, which is finer than a call can be told apart by and keeps the line short. */
export const roundedMilliseconds = (milliseconds) => Math.round(milliseconds * 10) / 10;
