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
/** Islamery-style browser detection: ordered prefs, full code then primary subtag. */
const detectBrowserLanguage = (isCode) => {
    if (typeof navigator === "undefined")
        return null;
    const prefs = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const pref of prefs ?? []) {
        const lower = (pref ?? "").toLowerCase();
        if (isCode(lower))
            return lower;
        const primary = lower.split("-")[0] ?? "";
        if (isCode(primary))
            return primary;
    }
    return null;
};
/** Mutable active-language state, shared between an instance and all its extensions. */
class LanguageState {
    isCode;
    defaultLanguage;
    customDetect;
    override = null;
    detected = null;
    listeners = new Set();
    constructor(isCode, defaultLanguage, customDetect) {
        this.isCode = isCode;
        this.defaultLanguage = defaultLanguage;
        this.customDetect = customDetect;
    }
    resolve() {
        if (this.override)
            return this.override;
        if (this.detected)
            return this.detected;
        // Fail-open: a broken app detector must not take down every t() call.
        let custom = null;
        try {
            custom = this.customDetect?.();
        }
        catch (err) {
            console.error("LambderI18n: detectLanguage threw; continuing detection chain.", err);
        }
        if (custom && this.isCode(custom)) {
            this.detected = custom;
            return custom;
        }
        const browser = detectBrowserLanguage(this.isCode);
        this.detected = browser ?? this.defaultLanguage;
        return this.detected;
    }
    set(code) {
        if (!this.isCode(code))
            throw new Error(`LambderI18n: unsupported language code "${code}".`);
        if (this.override === code)
            return;
        this.override = code;
        this.notify(code);
    }
    reset() {
        this.override = null;
        this.detected = null;
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
const interpolate = (text, params) => {
    if (!params)
        return text;
    let out = text;
    for (const [token, value] of Object.entries(params)) {
        out = out.split(`{${token}}`).join(String(value));
    }
    return out;
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
const createLayer = (core, sources, parent) => {
    const layer = { dicts: {}, loaders: new Map(), inFlight: new Map(), parent };
    for (const [lang, source] of Object.entries(sources)) {
        if (typeof source === "function")
            layer.loaders.set(lang, source);
        else if (source)
            layer.dicts[lang] = source;
    }
    if (layer.loaders.size > 0)
        core.lazyLayers.add(layer);
    return layer;
};
const isObjectValue = (value) => typeof value === "object" && value !== null;
/**
 * A loader resolves to the dictionary itself or to a module whose default
 * export is the dictionary. The two cannot be confused: a dictionary's values
 * are strings, so a `default` holding an object can only be a module's.
 */
const dictionaryFromLoaded = (loaded, lang) => {
    const dict = isObjectValue(loaded) && isObjectValue(loaded.default) ? loaded.default : loaded;
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
        // A loader that answered is spent even when its answer is refused:
        // running it again would fetch the same file and fail the same
        // way. Only a loader that rejected stays, to be retried.
        layer.loaders.delete(lang);
        if (layer.loaders.size === 0)
            core.lazyLayers.delete(layer);
        const dict = dictionaryFromLoaded(loaded, lang);
        if (layer.parent)
            assertNoRedeclaredKeys(layer.parent, core.defaultLanguage, dict, `the "${lang}" loader`);
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
const buildInstance = (core, layer) => {
    const translateIn = (lang, key, params) => {
        const text = layerLookup(layer, lang, key)
            ?? layerLookup(layer, core.defaultLanguage, key)
            ?? key;
        return interpolate(text, params);
    };
    const t = (key, params) => translateIn(core.state.resolve(), key, params);
    // forLanguage sits on the hot path of reactive T() bridges: cache per code.
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
            const cached = translatorCache.get(code);
            if (cached)
                return cached;
            if (!core.isCode(code))
                throw new Error(`LambderI18n: unsupported language code "${code}".`);
            const translator = (key, params) => translateIn(code, key, params);
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
            if (!core.isCode(lang))
                return Promise.reject(new Error(`LambderI18n: unsupported language code "${lang}".`));
            return loadLanguageAcrossRoot(core, lang);
        },
        registerDictionary(code, dict) {
            if (!core.isCode(code))
                throw new Error(`LambderI18n: unsupported language code "${code}".`);
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
    const core = {
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
    return buildInstance(core, createLayer(core, config.base, null));
};
