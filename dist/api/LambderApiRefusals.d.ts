import type { z } from "zod";
import type { LambderJsonOf } from "../shared/wire/LambderApiContract.js";
import type { LambderRefusalStatusCode } from "../shared/wire/LambderHttpStatus.js";
import type { LambderNoExtraKeys } from "../shared/util/LambderTypeUtilities.js";
import { LambderApiRefusal } from "../shared/wire/LambderApiRefusal.js";
import { type LambderMergedNamedMaps, type LambderNamedMapsOption, type LambderNoRepeatedNames } from "../shared/util/LambderNamedMaps.js";
/**
 * One code of an app's refusal vocabulary: the schema of the data it carries,
 * when it carries data, and how every refusal with the code leaves the
 * server. A code's data is an object or an array, as an API's output is. The
 * status and the flags are declared once here rather than at each raise site,
 * so a code always reaches a caller the same way.
 */
export type LambderRefusalDeclaration = {
    /** The schema of the code's data, when it carries data. */
    data?: z.ZodType;
    /** The HTTP status every refusal with this code leaves with. Default 200: the envelope is the channel. */
    status?: LambderRefusalStatusCode;
    /** Whether every refusal with this code sets the envelope's notAuthorized flag, which a caller routes to its notAuthorizedHandler. */
    notAuthorized?: true;
    /**
     * Whether every refusal with this code sets the envelope's sessionExpired
     * flag, which a caller answers by clearing its session and routing to its
     * sessionExpiredHandler: for a session the handler found no longer good
     * (its login deleted, say), which the pipeline's own check could not know.
     * The server ends the session the call held as the refusal leaves.
     */
    sessionExpired?: true;
};
/**
 * One code as its endpoint may send it: the status and flag its declaration
 * gives it, and whether it carries data, with the data's schema when it does.
 * The server and the mock both resolve it from the vocabulary
 * (allowedRefusalOf), so a refusal's data is parsed the same way on both.
 */
export type LambderApiAllowedRefusal = {
    /** The status every refusal with the code leaves with; 200 when absent. */
    status?: LambderRefusalStatusCode;
    /** Present when every refusal with the code sets the envelope's notAuthorized flag. */
    notAuthorized?: true;
    /** Present when every refusal with the code sets the envelope's sessionExpired flag. */
    sessionExpired?: true;
} & ({
    data: false;
} | {
    data: true;
    schema: z.ZodType;
});
/** The codes one endpoint may refuse with: its own `refusals` option and those of the guards it declares. */
export type LambderApiAllowedRefusals = ReadonlyMap<string, LambderApiAllowedRefusal>;
/** The app's refusal vocabulary, as `initLambder().declareRefusals()` and the mock's take it: every code once, with its declaration. */
export type LambderRefusalVocabulary = Record<string, LambderRefusalDeclaration>;
/**
 * What declareRefusals() hands the rest of an init, the server's and the
 * mock's alike: the vocabulary as declared, checked and keyed, and whether
 * every refusal an API answers with has to name a code.
 */
export type LambderDeclaredVocabulary<TRefusals extends LambderRefusalVocabulary, TCodesRequired extends boolean> = {
    refusals: TRefusals;
    vocabulary: ReadonlyMap<string, LambderRefusalDeclaration>;
    requireCodes: TCodesRequired;
};
/** A refusal's data is an object or an array, as an API's output is: the same rule, where the code is declared. */
type LambderRefusalDataCheck<TDeclaration> = TDeclaration extends {
    data: infer TSchema extends z.ZodType;
} ? 0 extends 1 & z.output<TSchema> ? unknown : undefined extends z.output<TSchema> ? LambderRefusalDataRefusal : [LambderJsonOf<z.output<TSchema>>] extends [never] ? LambderRefusalDataRefusal : [LambderJsonOf<z.output<TSchema>>] extends [object] ? unknown : LambderRefusalDataRefusal : unknown;
type LambderRefusalDataRefusal = {
    data: {
        readonly "lambder: a refusal's data is an object or an array, as an API's output is.": never;
    };
};
/**
 * The vocabulary as declareRefusals() checks it, code by code: no `lambder/`
 * prefix, no key beside data, status and the two flags (a `dat:` would leave
 * a code that carries data declared as one that does not), and data that is
 * an object or an array.
 */
export type LambderRefusalVocabularyChecks<TVocabulary> = {
    [TCode in keyof TVocabulary]: TCode extends `lambder/${string}` ? {
        readonly "lambder: a refusal code may not start with lambder/, the prefix of the framework's own codes": never;
    } : LambderNoExtraKeys<TVocabulary[TCode], LambderRefusalDeclaration> & LambderRefusalDataCheck<TVocabulary[TCode]>;
};
/**
 * The vocabulary as declareRefusals() takes it: one map of codes, or a list of
 * them, so each part of an app declares its own codes beside its APIs. A
 * code two maps declare is refused.
 */
export type LambderRefusalVocabularyOption = LambderNamedMapsOption<LambderRefusalVocabulary>;
/** The one vocabulary a declareRefusals() option declares: a list's maps merged, a lone map as it is. */
export type LambderMergedRefusalVocabulary<TOption> = LambderMergedNamedMaps<TOption> extends infer TMerged extends LambderRefusalVocabulary ? TMerged : never;
/** A declareRefusals() option checked code by code, in each map of a list, and a list declaring no code twice. */
export type LambderRefusalVocabularyOptionChecks<TOption> = TOption extends readonly unknown[] ? {
    [TIndex in keyof TOption]: LambderRefusalVocabularyChecks<TOption[TIndex]>;
} & LambderNoRepeatedNames<TOption> : LambderRefusalVocabularyChecks<TOption>;
/**
 * A declareRefusals() option as the one vocabulary it declares, checked
 * (see readRefusalVocabulary) and keyed. `declarer` names the init in the
 * errors.
 */
export declare const declaredRefusalVocabulary: (option: LambderRefusalVocabularyOption, declarer: string) => {
    refusals: LambderRefusalVocabulary;
    vocabulary: Map<string, LambderRefusalDeclaration>;
};
/** One code's declaration as checkedRefusal reads it: how a refusal with the code leaves, and its schema. */
export declare const allowedRefusalOf: (declaration: LambderRefusalDeclaration) => LambderApiAllowedRefusal;
/**
 * What one endpoint's refusals are checked against: the codes it may refuse
 * with, and whether every refusal it answers with has to name one
 * (declareRefusals's `requireCodes`). Undefined on a definition whose codes
 * are not known (a mock without the generated tables), which checks nothing.
 */
export type LambderEndpointRefusals = {
    codes: LambderApiAllowedRefusals;
    codeRequired: boolean;
};
/** How a refusal broke its endpoint's declaration. */
type LambderRefusalViolation = {
    uncoded: true;
} | {
    undeclared: string;
} | {
    dataWithoutDeclaredCode: string | undefined;
} | {
    missingData: string;
} | {
    ownStatusOrFlag: true;
} | {
    zodError: z.ZodError;
} | {
    thrown: unknown;
} | {
    notObject: string;
};
/**
 * A refusal an endpoint is not allowed to send, so it was not sent and the
 * call is answered as a crash: no code where the app requires one, a code
 * the endpoint does not declare (neither
 * in its own `refusals` option nor through a guard), data on a refusal whose
 * code declares none, no data on one whose code carries data, data its code's
 * schema rejects or that is not an object or an array, or a declared code
 * raised with a status or flag of its own, which its declaration owns.
 *
 * What makes a client's refusal type exact: a reader narrows `code` to the
 * endpoint's declared codes and the framework's own, and relies on this to
 * never see another. The refusal side's counterpart of
 * LambderApiOutputValidationError. The refusal as thrown is the cause, so
 * the stack points at the line that raised it.
 */
export declare class LambderApiRefusalValidationError extends Error {
    readonly apiName: string;
    /** The code the refusal carried, if any. */
    readonly code: string | undefined;
    /** The schema's issues when the code's schema rejected the data; null otherwise. */
    readonly zodError: z.ZodError | null;
    constructor(apiName: string, thrown: LambderApiRefusal, violation: LambderRefusalViolation);
}
/**
 * The refusal as endpoint `apiName` may send it, or a thrown
 * LambderApiRefusalValidationError when it may not. Where a thrown refusal
 * becomes an answer for a known endpoint (the pipeline, a hook refusing an
 * API call on the server, an injected failure in the mock), it passes through
 * here first.
 *
 * - An uncoded refusal, or one carrying a framework code, goes out as it is,
 *   provided it carries no data. Where the app requires codes, an uncoded
 *   refusal is refused too; a framework code still passes.
 * - A declared code leaves with its declaration's status and flags, and
 *   with data exactly when the code carries data, parsed through
 *   the code's schema as an output is: undeclared fields stripped, defaults
 *   filled, transforms run. The parse is synchronous, so a data schema cannot
 *   be async.
 * - Anything else is refused, a declared code raised with a status or flag of
 *   its own included.
 *
 * `endpoint` undefined means the endpoint's codes are not known here (a mock
 * given no generated options), and nothing is checked.
 */
export declare const checkedRefusal: (apiName: string, endpoint: LambderEndpointRefusals | undefined, thrown: LambderApiRefusal) => LambderApiRefusal;
/**
 * Throws when `where` (an API, a guard) names a refusal code the vocabulary
 * does not hold, or names one when there is no vocabulary at all.
 */
export declare const assertRefusalCodesDeclared: (where: string, codes: readonly string[], vocabulary: ReadonlyMap<string, LambderRefusalDeclaration> | null) => void;
/**
 * One endpoint's allowed codes, resolved from the vocabulary: the codes its
 * own `refusals` option names and those of its declared guards, each as
 * checkedRefusal reads it, schema included. Throws on a name the vocabulary
 * does not hold, and on a declaration when there is no vocabulary at all.
 */
export declare const resolveAllowedRefusals: (apiName: string, vocabulary: ReadonlyMap<string, LambderRefusalDeclaration> | null, ownCodes: readonly string[], guardCodes: readonly {
    guard: string;
    codes: readonly string[];
}[]) => LambderApiAllowedRefusals;
/** The refusals option in its list form: one name becomes a list of one. */
export declare const toRefusalCodes: (value: string | readonly string[] | undefined) => readonly string[];
/**
 * The vocabulary, checked: every code a non-empty string outside the
 * framework's `lambder/` prefix, every declaration an object whose `data`,
 * when present, is a zod schema, whose `status`, when present, is one a
 * reader files as a refusal, and whose `notAuthorized` and `sessionExpired`,
 * when present, are true. A Map, so a code named for something Object.prototype carries
 * ("toString") is still an ordinary code.
 */
export declare const readRefusalVocabulary: (refusals: Record<string, LambderRefusalDeclaration> | undefined) => Map<string, LambderRefusalDeclaration> | null;
/** The per-API refusals option: one code of the vocabulary, or a non-empty list of them. Empty is not a declaration, so it is not a form. */
export type LambderRefusalsOption<TVocabulary> = (keyof TVocabulary & string) | readonly [keyof TVocabulary & string, ...(keyof TVocabulary & string)[]];
/** The codes a refusals option names, whichever of its two forms is used: toRefusalCodes at the type level. */
export type LambderRefusalNamesIn<TOpt> = TOpt extends string ? TOpt : TOpt extends readonly (infer TCode extends string)[] ? TCode : never;
/**
 * The codes as an API handler raises them (ctx.refuse): each mapped to
 * `{ data }` in the schema's input form, the one its transforms take, or to
 * `{}` for a code with no data.
 */
export type LambderHandlerRefusalsOf<TVocabulary, TCodes extends string> = {
    [TCode in TCodes]: TCode extends keyof TVocabulary ? TVocabulary[TCode] extends {
        data: infer TSchema extends z.ZodType;
    } ? {
        data: z.input<TSchema>;
    } : {} : never;
};
/**
 * The codes as a contract records them, for the client to narrow on: each
 * mapped to `{ data }` as JSON (the schema's output after its transforms, as
 * it arrives) or to `{}`. never when there are none, so the entry leaves the
 * member out.
 */
export type LambderWireRefusalsOf<TVocabulary, TCodes extends string> = [
    TCodes
] extends [never] ? never : {
    [TCode in TCodes]: TCode extends keyof TVocabulary ? TVocabulary[TCode] extends {
        data: infer TSchema extends z.ZodType;
    } ? {
        data: LambderJsonOf<z.output<TSchema>>;
    } : {} : never;
};
export {};
