/**
 * LambderI18n: standalone, framework-free, isomorphic typed translation module.
 *
 * Zero dependencies, no Node/DOM requirements (browser detection is feature-gated),
 * safe to import in both lambda backends and frontend bundles.
 *
 * See docs/i18n.md for the full guide.
 */
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
/**
 * Browser detection: ordered prefs, full code then primary subtag, each
 * matched in any case and answered as registered. Only in a page, where there
 * is a document: Node 21 and later, Deno and Bun define `navigator.languages`
 * too, from the process locale, and a server's locale is not its reader's.
 */
const detectBrowserLanguage = (codeOf) => {
    if (typeof document === "undefined" || typeof navigator === "undefined")
        return null;
    const prefs = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const pref of prefs ?? []) {
        const full = codeOf(pref ?? "");
        if (full)
            return full;
        const primary = codeOf((pref ?? "").split("-")[0] ?? "");
        if (primary)
            return primary;
    }
    return null;
};
/** Mutable active-language state, shared between an instance and all its extensions. */
class LanguageState {
    codeOf;
    defaultLanguage;
    customDetect;
    override = null;
    /** A throwing detector is reported once rather than on every t() call that runs it. */
    detectorFailureReported = false;
    listeners = new Set();
    constructor(codeOf, defaultLanguage, customDetect) {
        this.codeOf = codeOf;
        this.defaultLanguage = defaultLanguage;
        this.customDetect = customDetect;
    }
    /**
     * The active language: the one set, else detected afresh on every read.
     * Detection is cheap, and what it reads lives outside this instance (the
     * path an SPA navigates, the browser's languages), so remembering its
     * first answer would keep a page on /en/ after it moved to /tr/.
     */
    resolve() {
        if (this.override)
            return this.override;
        // Fail-open: a broken app detector must not take down every t() call.
        let custom = null;
        try {
            custom = this.customDetect?.();
        }
        catch (err) {
            if (!this.detectorFailureReported) {
                this.detectorFailureReported = true;
                console.error("LambderI18n: detectLanguage threw; continuing detection chain.", err);
            }
        }
        const detected = typeof custom === "string" ? this.codeOf(custom) : null;
        if (detected)
            return detected;
        return detectBrowserLanguage(this.codeOf) ?? this.defaultLanguage;
    }
    /** Overrides the active language with a code as registered (registeredCodeOf). */
    set(code) {
        if (this.override === code)
            return;
        this.override = code;
        this.notify(code);
    }
    reset() {
        this.override = null;
        this.notify(this.resolve());
    }
    /** Re-notify listeners without a language change (e.g. dictionaries changed). */
    emitChange() {
        this.notify(this.resolve());
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    notify(code) {
        for (const listener of this.listeners) {
            // Isolate listeners: one bad subscriber must not block the others.
            try {
                listener(code);
            }
            catch (err) {
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
const interpolate = (text, params) => {
    if (!params)
        return text;
    return text.replace(/\{([^{}]+)\}/g, (token, name) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : token);
};
/** The `{name}` tokens a text carries, as interpolate reads them. */
const placeholdersOf = (text) => new Set([...text.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]));
/** A set of placeholders as a message shows it: `{count}, {name}`, or "none". */
const describePlaceholders = (placeholders) => placeholders.size ? [...placeholders].sort().map((name) => `{${name}}`).join(", ") : "none";
/** How many refused entries an error lists, per kind of refusal, before it only counts the rest. */
const REFUSED_ENTRY_LIST_LIMIT = 20;
/** The plural categories in CLDR's order, the order messages list them in. */
const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
/**
 * What is wrong with a dictionary value that is not a text, as the end of a
 * sentence about its key, or null for a well-formed plural entry: an object
 * of texts under plural categories. Which categories it must hold is its
 * language's, so that is checked apart.
 */
const pluralEntryProblem = (value) => {
    if (!isObjectValue(value) || Array.isArray(value))
        return "is neither a text nor a plural entry";
    for (const [category, form] of Object.entries(value)) {
        if (!PLURAL_CATEGORIES.includes(category)) {
            return `has "${category}", which is no plural category (${PLURAL_CATEGORIES.join(", ")})`;
        }
        if (typeof form !== "string")
            return `has a ${category} form that is not a text`;
    }
    if (value.other === undefined)
        return "has no other form, which every plural entry needs";
    return null;
};
/** A list of refused entries under its heading, as one section of an error. */
const refusalSection = (heading, lines) => {
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
const assertEntriesKept = (core, lookupDefault, lang, dict, label) => {
    const refused = [];
    const mismatches = [];
    for (const [key, entry] of Object.entries(dict)) {
        if (typeof entry !== "string") {
            const problem = pluralEntryProblem(entry);
            if (problem) {
                refused.push(`"${key}" ${problem}`);
                continue;
            }
        }
        const checked = entry;
        const reference = lookupDefault(key) ?? checked;
        if (typeof reference === "string") {
            if (typeof checked !== "string") {
                refused.push(`"${key}" is a plural entry where the default language has a text, for which t takes no count: make the default language's entry plural`);
            }
            else if (lang !== core.defaultLanguage) {
                const expected = placeholdersOf(reference);
                const found = placeholdersOf(checked);
                if (expected.size !== found.size || ![...expected].every((name) => found.has(name))) {
                    mismatches.push(`"${key}" has ${describePlaceholders(found)} where the default language has ${describePlaceholders(expected)}`);
                }
            }
            continue;
        }
        const forms = typeof checked === "string" ? { other: checked } : checked;
        core.pluralRulesOf(lang);
        const tokens = new Set(Object.values(reference).flatMap((form) => [...placeholdersOf(form)]));
        tokens.delete("count");
        for (const [category, form] of Object.entries(forms)) {
            const found = placeholdersOf(form);
            if ([...tokens].every((name) => found.has(name)) && [...found].every((name) => name === "count" || tokens.has(name)))
                continue;
            mismatches.push(`"${key}" (${category}) has ${describePlaceholders(found)} where every form needs ${describePlaceholders(tokens)} and may add {count}`);
        }
    }
    const sections = [];
    if (refused.length > 0) {
        sections.push(refusalSection(`LambderI18n: in ${label}, these "${lang}" entries are refused:`, refused));
    }
    if (mismatches.length > 0) {
        const texts = lang === core.defaultLanguage ? "plural forms" : "translations";
        sections.push(refusalSection(`LambderI18n: in ${label}, these "${lang}" ${texts} carry other placeholders than the default language's text:`, mismatches));
    }
    if (sections.length > 0)
        throw new Error(sections.join("\n"));
};
const layerLookup = (layer, lang, key) => {
    for (let node = layer; node; node = node.parent) {
        const value = node.dicts[lang]?.[key];
        if (value !== undefined)
            return value;
    }
    return undefined;
};
const assertNoRedeclaredKeys = (parent, defaultLanguage, block, label) => {
    for (const key of Object.keys(block)) {
        if (layerLookup(parent, defaultLanguage, key) !== undefined) {
            throw new Error(`LambderI18n: ${label} redeclares existing key "${key}".`);
        }
    }
};
/** The default block is what every lookup falls back to, so it cannot wait for a loader. */
const assertInlineDefaultBlock = (dict, defaultLanguage, label) => {
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
const createLayer = (core, sources, parent, label) => {
    const layer = { dicts: {}, loaders: new Map(), inFlight: new Map(), parent };
    for (const [lang, source] of Object.entries(sources)) {
        if (typeof source === "function")
            layer.loaders.set(lang, source);
        else if (source)
            layer.dicts[lang] = source;
    }
    const languages = [core.defaultLanguage, ...Object.keys(layer.dicts).filter((lang) => lang !== core.defaultLanguage)];
    for (const lang of languages) {
        const dict = layer.dicts[lang];
        if (dict)
            assertEntriesKept(core, (key) => layerLookup(layer, core.defaultLanguage, key), lang, dict, label);
    }
    if (layer.loaders.size > 0)
        core.lazyLayers.add(layer);
    return layer;
};
const isObjectValue = (value) => typeof value === "object" && value !== null;
/**
 * A loader resolves to the dictionary itself or to a module whose default
 * export is the dictionary. A `default` holding an object is a module's
 * export, unless the contract makes `default` a plural key and the object is
 * a plural entry: then it is the dictionary's own entry for that key, since
 * a module's dictionary would carry keys that are no plural category.
 */
const dictionaryFromLoaded = (loaded, lang, lookupDefault) => {
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
const startLayerLoad = (core, layer, lang, loader) => {
    const load = Promise.resolve()
        .then(loader)
        .then((loaded) => {
        // A loader that answered is spent even when its answer is refused,
        // since running it again would fail the same way. Only a loader
        // that rejected stays, to be retried.
        layer.loaders.delete(lang);
        if (layer.loaders.size === 0)
            core.lazyLayers.delete(layer);
        const lookupDefault = (key) => layerLookup(layer, core.defaultLanguage, key);
        const dict = dictionaryFromLoaded(loaded, lang, lookupDefault);
        if (layer.parent)
            assertNoRedeclaredKeys(layer.parent, core.defaultLanguage, dict, `the "${lang}" loader`);
        assertEntriesKept(core, lookupDefault, lang, dict, `the "${lang}" loader`);
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
const loadLanguageAcrossRoot = async (core, lang) => {
    const started = [];
    const joined = [];
    for (const layer of core.lazyLayers) {
        const loader = layer.loaders.get(lang);
        if (!loader)
            continue;
        const running = layer.inFlight.get(lang);
        if (running)
            joined.push(running);
        else
            started.push(startLayerLoad(core, layer, lang, loader));
    }
    if (started.length === 0 && joined.length === 0)
        return;
    const [startedResults, joinedResults] = await Promise.all([Promise.allSettled(started), Promise.allSettled(joined)]);
    if (startedResults.some((result) => result.status === "fulfilled"))
        core.state.emitChange();
    const failure = [...startedResults, ...joinedResults]
        .find((result) => result.status === "rejected");
    if (failure)
        throw failure.reason;
};
/**
 * A code a caller passed, as registered: language tags are case-insensitive
 * (BCP 47), so `pt-br` names a registered `pt-BR`, and everything past this
 * point (the override, the dictionaries, the loaders) is keyed by the one
 * spelling the config used.
 */
const registeredCodeOf = (core, code) => {
    const registered = core.codeOf(code);
    if (registered === null)
        throw new Error(`LambderI18n: unsupported language code "${code}".`);
    return registered;
};
const buildInstance = (core, layer) => {
    const translateIn = (lang, key, params) => {
        let textLanguage = lang;
        let entry = layerLookup(layer, lang, key);
        if (entry === undefined) {
            textLanguage = core.defaultLanguage;
            entry = layerLookup(layer, textLanguage, key);
        }
        if (entry === undefined)
            return key;
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
    const t = (key, params) => translateIn(core.state.resolve(), key, params);
    // forLanguage sits on the hot path of reactive T() bridges: cache per
    // code as registered, so every spelling of one hands back one translator.
    const translatorCache = new Map();
    const validateExtension = (dict, requiredLanguages, label) => {
        for (const lang of Object.keys(dict)) {
            if (!core.isCode(lang))
                throw new Error(`LambderI18n: ${label} contains unsupported language "${lang}".`);
        }
        for (const lang of requiredLanguages) {
            if (!dict[lang])
                throw new Error(`LambderI18n: ${label} is missing required language "${lang}".`);
        }
        assertInlineDefaultBlock(dict, core.defaultLanguage, label);
        // A loader's keys are checked the same way once it has run.
        for (const block of Object.values(dict)) {
            if (isObjectValue(block))
                assertNoRedeclaredKeys(layer, core.defaultLanguage, block, label);
        }
    };
    // setLanguage and resetLanguage cannot hand a failure back, so it is logged
    // and the language keeps falling back to the default one.
    const loadSwitchedLanguage = (lang) => {
        loadLanguageAcrossRoot(core, lang).catch((err) => {
            console.error(`LambderI18n: loading "${lang}" after switching to it failed; it falls back to the default language.`, err);
        });
    };
    const instance = {
        t,
        forLanguage(code) {
            const registered = registeredCodeOf(core, code);
            const cached = translatorCache.get(registered);
            if (cached)
                return cached;
            const translator = (key, params) => translateIn(registered, key, params);
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
            let lang;
            try {
                lang = registeredCodeOf(core, code ?? core.state.resolve());
            }
            catch (err) {
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
            const gaps = [];
            for (const lang of core.languageList) {
                // Every key this instance answers in the language, each by
                // the entry t would use: the nearest layer's.
                const keys = new Set();
                for (let node = layer; node; node = node.parent) {
                    for (const key of Object.keys(node.dicts[lang] ?? {}))
                        keys.add(key);
                }
                for (const key of keys) {
                    const entry = layerLookup(layer, lang, key);
                    const reference = layerLookup(layer, core.defaultLanguage, key) ?? entry;
                    if (typeof reference === "string")
                        continue;
                    const forms = typeof entry === "string" ? { other: entry } : entry;
                    const used = core.pluralCategoriesOf(lang);
                    const missing = used.filter((category) => forms[category] === undefined);
                    if (missing.length === 0)
                        continue;
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
        get currentLanguageMeta() { return core.metaByCode.get(core.state.resolve()); },
        get currentDir() {
            return core.metaByCode.get(core.state.resolve())?.dir ?? "ltr";
        },
        get currentIntlLocale() {
            const code = core.state.resolve();
            return core.metaByCode.get(code)?.intlLocale ?? code;
        },
        onLanguageChange(listener) { return core.state.subscribe(listener); },
        applyToDocument() {
            const doc = globalThis.document;
            if (!doc)
                return;
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
export const createLambderI18n = (config) => {
    const languageList = Object.keys(config.languages);
    const isCode = (value) => Object.prototype.hasOwnProperty.call(config.languages, value);
    // Language tags are case-insensitive (BCP 47): a browser's `pt-br` and a
    // path's `PT-BR` both name a registered `pt-BR`. So two registered codes
    // that differ only in case would be one language twice.
    const codeByLowerCase = new Map();
    for (const code of languageList) {
        const clash = codeByLowerCase.get(code.toLowerCase());
        if (clash !== undefined) {
            throw new Error(`LambderI18n: languages registers "${clash}" and "${code}", one language tag in two spellings: tags are compared case-insensitively.`);
        }
        codeByLowerCase.set(code.toLowerCase(), code);
    }
    const codeOf = (value) => typeof value === "string" ? codeByLowerCase.get(value.toLowerCase()) ?? null : null;
    if (!isCode(config.defaultLanguage)) {
        throw new Error(`LambderI18n: defaultLanguage "${config.defaultLanguage}" is not in languages.`);
    }
    for (const lang of config.enforced) {
        if (!isCode(lang))
            throw new Error(`LambderI18n: enforced language "${lang}" is not in languages.`);
    }
    if (!config.enforced.includes(config.defaultLanguage)) {
        throw new Error(`LambderI18n: defaultLanguage "${config.defaultLanguage}" must be listed in enforced.`);
    }
    for (const lang of languageList) {
        if (!config.base[lang]) {
            throw new Error(`LambderI18n: base dictionary is missing language "${lang}".`);
        }
    }
    for (const lang of Object.keys(config.base)) {
        if (!isCode(lang)) {
            throw new Error(`LambderI18n: base dictionary contains unsupported language "${lang}".`);
        }
    }
    assertInlineDefaultBlock(config.base, config.defaultLanguage, "base dictionary");
    const customDetect = config.detectLanguage
        ? () => config.detectLanguage({
            isLanguageCode: isCode,
            languages: config.languages,
            defaultLanguage: config.defaultLanguage,
        })
        : null;
    const metaByCode = new Map(languageList.map((code) => [code, { code, ...config.languages[code] }]));
    // Built for a language the first time one of its plural entries arrives,
    // and kept: t picks a form on every call, and building the rules costs
    // far more than the pick. Never for a language without plural entries,
    // so its code need not be a tag Intl accepts.
    const pluralRules = new Map();
    const pluralRulesOf = (lang) => {
        let rules = pluralRules.get(lang);
        if (!rules) {
            const locale = metaByCode.get(lang)?.intlLocale ?? lang;
            try {
                rules = new Intl.PluralRules(locale);
            }
            catch (err) {
                throw new Error(`LambderI18n: "${lang}" has plural entries, and Intl.PluralRules refuses its Intl locale "${locale}" (${err.message}): give the language an intlLocale it accepts.`);
            }
            pluralRules.set(lang, rules);
        }
        return rules;
    };
    const core = {
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
    return buildInstance(core, createLayer(core, config.base, null, "base dictionary"));
};
