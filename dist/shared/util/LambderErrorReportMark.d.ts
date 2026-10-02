/** Marks an error as reported where it arose. */
export declare const markErrorReported: (error: Error) => void;
/** Whether an error was marked as reported where it arose. Read by brand, so it holds across realms and package copies. */
export declare const isErrorReported: (error: unknown) => boolean;
