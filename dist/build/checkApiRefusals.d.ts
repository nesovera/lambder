export type LambderApiRefusalCheckOptions = {
    /** The tsconfig.json the project compiles under, whose options and path aliases resolve its imports. Relative to the working directory. */
    tsconfig: string;
    /** The files the program starts from, relative to the working directory; everything they import is read too. Default: the tsconfig's own files. */
    files?: string[];
    /** Whether a refusal with no code is a finding, as it is a crash in an app whose vocabulary requires codes (declareRefusals's requireCodes). Default: true. */
    requireCodes?: boolean;
    /** Whether a handler handed no typed refuse is a finding, since nothing it reaches could be checked. Default: true; false lists such handlers without failing. */
    requireTypedRefuse?: boolean;
};
/** What one handler's check found. */
export type LambderRefusalCheckFinding = {
    /** The handler, as its registration names it: an endpoint's `group.action`, a mock entry's name, a guard's name. */
    handler: string;
    /** Where the handler is registered, as `file:line` relative to the working directory. */
    at: string;
    /**
     * - `undeclared`: a code the handler can reach that it may not send.
     * - `unused`: a code the handler's own `refusals` option names that nothing it reaches raises.
     * - `uncoded`: a refusal with no code it can reach, where codes are required.
     * - `unreadable`: a refusal it can reach whose code is not a string literal type.
     * - `untraced`: a handler handed a typed refuse whose function cannot be
     *   found (a parameter, a dependency's value), so nothing it reaches was
     *   checked.
     * - `unchecked`: a handler handed no typed refuse, built by an init that
     *   declared no refusal vocabulary, so there is nothing to hold what it
     *   reaches to. Not a finding with `requireTypedRefuse: false`.
     */
    problem: "undeclared" | "unused" | "uncoded" | "unreadable" | "untraced" | "unchecked";
    /** The code, for `undeclared` and `unused`. */
    code?: string;
    /** Where the refusal is raised, as `file:line`, for `undeclared`, `uncoded` and `unreadable`. */
    raisedAt?: string;
};
export type LambderApiRefusalCheckResult = {
    /** False when the project could not be read, no handler in it could be checked, or any handler has a finding, an unchecked one included unless `requireTypedRefuse` is false. */
    ok: boolean;
    /** How many handlers were checked. */
    handlers: number;
    findings: LambderRefusalCheckFinding[];
    /** What happened, as lines to print: a summary, then one line per finding. */
    lines: string[];
};
/**
 * Checks every handler of a project against the codes it may send, and
 * answers what it found.
 *
 * ```ts
 * import { checkApiRefusals } from "lambder/build";
 *
 * const result = await checkApiRefusals({ tsconfig: "server/tsconfig.json" });
 * console.log(result.lines.join("\n"));
 * process.exit(result.ok ? 0 : 1);
 * ```
 *
 * Run it where the app runs its other build checks, or from a test: it
 * compiles the project, so it takes as long as a type check does.
 */
export declare const checkApiRefusals: (options: LambderApiRefusalCheckOptions) => Promise<LambderApiRefusalCheckResult>;
