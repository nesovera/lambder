/**
 * LambderI18n — standalone, framework-free, isomorphic typed translation module.
 *
 * Zero dependencies, no Node/DOM requirements (browser detection is feature-gated),
 * safe to import in both lambda backends and frontend bundles.
 *
 * See docs/I18N.md for the full guide.
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
/** Extracts `{param}` placeholder names from a string literal type. */
export type LambderI18nExtractParams<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | LambderI18nExtractParams<Rest> : never;
/**
 * Typed translator: `t(key)` — and when the key's contract value contains
 * `{tokens}`, a params object with exactly those tokens is required.
 */
export type LambderI18nTranslator<TContract extends Record<string, string>> = <K extends keyof TContract & string>(...args: LambderI18nExtractParams<TContract[K]> extends never ? [key: K] : [key: K, params: Record<LambderI18nExtractParams<TContract[K]>, string | number>]) => string;
export interface LambderI18nConfig<TLanguages extends Record<string, LambderLanguageMeta>, TDefault extends keyof TLanguages & string, TEnforced extends readonly (keyof TLanguages & string)[], TBase extends Record<TDefault, Record<string, string>>> {
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
     */
    base: TBase & {
        [L in keyof TLanguages]: Record<keyof TBase[TDefault], string>;
    };
    /**
     * Optional language detector, tried before browser detection. Return a
     * supported code to pick it, or null/undefined to continue the chain:
     * setLanguage override → detectLanguage → browser languages → defaultLanguage.
     */
    detectLanguage?: (helpers: {
        isLanguageCode: (value: string) => value is keyof TLanguages & string;
        languages: TLanguages;
        defaultLanguage: TDefault;
    }) => string | null | undefined;
}
export interface LambderI18nInstance<TLanguages extends Record<string, LambderLanguageMeta>, TDefault extends keyof TLanguages & string, TEnforced extends readonly (keyof TLanguages & string)[], TContract extends Record<string, string>> {
    /** Translate using the automatically resolved active language. */
    t: LambderI18nTranslator<TContract>;
    /** Translator bound to an explicit language (per-request backend use). */
    forLanguage(code: keyof TLanguages & string): LambderI18nTranslator<TContract>;
    /**
     * Strict extension: every language must provide every new key.
     * Returns a new instance whose key space = parent keys + new keys.
     */
    extend<const TExt extends {
        [D in TDefault]: Record<string, string>;
    }>(dict: {
        [L in keyof TLanguages]: Record<keyof TExt[TDefault], string>;
    } & TExt): LambderI18nInstance<TLanguages, TDefault, TEnforced, TContract & TExt[TDefault]>;
    /**
     * Partial extension: only the `enforced` languages are required; all other
     * languages are optional (and may provide a subset of keys) — missing
     * translations fall back to the default language.
     */
    extendPartial<const TExt extends {
        [D in TDefault]: Record<string, string>;
    }>(dict: {
        [E in TEnforced[number]]: Record<keyof TExt[TDefault], string>;
    } & {
        [L in Exclude<keyof TLanguages & string, TEnforced[number]>]?: Partial<Record<keyof TExt[TDefault], string>>;
    } & TExt): LambderI18nInstance<TLanguages, TDefault, TEnforced, TContract & TExt[TDefault]>;
    /** Merge additional translations at runtime (e.g. fetched from an API). */
    registerDictionary(code: keyof TLanguages & string, dict: Record<string, string>): void;
    /** Override the active language (shared with all extended instances). */
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
    /** Subscribe to language changes. Returns an unsubscribe function. */
    onLanguageChange(listener: (code: keyof TLanguages & string) => void): () => void;
    /**
     * Apply the active language to `<html lang>` and `<html dir>` (RTL support).
     * No-op outside a browser. Re-apply on changes with
     * `i18n.onLanguageChange(() => i18n.applyToDocument())`.
     */
    applyToDocument(): void;
    /** Type guard: is this string a supported language code? */
    isLanguageCode(value: string): value is keyof TLanguages & string;
    readonly languages: TLanguages;
    readonly languageList: (keyof TLanguages & string)[];
    /** Ordered language metadata (declaration order), with `code` injected — ready for switcher menus. */
    readonly languageMetaList: (TLanguages[keyof TLanguages] & {
        code: keyof TLanguages & string;
    })[];
    readonly defaultLanguage: TDefault;
    readonly enforced: TEnforced;
}
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
export declare const createLambderI18n: <const TLanguages extends Record<string, LambderLanguageMeta>, const TDefault extends keyof TLanguages & string, const TEnforced extends readonly (keyof TLanguages & string)[], const TBase extends Record<TDefault, Record<string, string>>>(config: LambderI18nConfig<TLanguages, TDefault, TEnforced, TBase>) => LambderI18nInstance<TLanguages, TDefault, TEnforced, TBase[TDefault]>;
