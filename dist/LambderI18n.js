/**
 * LambderI18n — standalone, framework-free, isomorphic typed translation module.
 *
 * Zero dependencies, no Node/DOM requirements (browser detection is feature-gated),
 * safe to import in both lambda backends and frontend bundles.
 *
 * See docs/I18N.md for the full guide.
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
        const custom = this.customDetect?.();
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
    subscribe(listener) {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }
    notify(code) {
        for (const listener of this.listeners)
            listener(code);
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
const buildInstance = (core, layer) => {
    const translateIn = (lang, key, params) => {
        const text = layerLookup(layer, lang, key)
            ?? layerLookup(layer, core.defaultLanguage, key)
            ?? key;
        return interpolate(text, params);
    };
    const t = (key, params) => translateIn(core.state.resolve(), key, params);
    const validateExtension = (dict, requiredLanguages, label) => {
        for (const lang of Object.keys(dict)) {
            if (!core.isCode(lang))
                throw new Error(`LambderI18n: ${label} contains unsupported language "${lang}".`);
        }
        for (const lang of requiredLanguages) {
            if (!dict[lang])
                throw new Error(`LambderI18n: ${label} is missing required language "${lang}".`);
        }
    };
    const instance = {
        t: t,
        forLanguage(code) {
            if (!core.isCode(code))
                throw new Error(`LambderI18n: unsupported language code "${code}".`);
            return ((key, params) => translateIn(code, key, params));
        },
        extend(dict) {
            validateExtension(dict, core.languageList, "extend() dictionary");
            return buildInstance(core, { dicts: { ...dict }, parent: layer });
        },
        extendPartial(dict) {
            validateExtension(dict, core.enforced, "extendPartial() dictionary");
            return buildInstance(core, { dicts: { ...dict }, parent: layer });
        },
        registerDictionary(code, dict) {
            if (!core.isCode(code))
                throw new Error(`LambderI18n: unsupported language code "${code}".`);
            layer.dicts[code] = { ...layer.dicts[code], ...dict };
        },
        setLanguage(code) { core.state.set(code); },
        resetLanguage() { core.state.reset(); },
        get currentLanguage() { return core.state.resolve(); },
        get currentLanguageMeta() {
            const code = core.state.resolve();
            return { code, ...core.languages[code] };
        },
        get currentDir() {
            return core.languages[core.state.resolve()]?.dir ?? "ltr";
        },
        get currentIntlLocale() {
            const code = core.state.resolve();
            return core.languages[code]?.intlLocale ?? code;
        },
        onLanguageChange(listener) { return core.state.subscribe(listener); },
        applyToDocument() {
            const doc = globalThis.document;
            if (!doc)
                return;
            const code = core.state.resolve();
            doc.documentElement.lang = code;
            doc.documentElement.dir = core.languages[code]?.dir ?? "ltr";
        },
        isLanguageCode: core.isCode,
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
    const customDetect = config.detectLanguage
        ? () => config.detectLanguage({
            isLanguageCode: isCode,
            languages: config.languages,
            defaultLanguage: config.defaultLanguage,
        })
        : null;
    const core = {
        languages: config.languages,
        languageList,
        defaultLanguage: config.defaultLanguage,
        enforced: config.enforced,
        state: new LanguageState(isCode, config.defaultLanguage, customDetect),
        isCode,
    };
    return buildInstance(core, { dicts: { ...config.base }, parent: null });
};
