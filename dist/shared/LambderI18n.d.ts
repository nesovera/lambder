/**
 * LambderI18n: standalone, framework-free, isomorphic typed translation module.
 *
 * Zero dependencies, no Node/DOM requirements (browser detection is feature-gated),
 * safe to import in both lambda backends and frontend bundles.
 *
 * See docs/i18n.md for the full guide.
 */
export interface LambderLanguageMeta {
    /** Native language name (shown in language switchers). */
    name: string;
    /** English language name, for accessibility / tooltips. */
    englishName?: string;
    /** BCP-47 locale for Intl APIs (e.g. "zh-CN"). Defaults to the code. */
    intlLocale?: string;
    /** Text direction. Defaults to "ltr". */
    dir?: "ltr" | "rtl";
    /** App-specific extras (e.g. flag emoji). */
    [extra: string]: unknown;
}
/**
 * The plural categories `Intl.PluralRules` sorts a count into. Which of them
 * a language uses is its own: English uses one and other, Arabic all six,
 * Japanese other alone.
 */
export type LambderI18nPluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
/**
 * A text that varies with a count: one form per plural category, keyed by
 * category, so `{ one: "{count} item", other: "{count} items" }`.
 * `t(key, { count })` picks the form for the count under the plural rules
 * of the language the text is in, and `other` when the entry lacks the
 * category picked. `other` is required, so there is always a form to fall
 * back to. Which other categories a language uses is the runtime's plural
 * data, which differs between runtimes, so whether an entry holds them all
 * is what `checkPluralCoverage()` reports, in a test or a build, rather than
 * anything that fails where the dictionary arrives.
 */
export interface LambderI18nPluralEntry {
    zero?: string;
    one?: string;
    two?: string;
    few?: string;
    many?: string;
    other: string;
}
/** What a dictionary holds under one key: a text, or a plural entry. */
export type LambderI18nDictionaryEntry = string | LambderI18nPluralEntry;
/** Extracts `{param}` placeholder names from a string literal type. */
export type LambderI18nExtractParams<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | LambderI18nExtractParams<Rest> : never;
/** The `{param}` names across every form of a plural entry. */
type PluralEntryParams<TEntry> = LambderI18nExtractParams<Extract<TEntry[keyof TEntry], string>>;
/**
 * Typed translator: `t(key)`, and when the key's contract value contains
 * `{tokens}`, a params object with exactly those tokens is required. A
 * plural key always takes one: a numeric `count`, which picks the form,
 * beside the tokens across its forms.
 *
 * The text test is wrapped (`[...] extends [string]`) so that it does not
 * distribute: a translator stays comparable to `(key: string) => string`,
 * which a cast for keys known only at runtime relies on.
 */
export type LambderI18nTranslator<TContract extends Record<string, LambderI18nDictionaryEntry>> = <K extends keyof TContract & string>(...args: [TContract[K]] extends [string] ? LambderI18nExtractParams<TContract[K] & string> extends never ? [key: K] : [key: K, params: Record<LambderI18nExtractParams<TContract[K] & string>, string | number>] : [key: K, params: {
    count: number;
} & Record<Exclude<PluralEntryParams<TContract[K]>, "count">, string | number>]) => string;
/**
 * What a language other than the default gives for a contract (the default
 * language's block): a text for each text, and for each plural entry a
 * plural entry of its own, whose forms are its language's. A plain text in
 * place of a plural entry stands for the other form alone: complete for a
 * language whose rules use nothing else (Japanese, say), and a gap that
 * `checkPluralCoverage()` reports for any other. A plural entry where the
 * contract has a text is a type error: `t` takes no count for that key, so
 * no form could be picked.
 */
type TranslationBlock<TContract> = {
    [K in keyof TContract]: TContract[K] extends string ? string : LambderI18nDictionaryEntry;
};
/**
 * A language block fetched on demand instead of bundled: a function that
 * resolves to the dictionary, or to a module whose default export is the
 * dictionary, so `() => import("./tr")` is a loader. It runs when
 * `loadLanguage` asks for its language, never before.
 */
export type LambderI18nDictionaryLoader<TDict> = () => Promise<TDict | {
    default: TDict;
}>;
/**
 * What a non-default language block is checked against: a loader when one was
 * given, the dictionary otherwise. Checking against the matching side alone,
 * rather than the union, is what lets a compile error name the missing key.
 */
type LanguageBlockFor<TBlocks, L, TDict> = L extends keyof TBlocks ? TBlocks[L] extends (...args: never[]) => unknown ? LambderI18nDictionaryLoader<TDict> : TDict : TDict;
export interface LambderI18nConfig<TLanguages extends Record<string, LambderLanguageMeta>, TDefault extends keyof TLanguages & string, TEnforced extends readonly (keyof TLanguages & string)[], TBase extends Record<TDefault, Record<string, LambderI18nDictionaryEntry>>> {
    /** Master registry of every supported language and its metadata. */
    languages: TLanguages;
    /** Final fallback language. Must be included in `enforced`. */
    defaultLanguage: TDefault;
    /**
     * Languages every dictionary must always provide. `extendPartial` requires
     * only these; all other languages become optional and fall back.
     */
    enforced: TEnforced;
    /**
     * App-wide base dictionary. Strict: every language in `languages` must
     * provide every key (the `defaultLanguage` block is the typed contract).
     * A key's entry is a text, or a plural entry where the text varies with
     * a count. Any language but the default may be a loader instead
     * (`tr: () => import("./tr")`), fetched by `loadLanguage`. The default
     * block stays inline, because every lookup falls back to it.
     */
    base: TBase & {
        [L in keyof TLanguages]: L extends TDefault ? Record<keyof TBase[TDefault], LambderI18nDictionaryEntry> : LanguageBlockFor<TBase, L, TranslationBlock<TBase[TDefault]>>;
    };
    /**
     * Optional language detector, tried before browser detection. Return a
     * supported code, in any case, to pick it (it is matched as language tags
     * are, case-insensitively), or anything else to continue the chain:
     * setLanguage override → detectLanguage → browser languages → defaultLanguage.
     */
    detectLanguage?: (helpers: {
        isLanguageCode: (value: string) => value is keyof TLanguages & string;
        languages: TLanguages;
        defaultLanguage: TDefault;
    }) => string | null | undefined;
}
export interface LambderI18nInstance<TLanguages extends Record<string, LambderLanguageMeta>, TDefault extends keyof TLanguages & string, TEnforced extends readonly (keyof TLanguages & string)[], TContract extends Record<string, LambderI18nDictionaryEntry>> {
    /** Translate using the automatically resolved active language. */
    t: LambderI18nTranslator<TContract>;
    /** Translator bound to an explicit language (per-request backend use). */
    forLanguage(code: keyof TLanguages & string): LambderI18nTranslator<TContract>;
    /**
     * Strict extension: every language must provide every new key. Keys must
     * be new: redeclaring a parent key is a compile-time and runtime error.
     * Any language but the default may be a loader, as in `base`.
     * Returns a new instance whose key space = parent keys + new keys.
     */
    extend<const TExt extends {
        [D in TDefault]: Record<string, LambderI18nDictionaryEntry>;
    }>(dict: {
        [L in keyof TLanguages]: L extends TDefault ? Record<keyof TExt[TDefault], LambderI18nDictionaryEntry> : LanguageBlockFor<TExt, L, TranslationBlock<TExt[TDefault]>>;
    } & {
        [D in TDefault]: Partial<Record<keyof TContract, never>>;
    } & TExt): LambderI18nInstance<TLanguages, TDefault, TEnforced, TContract & TExt[TDefault]>;
    /**
     * Partial extension: only the `enforced` languages are required; all other
     * languages are optional (and may provide a subset of keys), and missing
     * translations fall back to the default language. Keys must be new:
     * redeclaring a parent key is a compile-time and runtime error.
     * Any language but the default may be a loader, as in `base`.
     */
    extendPartial<const TExt extends {
        [D in TDefault]: Record<string, LambderI18nDictionaryEntry>;
    }>(dict: {
        [E in TEnforced[number]]: E extends TDefault ? Record<keyof TExt[TDefault], LambderI18nDictionaryEntry> : LanguageBlockFor<TExt, E, TranslationBlock<TExt[TDefault]>>;
    } & {
        [L in Exclude<keyof TLanguages & string, TEnforced[number]>]?: LanguageBlockFor<TExt, L, Partial<TranslationBlock<TExt[TDefault]>>>;
    } & {
        [D in TDefault]: Partial<Record<keyof TContract, never>>;
    } & TExt): LambderI18nInstance<TLanguages, TDefault, TEnforced, TContract & TExt[TDefault]>;
    /**
     * Run the loaders a language has in this instance and every instance
     * sharing its root, resolving once their dictionaries are merged.
     * Defaults to the active language. Until then `t` falls back per key to
     * the default language, so await it before the first render, and before
     * `setLanguage` to switch without a flash of the default language.
     * Change listeners fire once per load, however many calls share it. A
     * loader that answered never runs again; one that rejected rejects this
     * call and is retried on the next. Creating an extension loads nothing:
     * one created after its language was loaded needs its own
     * `loadLanguage()`, which runs only what is still missing.
     */
    loadLanguage(code?: keyof TLanguages & string): Promise<void>;
    /**
     * Merge additional translations at runtime (e.g. fetched from an API),
     * checked as inline blocks are. Notifies change listeners.
     */
    registerDictionary(code: keyof TLanguages & string, dict: Record<string, LambderI18nDictionaryEntry>): void;
    /**
     * Whether every plural entry this instance translates with (its own and
     * its parents', in every language) holds a form for each category the
     * language's plural rules use, by this runtime's Intl plural data. Loads
     * every language first, as `loadLanguage` does for each, so entries behind
     * loaders are checked too. Resolves when nothing is missing; rejects with
     * every gap listed by key, language and missing categories, or with the
     * failure of a loader that would not load.
     *
     * For a test or a build step, not for app start: runtimes ship different
     * plural data, and `t` falls back to an entry's `other` form for a
     * category it lacks, so a gap shows the other form rather than failing.
     * An extension sees its parents but not its siblings, so check each leaf
     * extension.
     */
    checkPluralCoverage(): Promise<void>;
    /**
     * Override the active language (shared with all extended instances), and
     * start its loaders; change listeners fire again when they land. Await
     * `loadLanguage(code)` first to switch without a flash of the default
     * language.
     */
    setLanguage(code: keyof TLanguages & string): void;
    /** Clear the override and re-run detection. */
    resetLanguage(): void;
    /** The currently active language code. */
    readonly currentLanguage: keyof TLanguages & string;
    /** Metadata of the currently active language, with `code` injected. */
    readonly currentLanguageMeta: TLanguages[keyof TLanguages] & {
        code: keyof TLanguages & string;
    };
    /** Text direction of the active language (defaults to "ltr"). */
    readonly currentDir: "ltr" | "rtl";
    /** BCP-47 locale of the active language for Intl APIs (defaults to the code). */
    readonly currentIntlLocale: string;
    /**
     * Subscribe to changes (language switched, or runtime dictionaries
     * registered). Returns an unsubscribe function.
     */
    onLanguageChange(listener: (code: keyof TLanguages & string) => void): () => void;
    /**
     * Apply the active language to `<html lang>` and `<html dir>` (RTL support).
     * No-op outside a browser. Re-apply on changes with
     * `i18n.onLanguageChange(() => i18n.applyToDocument())`.
     */
    applyToDocument(): void;
    /**
     * Type guard: is this string a supported language code, spelled exactly
     * as registered? The methods that take a code match it in any case, as
     * language tags are compared, and answer it as registered.
     */
    isLanguageCode(value: string): value is keyof TLanguages & string;
    readonly languages: TLanguages;
    readonly languageList: (keyof TLanguages & string)[];
    /** Ordered language metadata (declaration order), with `code` injected, ready for switcher menus. */
    readonly languageMetaList: (TLanguages[keyof TLanguages] & {
        code: keyof TLanguages & string;
    })[];
    readonly defaultLanguage: TDefault;
    readonly enforced: TEnforced;
}
/**
 * What reading translations takes, over any instance of one contract: `t`,
 * `forLanguage`, the active language and its metadata, change notifications
 * and the registry, without the members that change what an instance
 * answers (`setLanguage`, `resetLanguage`, `loadLanguage`,
 * `registerDictionary`, `applyToDocument`, and `checkPluralCoverage`, which
 * loads every language) or build new ones (`extend`,
 * `extendPartial`). Instances of one contract over different language sets
 * are different types, and every one of them is assignable to this, so code
 * that only reads translations takes this rather than one instance's type:
 * `LambderI18nReadonlyInstance<typeof en>` for the contract of an `en` block.
 * Language codes read as plain strings here, the language set being what it
 * leaves open.
 */
export type LambderI18nReadonlyInstance<TContract extends Record<string, LambderI18nDictionaryEntry>> = Pick<LambderI18nInstance<Record<string, LambderLanguageMeta>, string, readonly string[], TContract>, "t" | "forLanguage" | "currentLanguage" | "currentLanguageMeta" | "currentDir" | "currentIntlLocale" | "onLanguageChange" | "isLanguageCode" | "languages" | "languageList" | "languageMetaList" | "defaultLanguage" | "enforced">;
/** Language codes of an instance: `LambderI18nCodes<typeof i18n>`. */
export type LambderI18nCodes<T extends {
    languageList: readonly string[];
}> = T["languageList"][number];
/** Translation keys of an instance: `LambderI18nKeys<typeof i18n>`. */
export type LambderI18nKeys<T extends {
    t: (...args: never[]) => string;
}> = Parameters<T["t"]>[0];
/** Translator type of an instance: `LambderI18nTranslatorFor<typeof i18n>`. */
export type LambderI18nTranslatorFor<T extends {
    t: unknown;
}> = T["t"];
export declare const createLambderI18n: <const TLanguages extends Record<string, LambderLanguageMeta>, const TDefault extends keyof TLanguages & string, const TEnforced extends readonly (keyof TLanguages & string)[], const TBase extends Record<TDefault, Record<string, LambderI18nDictionaryEntry>>>(config: LambderI18nConfig<TLanguages, TDefault, TEnforced, TBase>) => LambderI18nInstance<TLanguages, TDefault, TEnforced, TBase[TDefault]>;
export {};
