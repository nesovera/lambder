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
export type LambderI18nExtractParams<S extends string> =
    S extends `${string}{${infer P}}${infer Rest}` ? P | LambderI18nExtractParams<Rest> : never;

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
export type LambderI18nTranslator<TContract extends Record<string, LambderI18nDictionaryEntry>> = <
    K extends keyof TContract & string
>(
    ...args: [TContract[K]] extends [string]
        ? LambderI18nExtractParams<TContract[K] & string> extends never
            ? [key: K]
            : [key: K, params: Record<LambderI18nExtractParams<TContract[K] & string>, string | number>]
        : [key: K, params: { count: number } & Record<Exclude<PluralEntryParams<TContract[K]>, "count">, string | number>]
) => string;

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
    [K in keyof TContract]: TContract[K] extends string ? string : LambderI18nDictionaryEntry
};

/** A per-language dictionary set: `{ en: { key: "value" }, tr: {...} }`. */
type DictSet = Record<string, Record<string, LambderI18nDictionaryEntry> | undefined>;

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
    TBase extends Record<TDefault, Record<string, LambderI18nDictionaryEntry>>,
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
     * A key's entry is a text, or a plural entry where the text varies with
     * a count. Any language but the default may be a loader instead
     * (`tr: () => import("./tr")`), fetched by `loadLanguage`. The default
     * block stays inline, because every lookup falls back to it.
     */
    base: TBase & {
        [L in keyof TLanguages]: L extends TDefault
            ? Record<keyof TBase[TDefault], LambderI18nDictionaryEntry>
            : LanguageBlockFor<TBase, L, TranslationBlock<TBase[TDefault]>>
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

export interface LambderI18nInstance<
    TLanguages extends Record<string, LambderLanguageMeta>,
    TDefault extends keyof TLanguages & string,
    TEnforced extends readonly (keyof TLanguages & string)[],
    TContract extends Record<string, LambderI18nDictionaryEntry>,
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
    extend<const TExt extends { [D in TDefault]: Record<string, LambderI18nDictionaryEntry> }>(
        dict: {
            [L in keyof TLanguages]: L extends TDefault
                ? Record<keyof TExt[TDefault], LambderI18nDictionaryEntry>
                : LanguageBlockFor<TExt, L, TranslationBlock<TExt[TDefault]>>
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
    extendPartial<const TExt extends { [D in TDefault]: Record<string, LambderI18nDictionaryEntry> }>(
        dict: {
            [E in TEnforced[number]]: E extends TDefault
                ? Record<keyof TExt[TDefault], LambderI18nDictionaryEntry>
                : LanguageBlockFor<TExt, E, TranslationBlock<TExt[TDefault]>>
        }
            & {
                [L in Exclude<keyof TLanguages & string, TEnforced[number]>]?:
                    LanguageBlockFor<TExt, L, Partial<TranslationBlock<TExt[TDefault]>>>
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

    /**
     * Type guard: is this string a supported language code, spelled exactly
     * as registered? The methods that take a code match it in any case, as
     * language tags are compared, and answer it as registered.
     */
    isLanguageCode(value: string): value is keyof TLanguages & string;
    readonly languages: TLanguages;
    readonly languageList: (keyof TLanguages & string)[];
    /** Ordered language metadata (declaration order), with `code` injected, ready for switcher menus. */
    readonly languageMetaList: (TLanguages[keyof TLanguages] & { code: keyof TLanguages & string })[];
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
export type LambderI18nReadonlyInstance<TContract extends Record<string, LambderI18nDictionaryEntry>> = Pick<
    LambderI18nInstance<Record<string, LambderLanguageMeta>, string, readonly string[], TContract>,
    | "t"
    | "forLanguage"
    | "currentLanguage"
    | "currentLanguageMeta"
    | "currentDir"
    | "currentIntlLocale"
    | "onLanguageChange"
    | "isLanguageCode"
    | "languages"
    | "languageList"
    | "languageMetaList"
    | "defaultLanguage"
    | "enforced"
>;

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
 * Browser detection: ordered prefs, full code then primary subtag, each
 * matched in any case and answered as registered. Only in a page, where there
 * is a document: Node 21 and later, Deno and Bun define `navigator.languages`
 * too, from the process locale, and a server's locale is not its reader's.
 */
const detectBrowserLanguage = (codeOf: (value: string) => string | null): string | null => {
    if (typeof document === "undefined" || typeof navigator === "undefined") return null;
    const prefs = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const pref of prefs ?? []) {
        const full = codeOf(pref ?? "");
        if (full) return full;
        const primary = codeOf((pref ?? "").split("-")[0] ?? "");
        if (primary) return primary;
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
        private readonly codeOf: (value: string) => string | null,
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
        const detected = typeof custom === "string" ? this.codeOf(custom) : null;
        if (detected) return detected;
        return detectBrowserLanguage(this.codeOf) ?? this.defaultLanguage;
    }

    /** Overrides the active language with a code as registered (registeredCodeOf). */
    set(code: string): void {
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
 * as it is: a display name "Eve {store}" stays that, rather than having its own
 * `{store}` filled by the next parameter. A token with no parameter stays.
 * Own properties only, through Object.prototype.hasOwnProperty rather than
 * Object.hasOwn: this runs in the browser bundle, and a browser without
 * ES2022 (Safari before 15.4) would throw on the first parameterised text.
 */
const interpolate = (text: string, params?: Record<string, string | number>): string => {
    if (!params) return text;
    return text.replace(/\{([^{}]+)\}/g, (token, name: string) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : token);
};

/** The `{name}` tokens a text carries, as interpolate reads them. */
const placeholdersOf = (text: string): Set<string> =>
    new Set([...text.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!));

/** A set of placeholders as a message shows it: `{count}, {name}`, or "none". */
const describePlaceholders = (placeholders: Set<string>): string =>
    placeholders.size ? [...placeholders].sort().map((name) => `{${name}}`).join(", ") : "none";

/** How many refused entries an error lists, per kind of refusal, before it only counts the rest. */
const REFUSED_ENTRY_LIST_LIMIT = 20;

/** The plural categories in CLDR's order, the order messages list them in. */
const PLURAL_CATEGORIES: readonly LambderI18nPluralCategory[] = ["zero", "one", "two", "few", "many", "other"];

/**
 * What is wrong with a dictionary value that is not a text, as the end of a
 * sentence about its key, or null for a well-formed plural entry: an object
 * of texts under plural categories. Which categories it must hold is its
 * language's, so that is checked apart.
 */
const pluralEntryProblem = (value: unknown): string | null => {
    if (!isObjectValue(value) || Array.isArray(value)) return "is neither a text nor a plural entry";
    for (const [category, form] of Object.entries(value)) {
        if (!(PLURAL_CATEGORIES as readonly string[]).includes(category)) {
            return `has "${category}", which is no plural category (${PLURAL_CATEGORIES.join(", ")})`;
        }
        if (typeof form !== "string") return `has a ${category} form that is not a text`;
    }
    if (value.other === undefined) return "has no other form, which every plural entry needs";
    return null;
};

/** A list of refused entries under its heading, as one section of an error. */
const refusalSection = (heading: string, lines: string[]): string => {
    const listed = lines.slice(0, REFUSED_ENTRY_LIST_LIMIT).map((line) => `  ${line}`);
    const more = lines.length > REFUSED_ENTRY_LIST_LIMIT ? [`  ... and ${lines.length - REFUSED_ENTRY_LIST_LIMIT} more`] : [];
    return [heading, ...listed, ...more].join("\n");
};

/**
 * Refuses the entries of one language's block that do not keep the default
 * language's contract, every such key listed in one error. Everything
 * refused here is refused alike by every runtime; which plural categories a
 * language uses is not (runtimes ship different plural data), so that is
 * left to checkPluralCoverage.
 *
 * Placeholders: the default language's text is the contract the
 * translator's type takes its parameters from, so a translation that drops
 * one loses the value a caller passed, and one that adds one shows its
 * `{token}` as it is. A plural entry's contract is the tokens across all
 * the default entry's forms, and every form in every language, the default
 * one's included, carries each of them, except `{count}`, which a form may
 * leave out to spell the number in words ("one item"). The default
 * language's plain texts are the contract itself and are not compared.
 *
 * Kinds: a plural entry where the default language has a text is refused,
 * since `t` takes no count for that key. A plain text where the default
 * language has a plural entry is taken as the other form alone.
 *
 * Intl locale: a language with a plural entry has its plural rules built
 * here, so an Intl locale that is no well-formed language tag, which every
 * runtime refuses, fails where the dictionary arrives rather than in `t`.
 *
 * `lookupDefault` answers the default language's entry for a key, the one
 * already held when the block is the default language's own registration.
 * A key it has none for is held to itself.
 */
const assertEntriesKept = (
    core: InternalCore,
    lookupDefault: (key: string) => LambderI18nDictionaryEntry | undefined,
    lang: string,
    dict: Record<string, unknown>,
    label: string,
): void => {
    const refused: string[] = [];
    const mismatches: string[] = [];
    for (const [key, entry] of Object.entries(dict)) {
        if (typeof entry !== "string") {
            const problem = pluralEntryProblem(entry);
            if (problem) {
                refused.push(`"${key}" ${problem}`);
                continue;
            }
        }
        const checked = entry as LambderI18nDictionaryEntry;
        const reference = lookupDefault(key) ?? checked;
        if (typeof reference === "string") {
            if (typeof checked !== "string") {
                refused.push(`"${key}" is a plural entry where the default language has a text, for which t takes no count: make the default language's entry plural`);
            } else if (lang !== core.defaultLanguage) {
                const expected = placeholdersOf(reference);
                const found = placeholdersOf(checked);
                if (expected.size !== found.size || ![...expected].every((name) => found.has(name))) {
                    mismatches.push(`"${key}" has ${describePlaceholders(found)} where the default language has ${describePlaceholders(expected)}`);
                }
            }
            continue;
        }
        const forms: LambderI18nPluralEntry = typeof checked === "string" ? { other: checked } : checked;
        core.pluralRulesOf(lang);
        const tokens = new Set(Object.values(reference).flatMap((form: string) => [...placeholdersOf(form)]));
        tokens.delete("count");
        for (const [category, form] of Object.entries(forms) as [LambderI18nPluralCategory, string][]) {
            const found = placeholdersOf(form);
            if ([...tokens].every((name) => found.has(name)) && [...found].every((name) => name === "count" || tokens.has(name))) continue;
            mismatches.push(`"${key}" (${category}) has ${describePlaceholders(found)} where every form needs ${describePlaceholders(tokens)} and may add {count}`);
        }
    }
    const sections: string[] = [];
    if (refused.length > 0) {
        sections.push(refusalSection(`LambderI18n: in ${label}, these "${lang}" entries are refused:`, refused));
    }
    if (mismatches.length > 0) {
        const texts = lang === core.defaultLanguage ? "plural forms" : "translations";
        sections.push(refusalSection(`LambderI18n: in ${label}, these "${lang}" ${texts} carry other placeholders than the default language's text:`, mismatches));
    }
    if (sections.length > 0) throw new Error(sections.join("\n"));
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
    /** Whether a string is a code exactly as registered: what the config's own keys are checked by. */
    isCode: (value: string) => boolean;
    /** A code given in any case, as registered, or null when no registered code matches it. */
    codeOf: (value: string) => string | null;
    /** Layers of this root and its extensions that still hold loaders. */
    lazyLayers: Set<DictLayer>;
    /** A language's plural rules, built on first use; throws for an Intl locale Intl refuses. */
    pluralRulesOf: (lang: string) => Intl.PluralRules;
    /** The plural categories a language's rules use, in CLDR's order, by this runtime's plural data. */
    pluralCategoriesOf: (lang: string) => LambderI18nPluralCategory[];
    /** The plural category a count falls in under a language's rules: "other" for anything that is no number. */
    pluralCategoryOf: (lang: string, count: unknown) => LambderI18nPluralCategory;
}

type DictLoader = () => Promise<unknown>;

/** Language blocks as configured: a dictionary, or a loader resolving to one. */
type DictSourceSet = Record<string, Record<string, LambderI18nDictionaryEntry> | DictLoader | undefined>;

/** Layered dictionary node: own translations + parent chain, walked child-first. */
interface DictLayer {
    dicts: DictSet;
    /** Loaders whose dictionaries are not merged yet, by language. */
    loaders: Map<string, DictLoader>;
    /** Loads under way, shared by concurrent loadLanguage calls. */
    inFlight: Map<string, Promise<void>>;
    parent: DictLayer | null;
}

const layerLookup = (layer: DictLayer | null, lang: string, key: string): LambderI18nDictionaryEntry | undefined => {
    for (let node = layer; node; node = node.parent) {
        const value = node.dicts[lang]?.[key];
        if (value !== undefined) return value;
    }
    return undefined;
};

const assertNoRedeclaredKeys = (parent: DictLayer, defaultLanguage: string, block: Record<string, unknown>, label: string): void => {
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

/**
 * A layer over its parent, from a dictionary set as configured. The inline
 * blocks are checked here (assertEntriesKept), against the default
 * language's entries the layer reaches, the default block first so that a
 * fault in the contract is reported as its own; a loader's block is checked
 * when it has run.
 */
const createLayer = (core: InternalCore, sources: DictSourceSet, parent: DictLayer | null, label: string): DictLayer => {
    const layer: DictLayer = { dicts: {}, loaders: new Map(), inFlight: new Map(), parent };
    for (const [lang, source] of Object.entries(sources)) {
        if (typeof source === "function") layer.loaders.set(lang, source);
        else if (source) layer.dicts[lang] = source;
    }
    const languages = [core.defaultLanguage, ...Object.keys(layer.dicts).filter((lang) => lang !== core.defaultLanguage)];
    for (const lang of languages) {
        const dict = layer.dicts[lang];
        if (dict) assertEntriesKept(core, (key) => layerLookup(layer, core.defaultLanguage, key), lang, dict, label);
    }
    if (layer.loaders.size > 0) core.lazyLayers.add(layer);
    return layer;
};

const isObjectValue = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;

/**
 * A loader resolves to the dictionary itself or to a module whose default
 * export is the dictionary. A `default` holding an object is a module's
 * export, unless the contract makes `default` a plural key and the object is
 * a plural entry: then it is the dictionary's own entry for that key, since
 * a module's dictionary would carry keys that are no plural category.
 */
const dictionaryFromLoaded = (
    loaded: unknown,
    lang: string,
    lookupDefault: (key: string) => LambderI18nDictionaryEntry | undefined,
): Record<string, unknown> => {
    const ownPluralDefault = isObjectValue(loaded)
        && isObjectValue(lookupDefault("default"))
        && pluralEntryProblem(loaded.default) === null;
    const dict = isObjectValue(loaded) && isObjectValue(loaded.default) && !ownPluralDefault ? loaded.default : loaded;
    if (!isObjectValue(dict)) {
        throw new Error(`LambderI18n: the "${lang}" loader resolved to neither a dictionary nor a module whose default export is one.`);
    }
    return dict;
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
            const lookupDefault = (key: string) => layerLookup(layer, core.defaultLanguage, key);
            const dict = dictionaryFromLoaded(loaded, lang, lookupDefault);
            if (layer.parent) assertNoRedeclaredKeys(layer.parent, core.defaultLanguage, dict, `the "${lang}" loader`);
            assertEntriesKept(core, lookupDefault, lang, dict, `the "${lang}" loader`);
            // Translations registered while the loader ran override what it brought.
            layer.dicts[lang] = { ...dict as Record<string, LambderI18nDictionaryEntry>, ...layer.dicts[lang] };
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
    registerDictionary(code: string, dict: Record<string, LambderI18nDictionaryEntry>): void;
    checkPluralCoverage(): Promise<void>;
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

/**
 * A code a caller passed, as registered: language tags are case-insensitive
 * (BCP 47), so `pt-br` names a registered `pt-BR`, and everything past this
 * point (the override, the dictionaries, the loaders) is keyed by the one
 * spelling the config used.
 */
const registeredCodeOf = (core: InternalCore, code: string): string => {
    const registered = core.codeOf(code);
    if (registered === null) throw new Error(`LambderI18n: unsupported language code "${code}".`);
    return registered;
};

const buildInstance = (core: InternalCore, layer: DictLayer): InternalInstance => {
    const translateIn = (lang: string, key: string, params?: Record<string, string | number>): string => {
        let textLanguage = lang;
        let entry = layerLookup(layer, lang, key);
        if (entry === undefined) {
            textLanguage = core.defaultLanguage;
            entry = layerLookup(layer, textLanguage, key);
        }
        if (entry === undefined) return key;
        // A form is picked under the rules of the language the text is in,
        // which is the default language's when the key fell back to it. A
        // category the entry lacks falls back to other, silently: this
        // runtime's plural data may list a category the dictionary was not
        // written for, which is no fault a visitor's page can act on, and a
        // warning would reach every visitor's console from the render path.
        // checkPluralCoverage is where such gaps are reported.
        const text = typeof entry === "string" ? entry : entry[core.pluralCategoryOf(textLanguage, params?.count)] ?? entry.other;
        return interpolate(text, params);
    };

    const t: InternalTranslator = (key, params) =>
        translateIn(core.state.resolve(), key, params);

    // forLanguage sits on the hot path of reactive T() bridges: cache per
    // code as registered, so every spelling of one hands back one translator.
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
            if (isObjectValue(block)) assertNoRedeclaredKeys(layer, core.defaultLanguage, block, label);
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
            const registered = registeredCodeOf(core, code);
            const cached = translatorCache.get(registered);
            if (cached) return cached;
            const translator: InternalTranslator = (key, params) => translateIn(registered, key, params);
            translatorCache.set(registered, translator);
            return translator;
        },
        extend(dict) {
            validateExtension(dict, core.languageList, "extend() dictionary");
            return buildInstance(core, createLayer(core, dict, layer, "extend() dictionary"));
        },
        extendPartial(dict) {
            validateExtension(dict, core.enforced, "extendPartial() dictionary");
            return buildInstance(core, createLayer(core, dict, layer, "extendPartial() dictionary"));
        },
        loadLanguage(code) {
            let lang: string;
            try {
                lang = registeredCodeOf(core, code ?? core.state.resolve());
            } catch (err) {
                return Promise.reject(err);
            }
            return loadLanguageAcrossRoot(core, lang);
        },
        registerDictionary(code, dict) {
            const lang = registeredCodeOf(core, code);
            assertEntriesKept(core, (key) => layerLookup(layer, core.defaultLanguage, key), lang, dict, `registerDictionary("${lang}")`);
            layer.dicts[lang] = { ...layer.dicts[lang], ...dict };
            core.state.emitChange();
        },
        async checkPluralCoverage() {
            await Promise.all(core.languageList.map((lang) => loadLanguageAcrossRoot(core, lang)));
            const gaps: string[] = [];
            for (const lang of core.languageList) {
                // Every key this instance answers in the language, each by
                // the entry t would use: the nearest layer's.
                const keys = new Set<string>();
                for (let node: DictLayer | null = layer; node; node = node.parent) {
                    for (const key of Object.keys(node.dicts[lang] ?? {})) keys.add(key);
                }
                for (const key of keys) {
                    const entry = layerLookup(layer, lang, key)!;
                    const reference = layerLookup(layer, core.defaultLanguage, key) ?? entry;
                    if (typeof reference === "string") continue;
                    const forms: LambderI18nPluralEntry = typeof entry === "string" ? { other: entry } : entry;
                    const used = core.pluralCategoriesOf(lang);
                    const missing = used.filter((category) => forms[category] === undefined);
                    if (missing.length === 0) continue;
                    const text = typeof entry === "string" ? "is a text, which stands for the other form alone, and " : "";
                    gaps.push(`  "${key}" in "${lang}" ${text}lacks ${missing.join(", ")}: "${lang}" uses ${used.join(", ")}`);
                }
            }
            if (gaps.length > 0) {
                throw new Error([
                    "LambderI18n: these plural entries lack forms for categories their language's plural rules use, by this runtime's Intl plural data; t shows their other form for those counts:",
                    ...gaps,
                ].join("\n"));
            }
        },
        setLanguage(code) {
            const lang = registeredCodeOf(core, code);
            core.state.set(lang);
            loadSwitchedLanguage(lang);
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
    const TBase extends Record<TDefault, Record<string, LambderI18nDictionaryEntry>>,
>(
    config: LambderI18nConfig<TLanguages, TDefault, TEnforced, TBase>
): LambderI18nInstance<TLanguages, TDefault, TEnforced, TBase[TDefault]> => {
    const languageList = Object.keys(config.languages);
    const isCode = (value: string): boolean =>
        Object.prototype.hasOwnProperty.call(config.languages, value);
    // Language tags are case-insensitive (BCP 47): a browser's `pt-br` and a
    // path's `PT-BR` both name a registered `pt-BR`. So two registered codes
    // that differ only in case would be one language twice.
    const codeByLowerCase = new Map<string, string>();
    for (const code of languageList) {
        const clash = codeByLowerCase.get(code.toLowerCase());
        if (clash !== undefined) {
            throw new Error(`LambderI18n: languages registers "${clash}" and "${code}", one language tag in two spellings: tags are compared case-insensitively.`);
        }
        codeByLowerCase.set(code.toLowerCase(), code);
    }
    const codeOf = (value: string): string | null =>
        typeof value === "string" ? codeByLowerCase.get(value.toLowerCase()) ?? null : null;

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

    // Built for a language the first time one of its plural entries arrives,
    // and kept: t picks a form on every call, and building the rules costs
    // far more than the pick. Never for a language without plural entries,
    // so its code need not be a tag Intl accepts.
    const pluralRules = new Map<string, Intl.PluralRules>();
    const pluralRulesOf = (lang: string): Intl.PluralRules => {
        let rules = pluralRules.get(lang);
        if (!rules) {
            const locale = metaByCode.get(lang)?.intlLocale ?? lang;
            try {
                rules = new Intl.PluralRules(locale);
            } catch (err) {
                throw new Error(`LambderI18n: "${lang}" has plural entries, and Intl.PluralRules refuses its Intl locale "${locale}" (${(err as Error).message}): give the language an intlLocale it accepts.`);
            }
            pluralRules.set(lang, rules);
        }
        return rules;
    };

    const core: InternalCore = {
        languages: config.languages,
        languageList,
        metaByCode,
        metaList: [...metaByCode.values()],
        defaultLanguage: config.defaultLanguage,
        enforced: config.enforced,
        state: new LanguageState(codeOf, config.defaultLanguage, customDetect),
        isCode,
        codeOf,
        lazyLayers: new Set(),
        pluralRulesOf,
        pluralCategoriesOf: (lang) => {
            const used = pluralRulesOf(lang).resolvedOptions().pluralCategories;
            return PLURAL_CATEGORIES.filter((category) => used.includes(category));
        },
        pluralCategoryOf: (lang, count) => pluralRulesOf(lang).select(Number(count)),
    };

    return buildInstance(core, createLayer(core, config.base as DictSourceSet, null, "base dictionary")) as unknown as
        LambderI18nInstance<TLanguages, TDefault, TEnforced, TBase[TDefault]>;
};
