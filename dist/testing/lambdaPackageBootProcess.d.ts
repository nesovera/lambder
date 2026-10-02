/** What the process is started with, as JSON in its one argument. */
export type LambdaPackageBootSetup = {
    /** The handler module's file URL. */
    handlerUrl: string;
    /** The export Lambda calls. */
    handlerExport: string;
    /** The package root's file URL, ending in a slash: what the deployment carries. */
    packageUrl: string;
    /** Package names and scopes the Lambda runtime supplies, so the package leaves them out. */
    runtimeModules: string[];
    /** The directory those resolve from, standing in for the runtime's own copy. */
    runtimeModulesFrom: string;
    /** What getRemainingTimeInMillis counts down from at each call. */
    callTimeoutMs: number;
};
/** One call, as the parent sends it. */
export type LambdaPackageBootCallRequest = {
    index: number;
    event: unknown;
};
/** What the process reports, one message per step. */
export type LambdaPackageBootReport = {
    kind: "imported";
    importMs: number;
    rssBytes: number;
    handlerType: string;
    exportNames: string[];
} | {
    kind: "importFailed";
    error: string;
} | {
    kind: "answered";
    index: number;
    returned: unknown;
} | {
    kind: "threw";
    index: number;
    error: string;
};
