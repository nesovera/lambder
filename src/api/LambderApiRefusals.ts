import type { z } from "zod";
import type { LambderJsonOf } from "../shared/wire/LambderApiContract.js";
import type { LambderRefusalStatusCode } from "../shared/wire/LambderHttpStatus.js";
import type { LambderNoExtraKeys } from "../shared/util/LambderTypeUtilities.js";
import { LambderApiRefusal, isLambderRefusalCode } from "../shared/wire/LambderApiRefusal.js";
import { describePayloadKind, isObjectPayload } from "../shared/wire/LambderObjectPayload.js";

/**
 * One code of an app's refusal vocabulary: the schema of the data it carries,
 * when it carries data, and how every refusal with the code leaves the
 * server. A code's data is an object or an array, as an API's output is. The
 * status and the flag are declared once here rather than at each raise site,
 * so a code always reaches a caller the same way.
 */
export type LambderRefusalDeclaration = {
    /** The schema of the code's data, when it carries data. */
    data?: z.ZodType;
    /** The HTTP status every refusal with this code leaves with. Default 200: the envelope is the channel. */
    status?: LambderRefusalStatusCode;
    /** Whether every refusal with this code sets the envelope's notAuthorized flag, which a caller routes to its notAuthorizedHandler. */
    notAuthorized?: true;
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
} & ({ data: false } | { data: true; schema: z.ZodType });

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
type LambderRefusalDataCheck<TDeclaration> =
    TDeclaration extends { data: infer TSchema extends z.ZodType }
        ? 0 extends 1 & z.output<TSchema> ? unknown
        : undefined extends z.output<TSchema> ? LambderRefusalDataRefusal
        : [LambderJsonOf<z.output<TSchema>>] extends [never] ? LambderRefusalDataRefusal
        : [LambderJsonOf<z.output<TSchema>>] extends [object] ? unknown
        : LambderRefusalDataRefusal
        : unknown;
type LambderRefusalDataRefusal = { data: { readonly "lambder: a refusal's data is an object or an array, as an API's output is.": never } };

/**
 * The vocabulary as declareRefusals() checks it, code by code: no `lambder/`
 * prefix, no key beside data, status and notAuthorized (a `dat:` would leave
 * a code that carries data declared as one that does not), and data that is
 * an object or an array.
 */
export type LambderRefusalVocabularyChecks<TVocabulary> = {
    [TCode in keyof TVocabulary]:
        TCode extends `lambder/${string}`
            ? { readonly "lambder: a refusal code may not start with lambder/, the prefix of the framework's own codes": never }
            : LambderNoExtraKeys<TVocabulary[TCode], LambderRefusalDeclaration> & LambderRefusalDataCheck<TVocabulary[TCode]>;
};

/** One code's declaration as checkedRefusal reads it: how a refusal with the code leaves, and its schema. */
export const allowedRefusalOf = (declaration: LambderRefusalDeclaration): LambderApiAllowedRefusal => {
    const leaves = {
        ...(declaration.status !== undefined ? { status: declaration.status } : {}),
        ...(declaration.notAuthorized ? { notAuthorized: true as const } : {}),
    };
    return declaration.data === undefined ? { ...leaves, data: false } : { ...leaves, data: true, schema: declaration.data };
};

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
type LambderRefusalViolation =
    | { uncoded: true }
    | { undeclared: string }
    | { dataWithoutDeclaredCode: string | undefined }
    | { missingData: string }
    | { ownStatusOrFlag: true }
    | { zodError: z.ZodError }
    | { thrown: unknown }
    | { notObject: string };

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
export class LambderApiRefusalValidationError extends Error {
    readonly apiName: string;
    /** The code the refusal carried, if any. */
    readonly code: string | undefined;
    /** The schema's issues when the code's schema rejected the data; null otherwise. */
    readonly zodError: z.ZodError | null;

    constructor(apiName: string, thrown: LambderApiRefusal, violation: LambderRefusalViolation){
        const code = thrown.refusal.code;
        let message: string;
        if("uncoded" in violation){
            message = `Lambder: API "${apiName}" refused without a code, and this app requires every refusal an API answers with to name a declared code (declareRefusals with requireCodes), so the refusal was not sent. `
                + "Name one of the API's declared codes, or a framework code.";
        } else if("undeclared" in violation){
            message = `Lambder: API "${apiName}" refused with the code "${violation.undeclared}", which it does not declare, so the refusal was not sent. `
                + "Name the code in the API's refusals option (or in a guard it declares), from the refusals vocabulary given at creation.";
        } else if("dataWithoutDeclaredCode" in violation){
            message = violation.dataWithoutDeclaredCode === undefined
                ? `Lambder: API "${apiName}" refused with data but no code, so the refusal was not sent. Only a declared code carries data.`
                : `Lambder: API "${apiName}" refused with the code "${violation.dataWithoutDeclaredCode}" and data it does not declare, so the refusal was not sent.`;
        } else if("missingData" in violation){
            message = `Lambder: API "${apiName}" refused with the code "${violation.missingData}", which carries data, and no data, so the refusal was not sent.`;
        } else if("ownStatusOrFlag" in violation){
            message = `Lambder: API "${apiName}" refused with the declared code "${String(code)}" and a status or flag of its own, so the refusal was not sent. `
                + "A declared code's status and notAuthorized flag are its declaration's: set them in the refusals vocabulary, and leave them off the refuse() call.";
        } else if("zodError" in violation){
            // Paths and messages only, never the values: they may be the
            // user's data.
            const issues = violation.zodError.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
            message = `Lambder: API "${apiName}" refused with the code "${String(code)}" and data its schema does not accept, so the refusal was not sent. ${issues}`;
        } else if("thrown" in violation){
            message = `Lambder: API "${apiName}" refused with the code "${String(code)}" and data its schema threw on while parsing it (a transform that threw, `
                + "or an async step: a refusal's data is parsed synchronously), so the refusal was not sent.";
        } else {
            message = `Lambder: API "${apiName}" refused with the code "${String(code)}" and data that is ${violation.notObject}, and a refusal's data is an object or an array, so the refusal was not sent.`;
        }
        super(message, { cause: thrown });
        this.name = "LambderApiRefusalValidationError";
        this.apiName = apiName;
        this.code = code;
        this.zodError = "zodError" in violation ? violation.zodError : null;
    }
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
 * - A declared code leaves with its declaration's status and notAuthorized
 *   flag, and with data exactly when the code carries data, parsed through
 *   the code's schema as an output is: undeclared fields stripped, defaults
 *   filled, transforms run. The parse is synchronous, so a data schema cannot
 *   be async.
 * - Anything else is refused, a declared code raised with a status or flag of
 *   its own included.
 *
 * `endpoint` undefined means the endpoint's codes are not known here (a mock
 * given no generated options), and nothing is checked.
 */
export const checkedRefusal = (apiName: string, endpoint: LambderEndpointRefusals | undefined, thrown: LambderApiRefusal): LambderApiRefusal => {
    if(endpoint === undefined) return thrown;
    const { code, data } = thrown.refusal;
    if(code === undefined || isLambderRefusalCode(code)){
        if(code === undefined && endpoint.codeRequired) throw new LambderApiRefusalValidationError(apiName, thrown, { uncoded: true });
        if(data !== undefined) throw new LambderApiRefusalValidationError(apiName, thrown, { dataWithoutDeclaredCode: code });
        return thrown;
    }
    const declaration = endpoint.codes.get(code);
    if(declaration === undefined) throw new LambderApiRefusalValidationError(apiName, thrown, { undeclared: code });
    if(thrown.statusCode !== undefined || thrown.notAuthorized || thrown.sessionExpired){
        throw new LambderApiRefusalValidationError(apiName, thrown, { ownStatusOrFlag: true });
    }
    let sent: unknown;
    if(!declaration.data){
        if(data !== undefined) throw new LambderApiRefusalValidationError(apiName, thrown, { dataWithoutDeclaredCode: code });
    } else if(data === undefined){
        throw new LambderApiRefusalValidationError(apiName, thrown, { missingData: code });
    } else {
        let parsed: z.ZodSafeParseResult<unknown>;
        try {
            parsed = declaration.schema.safeParse(data);
        } catch(cause){
            throw new LambderApiRefusalValidationError(apiName, thrown, { thrown: cause });
        }
        if(!parsed.success) throw new LambderApiRefusalValidationError(apiName, thrown, { zodError: parsed.error });
        if(!isObjectPayload(parsed.data)) throw new LambderApiRefusalValidationError(apiName, thrown, { notObject: describePayloadKind(parsed.data) });
        sent = parsed.data;
    }
    // The declaration's status and flag, and the data as parsed: how every
    // refusal with this code leaves, wherever it was raised.
    return new LambderApiRefusal(thrown.message, {
        refusal: { ...thrown.refusal, ...(sent !== undefined ? { data: sent } : {}) },
        notAuthorized: declaration.notAuthorized,
        statusCode: declaration.status,
        headers: thrown.headers,
        cause: thrown.cause,
    });
};

/**
 * Throws when `where` (an API, a guard) names a refusal code the vocabulary
 * does not hold, or names one when there is no vocabulary at all.
 */
export const assertRefusalCodesDeclared = (where: string, codes: readonly string[], vocabulary: ReadonlyMap<string, LambderRefusalDeclaration> | null): void => {
    for(const code of codes){
        if(!vocabulary){
            throw new Error(`Lambder: ${where} declares the refusal "${code}", but no refusals vocabulary was declared. Declare the app's codes with initLambder().declareRefusals().`);
        }
        if(!vocabulary.has(code)){
            throw new Error(`Lambder: ${where} declares the refusal "${code}", which the refusals vocabulary does not hold.`);
        }
    }
};

/**
 * One endpoint's allowed codes, resolved from the vocabulary: the codes its
 * own `refusals` option names and those of its declared guards, each as
 * checkedRefusal reads it, schema included. Throws on a name the vocabulary
 * does not hold, and on a declaration when there is no vocabulary at all.
 */
export const resolveAllowedRefusals = (
    apiName: string,
    vocabulary: ReadonlyMap<string, LambderRefusalDeclaration> | null,
    ownCodes: readonly string[],
    guardCodes: readonly { guard: string; codes: readonly string[] }[],
): LambderApiAllowedRefusals => {
    const allowed = new Map<string, LambderApiAllowedRefusal>();
    const take = (code: string, where: string) => {
        assertRefusalCodesDeclared(where, [code], vocabulary);
        allowed.set(code, allowedRefusalOf(vocabulary!.get(code)!));
    };
    for(const code of ownCodes) take(code, `API "${apiName}"`);
    for(const { guard, codes } of guardCodes){
        for(const code of codes) take(code, `guard "${guard}" (declared by API "${apiName}")`);
    }
    return allowed;
};

/** The refusals option in its list form: one name becomes a list of one. */
export const toRefusalCodes = (value: string | readonly string[] | undefined): readonly string[] =>
    value === undefined ? [] : typeof value === "string" ? [value] : value;

/**
 * The vocabulary, checked: every code a non-empty string outside the
 * framework's `lambder/` prefix, every declaration an object whose `data`,
 * when present, is a zod schema, whose `status`, when present, is one a
 * reader files as a refusal, and whose `notAuthorized`, when present, is
 * true. A Map, so a code named for something Object.prototype carries
 * ("toString") is still an ordinary code.
 */
export const readRefusalVocabulary = (refusals: Record<string, LambderRefusalDeclaration> | undefined): Map<string, LambderRefusalDeclaration> | null => {
    if(refusals === undefined) return null;
    const entries = Object.entries(refusals);
    if(entries.length === 0){
        throw new Error("Lambder: the refusals vocabulary was declared with no codes in it, which declares nothing. Name the codes APIs will refuse with, or leave declareRefusals() out.");
    }
    for(const [code, declaration] of entries){
        if(code === "") throw new Error("Lambder: the refusals vocabulary declares an empty code.");
        if(code.startsWith("lambder/")){
            throw new Error(`Lambder: the refusals vocabulary declares "${code}", under the "lambder/" prefix the framework's own codes use. Name it outside that prefix.`);
        }
        if(declaration === null || typeof declaration !== "object"){
            throw new Error(`Lambder: the refusal "${code}" is not declared as an object: write {} for a code with no data, or { data: schema }.`);
        }
        const extra = Object.keys(declaration).filter((key) => key !== "data" && key !== "status" && key !== "notAuthorized");
        if(extra.length){
            throw new Error(`Lambder: the refusal "${code}" has ${extra.map((key) => `"${key}"`).join(", ")} beside data, status and notAuthorized, which a refusal declaration does not take.`);
        }
        // Read for what it is used as rather than by class, so a schema from
        // a second copy of zod in the bundle still counts.
        if(declaration.data !== undefined && typeof (declaration.data as { safeParse?: unknown } | null)?.safeParse !== "function"){
            throw new Error(`Lambder: the refusal "${code}" declares data that is not a zod schema.`);
        }
        const status = declaration.status as unknown;
        if(status !== undefined && (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status >= 500 || status === 422)){
            throw new Error(`Lambder: the refusal "${code}" declares the status ${String(status)}. A declared refusal leaves with a status from 200 to 499 other than 422: a reader files a 5xx as a server failure and a 422 as an input validation failure.`);
        }
        if(declaration.notAuthorized !== undefined && declaration.notAuthorized !== true){
            throw new Error(`Lambder: the refusal "${code}" declares notAuthorized as ${String(declaration.notAuthorized)}; write true, or leave it off.`);
        }
    }
    return new Map(entries);
};

/** The per-API refusals option: one code of the vocabulary, or a non-empty list of them. Empty is not a declaration, so it is not a form. */
export type LambderRefusalsOption<TVocabulary> =
    | (keyof TVocabulary & string)
    | readonly [keyof TVocabulary & string, ...(keyof TVocabulary & string)[]];

/** The codes a refusals option names, whichever of its two forms is used: toRefusalCodes at the type level. */
export type LambderRefusalNamesIn<TOpt> =
    TOpt extends string ? TOpt
    : TOpt extends readonly (infer TCode extends string)[] ? TCode
    : never;

/**
 * The codes as an API handler raises them (ctx.refuse): each mapped to
 * `{ data }` in the schema's input form, the one its transforms take, or to
 * `{}` for a code with no data.
 */
export type LambderHandlerRefusalsOf<TVocabulary, TCodes extends string> = {
    [TCode in TCodes]: TCode extends keyof TVocabulary
        ? TVocabulary[TCode] extends { data: infer TSchema extends z.ZodType } ? { data: z.input<TSchema> } : {}
        : never
};

/**
 * The codes as a contract records them, for the client to narrow on: each
 * mapped to `{ data }` as JSON (the schema's output after its transforms, as
 * it arrives) or to `{}`. never when there are none, so the entry leaves the
 * member out.
 */
export type LambderWireRefusalsOf<TVocabulary, TCodes extends string> =
    [TCodes] extends [never] ? never : {
        [TCode in TCodes]: TCode extends keyof TVocabulary
            ? TVocabulary[TCode] extends { data: infer TSchema extends z.ZodType } ? { data: LambderJsonOf<z.output<TSchema>> } : {}
            : never
    };
