/**
 * An optional peer package loaded on first use, failing with the install hint.
 *
 * The AWS SDK packages a store or bucket talks through are optional peer
 * dependencies, so an app that never uses one neither installs it nor pays
 * for loading it. A package that fails to load fails that first call with a
 * message naming the class that needed it and the command that installs it.
 * The failure is not remembered: the package may be installed later in the
 * same process (tests do), and the next caller names itself.
 */
export declare const withInstallHint: <T>(loading: Promise<T>, packageName: string, user: string, reset: () => void) => Promise<T>;
