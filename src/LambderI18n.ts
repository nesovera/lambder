/**
 * LambderI18n — standalone, framework-free, isomorphic typed translation module.
 *
 * Zero dependencies, no Node/DOM requirements (browser detection is feature-gated),
 * safe to import in both lambda backends and frontend bundles.
 *
 * See docs/I18N.md for the full guide.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
export type LambderI18nExtractParams<S extends string> =
    S extends `${string}{${infer P}}${infer Rest}` ? P | LambderI18nExtractParams<Rest> : never;

/**
 * Typed translator: `t(key)` — and when the key's contract value contains
 * `{tokens}`, a params object with exactly those tokens is required.
 */
export type LambderI18nTranslator<TContract extends Record<string, string>> = <
    K extends keyof TContract & string
>(
    ...args: LambderI18nExtractParams<TContract[K]> extends never
        ? [key: K]
        : [key: K, params: Record<LambderI18nExtractParams<TContract[K]>, string | number>]
) => string;

/** A per-language dictionary set: `{ en: { key: "value" }, tr: {...} }`. */
type DictSet = Record<string, Record<string, string> | undefined>;

export interface LambderI18nConfig<
    TLanguages extends Record<string, LambderLanguageMeta>,
    TDefault extends keyof TLanguages & string,
    TEnforced extends readonly (keyof TLanguages & string)[],
    TContract extends Record<string, string>,
> {
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
    base: { [L in keyof TLanguages]: Record<keyof TContract, string> } & { [D in TDefault]: TContract };
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

export interface LambderI18nInstance<
    TLanguages extends Record<string, LambderLanguageMeta>,
    TDefault extends keyof TLanguages & string,
    TEnforced extends readonly (keyof TLanguages & string)[],
    TContract extends Record<string, string>,
> {
    /** Translate using the automatically resolved active language. */
    t: LambderI18nTranslator<TContract>;
    /** Translator bound to an explicit language (per-request backend use). */
    forLanguage(code: keyof TLanguages & string): LambderI18nTranslator<TContract>;
    /**
     * Strict extension: every language must provide every new key.
     * Returns a new instance whose key space = parent keys + new keys.
     */
    extend<const TExt extends { [D in TDefault]: Record<string, string> }>(
        dict: { [L in keyof TLanguages]: Record<keyof TExt[TDefault], string> } & TExt
    ): LambderI18nInstance<TLanguages, TDefault, TEnforced, TContract & TExt[TDefault]>;
    /**
     * Partial extension: only the `enforced` languages are required; all other
     * languages are optional (and may provide a subset of keys) — missing
     * translations fall back to the default language.
     */
    extendPartial<const TExt extends { [D in TDefault]: Record<string, string> }>(
        dict: { [E in TEnforced[number]]: Record<keyof TExt[TDefault], string> }
            & { [L in Exclude<keyof TLanguages & string, TEnforced[number]>]?: Partial<Record<keyof TExt[TDefault], string>> }
            & TExt
    ): LambderI18nInstance<TLanguages, TDefault, TEnforced, TContract & TExt[TDefault]>;
    /** Merge additional translations at runtime (e.g. fetched from an API). */
    registerDictionary(code: keyof TLanguages & string, dict: Record<string, string>): void;

    /** Override the active language (shared with all extended instances). */
    setLanguage(code: keyof TLanguages & string): void;
    /** Clear the override and re-run detection. */
    resetLanguage(): void;
    /** The currently active language code. */
    readonly currentLanguage: keyof TLanguages & string;
    /** Metadata of the currently active language, with `code` injected. */
    readonly currentLanguageMeta: TLanguages[keyof TLanguages] & { code: keyof TLanguages & string };
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
    readonly languageMetaList: (TLanguages[keyof TLanguages] & { code: keyof TLanguages & string })[];
    readonly defaultLanguage: TDefault;
    readonly enforced: TEnforced;
}

// ---------------------------------------------------------------------------
// Instance-derived utility types
// ---------------------------------------------------------------------------

/** Language codes of an instance: `LambderI18nCodes<typeof i18n>`. */
export type LambderI18nCodes<T> =
    T extends LambderI18nInstance<infer L, any, any, any> ? keyof L & string : never;

/** Translation keys of an instance: `LambderI18nKeys<typeof i18n>`. */
export type LambderI18nKeys<T> =
    T extends LambderI18nInstance<any, any, any, infer C> ? keyof C & string : never;

/** Translator type of an instance: `LambderI18nTranslatorFor<typeof i18n>`. */
export type LambderI18nTranslatorFor<T> =
    T extends LambderI18nInstance<any, any, any, infer C> ? LambderI18nTranslator<C> : never;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Islamery-style browser detection: ordered prefs, full code then primary subtag. */
const detectBrowserLanguage = (isCode: (value: string) => boolean): string | null => {
    if (typeof navigator === "undefined") return null;
    const prefs = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const pref of prefs ?? []) {
        const lower = (pref ?? "").toLowerCase();
        if (isCode(lower)) return lower;
        const primary = lower.split("-")[0] ?? "";
        if (isCode(primary)) return primary;
    }
    return null;
};

/** Mutable active-language state, shared between an instance and all its extensions. */
class LanguageState {
    private override: string | null = null;
    private detected: string | null = null;
    private listeners = new Set<(code: string) => void>();

    constructor(
        private readonly isCode: (value: string) => boolean,
        private readonly defaultLanguage: string,
        private readonly customDetect: (() => string | null | undefined) | null,
    ) {}

    resolve(): string {
        if (this.override) return this.override;
        if (this.detected) return this.detected;
        const custom = this.customDetect?.();
        if (custom && this.isCode(custom)) { this.detected = custom; return custom; }
        const browser = detectBrowserLanguage(this.isCode);
        this.detected = browser ?? this.defaultLanguage;
        return this.detected;
    }

    set(code: string): void {
        if (!this.isCode(code)) throw new Error(`LambderI18n: unsupported language code "${code}".`);
        if (this.override === code) return;
        this.override = code;
        this.notify(code);
    }

    reset(): void {
        this.override = null;
        this.detected = null;
        this.notify(this.resolve());
    }

    subscribe(listener: (code: string) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private notify(code: string): void {
        for (const listener of this.listeners) listener(code);
    }
}

const interpolate = (text: string, params?: Record<string, string | number>): string => {
    if (!params) return text;
    let out = text;
    for (const [token, value] of Object.entries(params)) {
        out = out.split(`{${token}}`).join(String(value));
    }
    return out;
};

interface InternalCore {
    languages: Record<string, LambderLanguageMeta>;
    languageList: string[];
    defaultLanguage: string;
    enforced: readonly string[];
    state: LanguageState;
    isCode: (value: string) => boolean;
}

/** Layered dictionary node: own translations + parent chain, walked child-first. */
interface DictLayer {
    dicts: DictSet;
    parent: DictLayer | null;
}

const layerLookup = (layer: DictLayer | null, lang: string, key: string): string | undefined => {
    for (let node = layer; node; node = node.parent) {
        const value = node.dicts[lang]?.[key];
        if (value !== undefined) return value;
    }
    return undefined;
};

const buildInstance = (core: InternalCore, layer: DictLayer): LambderI18nInstance<any, any, any, any> => {
    const translateIn = (lang: string, key: string, params?: Record<string, string | number>): string => {
        const text = layerLookup(layer, lang, key)
            ?? layerLookup(layer, core.defaultLanguage, key)
            ?? key;
        return interpolate(text, params);
    };

    const t = (key: string, params?: Record<string, string | number>) =>
        translateIn(core.state.resolve(), key, params);

    const validateExtension = (dict: DictSet, requiredLanguages: readonly string[], label: string): void => {
        for (const lang of Object.keys(dict)) {
            if (!core.isCode(lang)) throw new Error(`LambderI18n: ${label} contains unsupported language "${lang}".`);
        }
        for (const lang of requiredLanguages) {
            if (!dict[lang]) throw new Error(`LambderI18n: ${label} is missing required language "${lang}".`);
        }
    };

    const instance: LambderI18nInstance<any, any, any, any> = {
        t: t as LambderI18nTranslator<any>,
        forLanguage(code: string) {
            if (!core.isCode(code)) throw new Error(`LambderI18n: unsupported language code "${code}".`);
            return ((key: string, params?: Record<string, string | number>) =>
                translateIn(code, key, params)) as LambderI18nTranslator<any>;
        },
        extend(dict: DictSet) {
            validateExtension(dict, core.languageList, "extend() dictionary");
            return buildInstance(core, { dicts: dict, parent: layer });
        },
        extendPartial(dict: DictSet) {
            validateExtension(dict, core.enforced, "extendPartial() dictionary");
            return buildInstance(core, { dicts: dict, parent: layer });
        },
        registerDictionary(code: string, dict: Record<string, string>) {
            if (!core.isCode(code)) throw new Error(`LambderI18n: unsupported language code "${code}".`);
            layer.dicts[code] = { ...layer.dicts[code], ...dict };
        },
        setLanguage(code: string) { core.state.set(code); },
        resetLanguage() { core.state.reset(); },
        get currentLanguage() { return core.state.resolve(); },
        get currentLanguageMeta() {
            const code = core.state.resolve();
            return { code, ...core.languages[code] };
        },
        get currentDir() {
            return (core.languages[core.state.resolve()]?.dir as "ltr" | "rtl") ?? "ltr";
        },
        get currentIntlLocale() {
            const code = core.state.resolve();
            return (core.languages[code]?.intlLocale as string) ?? code;
        },
        onLanguageChange(listener: (code: string) => void) { return core.state.subscribe(listener); },
        applyToDocument() {
            const doc = (globalThis as { document?: { documentElement: { lang: string; dir: string } } }).document;
            if (!doc) return;
            const code = core.state.resolve();
            doc.documentElement.lang = code;
            doc.documentElement.dir = (core.languages[code]?.dir as string) ?? "ltr";
        },
        isLanguageCode: core.isCode as any,
        languages: core.languages,
        languageList: core.languageList,
        get languageMetaList() {
            return core.languageList.map((code) => ({ code, ...core.languages[code] }));
        },
        defaultLanguage: core.defaultLanguage,
        enforced: core.enforced,
    };
    return instance;
};

export const createLambderI18n = <
    const TLanguages extends Record<string, LambderLanguageMeta>,
    const TDefault extends keyof TLanguages & string,
    const TEnforced extends readonly (keyof TLanguages & string)[],
    const TContract extends Record<string, string>,
>(
    config: LambderI18nConfig<TLanguages, TDefault, TEnforced, TContract>
): LambderI18nInstance<TLanguages, TDefault, TEnforced, TContract> => {
    const languageList = Object.keys(config.languages);
    const isCode = (value: string): boolean =>
        Object.prototype.hasOwnProperty.call(config.languages, value);

    if (!isCode(config.defaultLanguage)) {
        throw new Error(`LambderI18n: defaultLanguage "${config.defaultLanguage}" is not in languages.`);
    }
    for (const lang of config.enforced) {
        if (!isCode(lang)) throw new Error(`LambderI18n: enforced language "${lang}" is not in languages.`);
    }
    if (!config.enforced.includes(config.defaultLanguage)) {
        throw new Error(`LambderI18n: defaultLanguage "${config.defaultLanguage}" must be listed in enforced.`);
    }
    for (const lang of languageList) {
        if (!(config.base as DictSet)[lang]) {
            throw new Error(`LambderI18n: base dictionary is missing language "${lang}".`);
        }
    }

    const customDetect = config.detectLanguage
        ? () => config.detectLanguage!({
            isLanguageCode: isCode as any,
            languages: config.languages,
            defaultLanguage: config.defaultLanguage,
        })
        : null;

    const core: InternalCore = {
        languages: config.languages,
        languageList,
        defaultLanguage: config.defaultLanguage,
        enforced: config.enforced,
        state: new LanguageState(isCode, config.defaultLanguage, customDetect),
        isCode,
    };

    return buildInstance(core, { dicts: { ...(config.base as DictSet) }, parent: null });
};
