import { type LambderApiContractFileOptions, type LambderApiContractFileResult } from "./writeApiContract.js";
/** writeApiContract's options as they cross the process boundary: the module as a string, a URL by its href. */
export type ContractPrinterRequest = Omit<LambderApiContractFileOptions, "module"> & {
    module: string;
};
/** The result, or the messages of what was thrown, outermost first, down its chain of causes. */
export type ContractPrinterReport = {
    result: LambderApiContractFileResult;
} | {
    thrown: string[];
};
