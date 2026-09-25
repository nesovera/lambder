/**
 * LambderI18n: standalone, framework-free, isomorphic typed translation module.
 *
 * Zero dependencies, no Node/DOM requirements (browser detection is feature-gated),
 * safe to import in both lambda backends and frontend bundles.
 *
 * See docs/i18n.md for the full guide.
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
 * Typed translator: `t(key)`, and when the key's contract value contains
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

/**
 * A language block fetched on demand instead of bundled: a function that
 * resolves to the dictionary, or to a module whose default export is the
 * dictionary, so `() => import("./tr")` is a loader. It runs when
 * `loadLanguage` asks for its language, never before.
 */
export type LambderI18nDictionaryLoader<TDict> = () => Promise<TDict | { default: TDict }>;

/**
 * What a non-default language block is checked against: a loader when one was
 * given, the dictionary otherwise. Checking against the matching side alone,
 * rather than the union, is what lets a compile error name the missing key.
 */
type LanguageBlockFor<TBlocks, L, TDict> = L extends keyof TBlocks
    ? TBlocks[L] extends (...args: never[]) => unknown ? LambderI18nDictionaryLoader<TDict> : TDict
    : TDict;

export interface LambderI18nConfig<
    TLanguages extends Record<string, LambderLanguageMeta>,
    TDefault extends keyof TLanguages & string,
    TEnforced extends readonly (keyof TLanguages & string)[],
    TBase extends Record<TDefault, Record<string, string>>,
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
     * Any language but the default may be a loader instead
     * (`tr: () => import("./tr")`), fetched by `loadLanguage`. The default
     * block stays inline, because every lookup falls back to it.
     */
    base: TBase & {
        [L in keyof TLanguages]: L extends TDefault
            ? Record<keyof TBase[TDefault], string>
            : LanguageBlockFor<TBase, L, Record<keyof TBase[TDefault], string>>
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
     * Strict extension: every language must provide every new key. Keys must
     * be new: redeclaring a parent key is a compile-time and runtime error.
     * Any language but the default may be a loader, as in `base`.
     * Returns a new instance whose key space = parent keys + new keys.
     */
    extend<const TExt extends { [D in TDefault]: Record<string, string> }>(
        dict: {
            [L in keyof TLanguages]: L extends TDefault
                ? Record<keyof TExt[TDefault], string>
                : LanguageBlockFor<TExt, L, Record<keyof TExt[TDefault], string>>
        }
            & { [D in TDefault]: Partial<Record<keyof TContract, never>> }
            & TExt
    ): LambderI18nInstance<TLanguages, TDefault, TEnforced, TContract & TExt[TDefault]>;
    /**
     * Partial extension: only the `enforced` languages are required; all other
     * languages are optional (and may provide a subset of keys), and missing
     * translations fall back to the default language. Keys must be new:
     * redeclaring a parent key is a compile-time and runtime error.
     * Any language but the default may be a loader, as in `base`.
     */
    extendPartial<const TExt extends { [D in TDefault]: Record<string, string> }>(
        dict: {
            [E in TEnforced[number]]: E extends TDefault
                ? Record<keyof TExt[TDefault], string>
                : LanguageBlockFor<TExt, E, Record<keyof TExt[TDefault], string>>
        }
            & {
                [L in Exclude<keyof TLanguages & string, TEnforced[number]>]?:
                    LanguageBlockFor<TExt, L, Partial<Record<keyof TExt[TDefault], string>>>
            }
            & { [D in TDefault]: Partial<Record<keyof TContract, never>> }
            & TExt
    ): LambderI18nInstance<TLanguages, TDefault, TEnforced, TContract & TExt[TDefault]>;
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
    /** Merge additional translations at runtime (e.g. fetched from an API). Notifies change listeners. */
    registerDictionary(code: keyof TLanguages & string, dict: Record<string, string>): void;

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
    readonly currentLanguageMeta: TLanguages[keyof TLanguages] & { code: keyof TLanguages & string };
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

    /** Type guard: is this string a supported language code? */
    isLanguageCode(value: string): value is keyof TLanguages & string;
    readonly languages: TLanguages;
    readonly languageList: (keyof TLanguages & string)[];
    /** Ordered language metadata (declaration order), with `code` injected, ready for switcher menus. */
    readonly languageMetaList: (TLanguages[keyof TLanguages] & { code: keyof TLanguages & string })[];
    readonly defaultLanguage: TDefault;
    readonly enforced: TEnforced;
}

// ---------------------------------------------------------------------------
// Instance-derived utility types
// ---------------------------------------------------------------------------

/** Language codes of an instance: `LambderI18nCodes<typeof i18n>`. */
export type LambderI18nCodes<T extends { languageList: readonly string[] }> =
    T["languageList"][number];

/** Translation keys of an instance: `LambderI18nKeys<typeof i18n>`. */
export type LambderI18nKeys<T extends { t: (...args: never[]) => string }> =
    Parameters<T["t"]>[0];

/** Translator type of an instance: `LambderI18nTranslatorFor<typeof i18n>`. */
export type LambderI18nTranslatorFor<T extends { t: unknown }> = T["t"];

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Browser detection: ordered prefs, full code then primary subtag. Only in a
 * page, where there is a document: Node 21 and later, Deno and Bun define
 * `navigator.languages` too, from the process locale, and a server's locale
 * is not its reader's.
 */
const detectBrowserLanguage = (isCode: (value: string) => boolean): string | null => {
    if (typeof document === "undefined" || typeof navigator === "undefined") return null;
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
    /** A throwing detector is reported once rather than on every t() call that runs it. */
    private detectorFailureReported = false;
    private listeners = new Set<(code: string) => void>();

    constructor(
        private readonly isCode: (value: string) => boolean,
        private readonly defaultLanguage: string,
        private readonly customDetect: (() => string | null | undefined) | null,
    ) {}

    /**
     * The active language: the one set, else detected afresh on every read.
     * Detection is cheap, and what it reads lives outside this instance (the
     * path an SPA navigates, the browser's languages), so remembering its
     * first answer would keep a page on /en/ after it moved to /tr/.
     */
    resolve(): string {
        if (this.override) return this.override;
        // Fail-open: a broken app detector must not take down every t() call.
        let custom: string | null | undefined = null;
        try {
            custom = this.customDetect?.();
        } catch (err) {
            if (!this.detectorFailureReported) {
                this.detectorFailureReported = true;
                console.error("LambderI18n: detectLanguage threw; continuing detection chain.", err);
            }
        }
        if (custom && this.isCode(custom)) return custom;
        return detectBrowserLanguage(this.isCode) ?? this.defaultLanguage;
    }

    set(code: string): void {
        if (!this.isCode(code)) throw new Error(`LambderI18n: unsupported language code "${code}".`);
        if (this.override === code) return;
        this.override = code;
        this.notify(code);
    }

    reset(): void {
        this.override = null;
        this.notify(this.resolve());
    }

    /** Re-notify listeners without a language change (e.g. dictionaries changed). */
    emitChange(): void {
        this.notify(this.resolve());
    }

    subscribe(listener: (code: string) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private notify(code: string): void {
        for (const listener of this.listeners) {
            // Isolate listeners: one bad subscriber must not block the others.
            try {
                listener(code);
            } catch (err) {
                console.error("LambderI18n: onLanguageChange listener threw.", err);
            }
        }
    }
}

/**
 * Fills `{name}` tokens in one pass over the template, so a value is inserted
 * as it is: a display name "Eve {org}" stays that, rather than having its own
 * `{org}` filled by the next parameter. A token with no parameter stays.
 * Own properties only, through Object.prototype.hasOwnProperty rather than
 * Object.hasOwn: this runs in the browser bundle, and a browser without
 * ES2022 (Safari before 15.4) would throw on the first parameterised text.
 */
const interpolate = (text: string, params?: Record<string, string | number>): string => {
    if (!params) return text;
    return text.replace(/\{([^{}]+)\}/g, (token, name: string) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : token);
};

interface InternalCore {
    languages: Record<string, LambderLanguageMeta>;
    languageList: string[];
    /** Precomputed `{ code, ...meta }` objects, keyed by code (languages are immutable). */
    metaByCode: Map<string, LambderLanguageMeta & { code: string }>;
    metaList: (LambderLanguageMeta & { code: string })[];
    defaultLanguage: string;
    enforced: readonly string[];
    state: LanguageState;
    isCode: (value: string) => boolean;
    /** Layers of this root and its extensions that still hold loaders. */
    lazyLayers: Set<DictLayer>;
}

type DictLoader = () => Promise<unknown>;

/** Language blocks as configured: a dictionary, or a loader resolving to one. */
type DictSourceSet = Record<string, Record<string, string> | DictLoader | undefined>;

/** Layered dictionary node: own translations + parent chain, walked child-first. */
interface DictLayer {
    dicts: DictSet;
    /** Loaders whose dictionaries are not merged yet, by language. */
    loaders: Map<string, DictLoader>;
    /** Loads under way, shared by concurrent loadLanguage calls. */
    inFlight: Map<string, Promise<void>>;
    parent: DictLayer | null;
}

const layerLookup = (layer: DictLayer | null, lang: string, key: string): string | undefined => {
    for (let node = layer; node; node = node.parent) {
        const value = node.dicts[lang]?.[key];
        if (value !== undefined) return value;
    }
    return undefined;
};

const assertNoRedeclaredKeys = (parent: DictLayer, defaultLanguage: string, block: Record<string, string>, label: string): void => {
    for (const key of Object.keys(block)) {
        if (layerLookup(parent, defaultLanguage, key) !== undefined) {
            throw new Error(`LambderI18n: ${label} redeclares existing key "${key}".`);
        }
    }
};

/** The default block is what every lookup falls back to, so it cannot wait for a loader. */
const assertInlineDefaultBlock = (dict: DictSourceSet, defaultLanguage: string, label: string): void => {
    if (typeof dict[defaultLanguage] === "function") {
        throw new Error(`LambderI18n: ${label} must give the default language "${defaultLanguage}" inline, not as a loader.`);
    }
};

const createLayer = (core: InternalCore, sources: DictSourceSet, parent: DictLayer | null): DictLayer => {
    const layer: DictLayer = { dicts: {}, loaders: new Map(), inFlight: new Map(), parent };
    for (const [lang, source] of Object.entries(sources)) {
        if (typeof source === "function") layer.loaders.set(lang, source);
        else if (source) layer.dicts[lang] = source;
    }
    if (layer.loaders.size > 0) core.lazyLayers.add(layer);
    return layer;
};

const isObjectValue = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

/**
 * A loader resolves to the dictionary itself or to a module whose default
 * export is the dictionary. The two cannot be confused: a dictionary's values
 * are strings, so a `default` holding an object can only be a module's.
 */
const dictionaryFromLoaded = (loaded: unknown, lang: string): Record<string, string> => {
    const dict = isObjectValue(loaded) && isObjectValue(loaded.default) ? loaded.default : loaded;
    if (!isObjectValue(dict)) {
        throw new Error(`LambderI18n: the "${lang}" loader resolved to neither a dictionary nor a module whose default export is one.`);
    }
    return dict as Record<string, string>;
};

/** Run a layer's loader for a language and merge what it brings, registered as the layer's load under way. */
const startLayerLoad = (core: InternalCore, layer: DictLayer, lang: string, loader: DictLoader): Promise<void> => {
    const load = Promise.resolve()
        .then(loader)
        .then((loaded) => {
            // A loader that answered is spent even when its answer is refused,
            // since running it again would fail the same way. Only a loader
            // that rejected stays, to be retried.
            layer.loaders.delete(lang);
            if (layer.loaders.size === 0) core.lazyLayers.delete(layer);
            const dict = dictionaryFromLoaded(loaded, lang);
            if (layer.parent) assertNoRedeclaredKeys(layer.parent, core.defaultLanguage, dict, `the "${lang}" loader`);
            // Translations registered while the loader ran override what it brought.
            layer.dicts[lang] = { ...dict, ...layer.dicts[lang] };
        })
        .finally(() => { layer.inFlight.delete(lang); });
    layer.inFlight.set(lang, load);
    return load;
};

/**
 * loadLanguage for a whole root: every layer still holding a loader for the
 * language. Concurrent calls share each layer's load, and only the call that
 * started loads announces them, so one load is one change event.
 */
const loadLanguageAcrossRoot = async (core: InternalCore, lang: string): Promise<void> => {
    const started: Promise<void>[] = [];
    const joined: Promise<void>[] = [];
    for (const layer of core.lazyLayers) {
        const loader = layer.loaders.get(lang);
        if (!loader) continue;
        const running = layer.inFlight.get(lang);
        if (running) joined.push(running);
        else started.push(startLayerLoad(core, layer, lang, loader));
    }
    if (started.length === 0 && joined.length === 0) return;
    const [startedResults, joinedResults] = await Promise.all([Promise.allSettled(started), Promise.allSettled(joined)]);
    if (startedResults.some((result) => result.status === "fulfilled")) core.state.emitChange();
    const failure = [...startedResults, ...joinedResults]
        .find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
};

type InternalTranslator = (key: string, params?: Record<string, string | number>) => string;

/**
 * Untyped structural mirror of LambderI18nInstance so the implementation is
 * fully type-checked; createLambderI18n casts once at the facade boundary.
 */
interface InternalInstance {
    t: InternalTranslator;
    forLanguage(code: string): InternalTranslator;
    extend(dict: DictSourceSet): InternalInstance;
    extendPartial(dict: DictSourceSet): InternalInstance;
    loadLanguage(code?: string): Promise<void>;
    registerDictionary(code: string, dict: Record<string, string>): void;
    setLanguage(code: string): void;
    resetLanguage(): void;
    readonly currentLanguage: string;
    readonly currentLanguageMeta: LambderLanguageMeta & { code: string };
    readonly currentDir: "ltr" | "rtl";
    readonly currentIntlLocale: string;
    onLanguageChange(listener: (code: string) => void): () => void;
    applyToDocument(): void;
    isLanguageCode(value: string): boolean;
    readonly languages: Record<string, LambderLanguageMeta>;
    readonly languageList: string[];
    readonly languageMetaList: (LambderLanguageMeta & { code: string })[];
    readonly defaultLanguage: string;
    readonly enforced: readonly string[];
}

const buildInstance = (core: InternalCore, layer: DictLayer): InternalInstance => {
    const translateIn = (lang: string, key: string, params?: Record<string, string | number>): string => {
        const text = layerLookup(layer, lang, key)
            ?? layerLookup(layer, core.defaultLanguage, key)
            ?? key;
        return interpolate(text, params);
    };

    const t: InternalTranslator = (key, params) =>
        translateIn(core.state.resolve(), key, params);

    // forLanguage sits on the hot path of reactive T() bridges: cache per code.
    const translatorCache = new Map<string, InternalTranslator>();

    const validateExtension = (dict: DictSourceSet, requiredLanguages: readonly string[], label: string): void => {
        for (const lang of Object.keys(dict)) {
            if (!core.isCode(lang)) throw new Error(`LambderI18n: ${label} contains unsupported language "${lang}".`);
        }
        for (const lang of requiredLanguages) {
            if (!dict[lang]) throw new Error(`LambderI18n: ${label} is missing required language "${lang}".`);
        }
        assertInlineDefaultBlock(dict, core.defaultLanguage, label);
        // A loader's keys are checked the same way once it has run.
        for (const block of Object.values(dict)) {
            if (isObjectValue(block)) assertNoRedeclaredKeys(layer, core.defaultLanguage, block as Record<string, string>, label);
        }
    };

    // setLanguage and resetLanguage cannot hand a failure back, so it is logged
    // and the language keeps falling back to the default one.
    const loadSwitchedLanguage = (lang: string): void => {
        loadLanguageAcrossRoot(core, lang).catch((err) => {
            console.error(`LambderI18n: loading "${lang}" after switching to it failed; it falls back to the default language.`, err);
        });
    };

    const instance: InternalInstance = {
        t,
        forLanguage(code) {
            const cached = translatorCache.get(code);
            if (cached) return cached;
            if (!core.isCode(code)) throw new Error(`LambderI18n: unsupported language code "${code}".`);
            const translator: InternalTranslator = (key, params) => translateIn(code, key, params);
            translatorCache.set(code, translator);
            return translator;
        },
        extend(dict) {
            validateExtension(dict, core.languageList, "extend() dictionary");
            return buildInstance(core, createLayer(core, dict, layer));
        },
        extendPartial(dict) {
            validateExtension(dict, core.enforced, "extendPartial() dictionary");
            return buildInstance(core, createLayer(core, dict, layer));
        },
        loadLanguage(code) {
            const lang = code ?? core.state.resolve();
            if (!core.isCode(lang)) return Promise.reject(new Error(`LambderI18n: unsupported language code "${lang}".`));
            return loadLanguageAcrossRoot(core, lang);
        },
        registerDictionary(code, dict) {
            if (!core.isCode(code)) throw new Error(`LambderI18n: unsupported language code "${code}".`);
            layer.dicts[code] = { ...layer.dicts[code], ...dict };
            core.state.emitChange();
        },
        setLanguage(code) {
            core.state.set(code);
            loadSwitchedLanguage(code);
        },
        resetLanguage() {
            core.state.reset();
            loadSwitchedLanguage(core.state.resolve());
        },
        get currentLanguage() { return core.state.resolve(); },
        get currentLanguageMeta() { return core.metaByCode.get(core.state.resolve())!; },
        get currentDir() {
            return core.metaByCode.get(core.state.resolve())?.dir ?? "ltr";
        },
        get currentIntlLocale() {
            const code = core.state.resolve();
            return core.metaByCode.get(code)?.intlLocale ?? code;
        },
        onLanguageChange(listener) { return core.state.subscribe(listener); },
        applyToDocument() {
            const doc = (globalThis as { document?: { documentElement: { lang: string; dir: string } } }).document;
            if (!doc) return;
            const code = core.state.resolve();
            doc.documentElement.lang = code;
            doc.documentElement.dir = core.metaByCode.get(code)?.dir ?? "ltr";
        },
        isLanguageCode: core.isCode,
        languages: core.languages,
        languageList: core.languageList,
        languageMetaList: core.metaList,
        defaultLanguage: core.defaultLanguage,
        enforced: core.enforced,
    };
    return instance;
};

export const createLambderI18n = <
    const TLanguages extends Record<string, LambderLanguageMeta>,
    const TDefault extends keyof TLanguages & string,
    const TEnforced extends readonly (keyof TLanguages & string)[],
    const TBase extends Record<TDefault, Record<string, string>>,
>(
    config: LambderI18nConfig<TLanguages, TDefault, TEnforced, TBase>
): LambderI18nInstance<TLanguages, TDefault, TEnforced, TBase[TDefault]> => {
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
        if (!(config.base as DictSourceSet)[lang]) {
            throw new Error(`LambderI18n: base dictionary is missing language "${lang}".`);
        }
    }
    for (const lang of Object.keys(config.base)) {
        if (!isCode(lang)) {
            throw new Error(`LambderI18n: base dictionary contains unsupported language "${lang}".`);
        }
    }
    assertInlineDefaultBlock(config.base as DictSourceSet, config.defaultLanguage, "base dictionary");

    const customDetect = config.detectLanguage
        ? () => config.detectLanguage!({
            isLanguageCode: isCode as (value: string) => value is keyof TLanguages & string,
            languages: config.languages,
            defaultLanguage: config.defaultLanguage,
        })
        : null;

    const metaByCode = new Map(languageList.map((code) => [code, { code, ...config.languages[code]! }]));

    const core: InternalCore = {
        languages: config.languages,
        languageList,
        metaByCode,
        metaList: [...metaByCode.values()],
        defaultLanguage: config.defaultLanguage,
        enforced: config.enforced,
        state: new LanguageState(isCode, config.defaultLanguage, customDetect),
        isCode,
        lazyLayers: new Set(),
    };

    return buildInstance(core, createLayer(core, config.base as DictSourceSet, null)) as unknown as
        LambderI18nInstance<TLanguages, TDefault, TEnforced, TBase[TDefault]>;
};
