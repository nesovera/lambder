import { describe, it, expect, expectTypeOf, afterEach, vi } from "vitest";
import {
    createLambderI18n,
    type LambderI18nKeys, type LambderI18nPluralEntry, type LambderI18nReadonlyInstance,
} from "../../src/shared/LambderI18n.js";

const makeI18n = () => createLambderI18n({
    languages: {
        en: { name: "English", intlLocale: "en", dir: "ltr" },
        tr: { name: "Türkçe", intlLocale: "tr", dir: "ltr" },
        ar: { name: "العربية", intlLocale: "ar", dir: "rtl" },
    },
    defaultLanguage: "en",
    enforced: ["en"],
    base: {
        en: { save: "Save", greet: "Hello {name}" },
        tr: { save: "Kaydet", greet: "Merhaba {name}" },
        ar: { save: "حفظ", greet: "مرحبا {name}" },
    },
});

afterEach(() => {
    vi.unstubAllGlobals();
    // A console spy left behind by a failing test would hide later output.
    vi.restoreAllMocks();
});

/** A browser page: a document, and the navigator whose languages detection reads there. */
const stubPage = (navigator: { languages: string[]; language: string }) => {
    vi.stubGlobal("document", { documentElement: { lang: "", dir: "" } });
    vi.stubGlobal("navigator", navigator);
};

describe("LambderI18n: base translation", () => {
    it("translates keys in the default language when no browser is present", () => {
        const i18n = makeI18n();
        expect(i18n.t("save")).toBe("Save");
    });

    it("interpolates {token} params", () => {
        const i18n = makeI18n();
        expect(i18n.t("greet", { name: "Ada" })).toBe("Hello Ada");
    });

    it("interpolates on a browser without ES2022's Object.hasOwn, filling only the params' own names", () => {
        // Safari before 15.4 has no Object.hasOwn: a call to it there throws
        // on the first text that takes parameters.
        const hasOwnDescriptor = Object.getOwnPropertyDescriptor(Object, "hasOwn")!;
        Reflect.deleteProperty(Object, "hasOwn");
        try {
            const i18n = makeI18n();
            expect(i18n.t("greet", { name: "Ada" })).toBe("Hello Ada");
            expect(i18n.t("greet", Object.create({ name: "inherited" }))).toBe("Hello {name}");
        } finally {
            Object.defineProperty(Object, "hasOwn", hasOwnDescriptor);
        }
    });

    it("interpolates repeated tokens", () => {
        const i18n = createLambderI18n({
            languages: { en: { name: "English" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en: { twice: "{x} and {x}" } },
        });
        expect(i18n.t("twice", { x: "A" })).toBe("A and A");
    });

    it("inserts a value as it is, never filling tokens inside a value it inserted", () => {
        const i18n = createLambderI18n({
            languages: { en: { name: "English" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en: { invited: "{name} invited you to {store}" } },
        });
        expect(i18n.t("invited", { name: "Eve {store}", store: "Acme" })).toBe("Eve {store} invited you to Acme");
        expect(i18n.t("invited", { name: "$& and $1", store: "Acme" })).toBe("$& and $1 invited you to Acme");
    });

    it("forLanguage returns an explicitly-bound translator", () => {
        const i18n = makeI18n();
        expect(i18n.forLanguage("tr")("save")).toBe("Kaydet");
        expect(i18n.forLanguage("ar")("greet", { name: "X" })).toBe("مرحبا X");
    });

    it("falls back to the default language, then the key itself", () => {
        const i18n = makeI18n();
        const child = i18n.extendPartial({ en: { onlyEn: "Only English" } });
        expect(child.forLanguage("tr")("onlyEn")).toBe("Only English");
        // Unknown key at runtime (cast to bypass types) falls back to the key.
        expect((i18n.t as any)("missing.key")).toBe("missing.key");
    });
});

describe("LambderI18n: extension", () => {
    it("extend adds keys on top of base keys", () => {
        const i18n = makeI18n();
        const child = i18n.extend({
            en: { compute: "Compute" },
            tr: { compute: "Hesapla" },
            ar: { compute: "احسب" },
        });
        expect(child.forLanguage("tr")("compute")).toBe("Hesapla");
        expect(child.forLanguage("tr")("save")).toBe("Kaydet"); // parent key visible
    });

    it("extend throws when a language block is missing", () => {
        const i18n = makeI18n();
        expect(() => (i18n.extend as any)({ en: { a: "A" }, tr: { a: "A" } }))
            .toThrow(/missing required language "ar"/);
    });

    it("extendPartial requires only enforced languages", () => {
        const i18n = makeI18n();
        const child = i18n.extendPartial({
            en: { compute: "Compute" },
            tr: { compute: "Hesapla" },
        });
        expect(child.forLanguage("tr")("compute")).toBe("Hesapla");
        expect(child.forLanguage("ar")("compute")).toBe("Compute"); // falls back to en
    });

    it("extendPartial throws when an enforced language is missing", () => {
        const i18n = makeI18n();
        expect(() => (i18n.extendPartial as any)({ tr: { a: "A" } }))
            .toThrow(/missing required language "en"/);
    });

    it("rejects unsupported languages in extension dictionaries", () => {
        const i18n = makeI18n();
        expect(() => (i18n.extendPartial as any)({ en: { a: "A" }, xx: { a: "A" } }))
            .toThrow(/unsupported language "xx"/);
    });

    it("extensions chain", () => {
        const i18n = makeI18n();
        const child = i18n.extendPartial({ en: { a: "A" } });
        const grandchild = child.extendPartial({ en: { b: "B" } });
        const t = grandchild.forLanguage("en");
        expect(t("a")).toBe("A");
        expect(t("b")).toBe("B");
        expect(t("save")).toBe("Save");
    });
});

describe("LambderI18n: language resolution", () => {
    it("uses the custom detectLanguage first", () => {
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en: { hi: "Hi" }, tr: { hi: "Selam" } },
            detectLanguage: ({ isLanguageCode }) => (isLanguageCode("tr") ? "tr" : null),
        });
        expect(i18n.currentLanguage).toBe("tr");
        expect(i18n.t("hi")).toBe("Selam");
    });

    it("detects afresh on every read, so a detector reading the path follows the page", () => {
        let path = "/en/about";
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en: { hi: "Hi" }, tr: { hi: "Selam" } },
            detectLanguage: ({ isLanguageCode }) => {
                const segment = path.split("/")[1] ?? "";
                return isLanguageCode(segment) ? segment : null;
            },
        });
        expect(i18n.t("hi")).toBe("Hi");
        path = "/tr/hakkinda";
        expect(i18n.currentLanguage).toBe("tr");
        expect(i18n.t("hi")).toBe("Selam");
    });

    it("continues the chain when detectLanguage returns null", () => {
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en: { hi: "Hi" }, tr: { hi: "Selam" } },
            detectLanguage: () => null,
        });
        expect(i18n.currentLanguage).toBe("en");
    });

    it("detects from navigator.languages: full code, then primary subtag", () => {
        stubPage({ languages: ["fr-CA", "tr-TR", "en"], language: "fr-CA" });
        const i18n = makeI18n();
        expect(i18n.currentLanguage).toBe("tr"); // fr unsupported, tr via primary subtag
    });

    it("reads no navigator outside a page, so a server answers in defaultLanguage", () => {
        // Pins server-side t() answering in the process locale: Node 21 and
        // later define navigator.languages from it (en-US on Lambda).
        const makeTurkishFirst = () => createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" } },
            defaultLanguage: "tr",
            enforced: ["tr"],
            base: { en: { hi: "Hi" }, tr: { hi: "Selam" } },
        });
        expect(typeof document).toBe("undefined");
        // The process's own navigator, whatever this machine's locale is...
        expect(makeTurkishFirst().t("hi")).toBe("Selam");
        // ...and one that names English outright.
        vi.stubGlobal("navigator", { languages: ["en-US", "en"], language: "en-US" });
        expect(makeTurkishFirst().currentLanguage).toBe("tr");
        expect(makeTurkishFirst().t("hi")).toBe("Selam");
    });

    it("ignores navigator when nothing matches and falls back to default", () => {
        stubPage({ languages: ["fr-FR"], language: "fr-FR" });
        const i18n = makeI18n();
        expect(i18n.currentLanguage).toBe("en");
    });

    it("setLanguage overrides detection and affects extended instances", () => {
        const i18n = makeI18n();
        const child = i18n.extendPartial({ en: { a: "A" }, tr: { a: "T" } });
        i18n.setLanguage("tr");
        expect(child.t("a")).toBe("T");
        expect(child.currentLanguage).toBe("tr");
    });

    it("setLanguage from a child affects the parent (shared state)", () => {
        const i18n = makeI18n();
        const child = i18n.extendPartial({ en: { a: "A" } });
        child.setLanguage("ar");
        expect(i18n.currentLanguage).toBe("ar");
        expect(i18n.currentLanguageMeta.dir).toBe("rtl");
    });

    it("resetLanguage clears the override and re-detects", () => {
        stubPage({ languages: ["tr"], language: "tr" });
        const i18n = makeI18n();
        i18n.setLanguage("ar");
        expect(i18n.currentLanguage).toBe("ar");
        i18n.resetLanguage();
        expect(i18n.currentLanguage).toBe("tr");
    });

    it("setLanguage rejects unsupported codes", () => {
        const i18n = makeI18n();
        expect(() => (i18n.setLanguage as any)("xx")).toThrow(/unsupported language code "xx"/);
    });

    it("notifies onLanguageChange listeners and supports unsubscribe", () => {
        const i18n = makeI18n();
        const seen: string[] = [];
        const unsubscribe = i18n.onLanguageChange((code) => seen.push(code));
        i18n.setLanguage("tr");
        i18n.setLanguage("tr"); // no-op, no duplicate notification
        i18n.setLanguage("ar");
        unsubscribe();
        i18n.setLanguage("en");
        expect(seen).toEqual(["tr", "ar"]);
    });
});

describe("LambderI18n: language tags in any case", () => {
    /** Codes registered with their region and script subtags capitalised, as BCP 47 writes them. */
    const makeRegionalI18n = () => {
        const runs = { "pt-BR": 0 };
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, "pt-BR": { name: "Português" }, "zh-Hant": { name: "繁體中文" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: {
                en: { save: "Save", greet: "Hello {name}" },
                "pt-BR": async () => { runs["pt-BR"] += 1; return { save: "Salvar", greet: "Olá {name}" }; },
                "zh-Hant": { save: "儲存", greet: "你好 {name}" },
            },
        });
        return { i18n, runs };
    };

    it("detects a browser preference in another case, and answers the code as registered", () => {
        stubPage({ languages: ["fr-FR", "pt-br", "en"], language: "fr-FR" });
        expect(makeRegionalI18n().i18n.currentLanguage).toBe("pt-BR");

        stubPage({ languages: ["ZH-HANT"], language: "ZH-HANT" });
        const { i18n } = makeRegionalI18n();
        expect(i18n.currentLanguage).toBe("zh-Hant");
        expect(i18n.currentLanguageMeta).toMatchObject({ code: "zh-Hant", name: "繁體中文" });
        expect(i18n.t("save")).toBe("儲存");

        // The primary subtag too: a registered "en" from "EN-us".
        stubPage({ languages: ["EN-us"], language: "EN-us" });
        expect(makeRegionalI18n().i18n.currentLanguage).toBe("en");
    });

    it("takes what a detector returns in any case, answered as registered", () => {
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, "pt-BR": { name: "Português" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en: { hi: "Hi" }, "pt-BR": { hi: "Oi" } },
            detectLanguage: () => "/PT-br/precos".split("/")[1],
        });
        expect(i18n.currentLanguage).toBe("pt-BR");
        expect(i18n.t("hi")).toBe("Oi");
    });

    it("switches, translates, loads and registers by a code in any case, keyed by the code as registered", async () => {
        const { i18n, runs } = makeRegionalI18n();
        const seen: string[] = [];
        i18n.onLanguageChange((code) => seen.push(code));
        // A code read off a URL or a cookie at runtime, whatever the types say.
        const fromOutside = (code: string) => code as "pt-BR";

        await i18n.loadLanguage(fromOutside("pt-br"));
        expect(runs["pt-BR"]).toBe(1);
        expect(i18n.forLanguage(fromOutside("PT-BR"))("save")).toBe("Salvar");
        expect(i18n.forLanguage(fromOutside("pt-br"))).toBe(i18n.forLanguage("pt-BR"));

        i18n.setLanguage(fromOutside("pt-br"));
        expect(i18n.currentLanguage).toBe("pt-BR");
        i18n.setLanguage("pt-BR");
        // The load announced itself, then the switch once: the second spelling names the same language.
        expect(seen).toEqual(["en", "pt-BR"]);

        i18n.registerDictionary(fromOutside("PT-br"), { save: "Gravar" });
        expect(i18n.t("save")).toBe("Gravar");

        // isLanguageCode stays exact: it narrows the string it is handed to a registered code.
        expect(i18n.isLanguageCode("pt-BR")).toBe(true);
        expect(i18n.isLanguageCode("pt-br")).toBe(false);
        expect(() => i18n.setLanguage(fromOutside("pt-pt"))).toThrow(/unsupported language code "pt-pt"/);
    });

    it("refuses two registered codes that differ only in case: they are one language tag", () => {
        expect(() => createLambderI18n({
            languages: { en: { name: "English" }, "pt-BR": { name: "Português" }, "pt-br": { name: "Português" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en: { a: "A" }, "pt-BR": { a: "A" }, "pt-br": { a: "A" } },
        })).toThrow(/registers "pt-BR" and "pt-br", one language tag in two spellings/);
    });
});

describe("LambderI18n: a read-only view over any instance of one contract", () => {
    it("takes instances over different language sets, and offers none of the members that change one", () => {
        const en = { save: "Save", greet: "Hello {name}" } as const;
        const withTurkish = createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en, tr: { save: "Kaydet", greet: "Merhaba {name}" } },
        });
        const withArabicAndGerman = createLambderI18n({
            languages: { en: { name: "English" }, ar: { name: "العربية", dir: "rtl" }, de: { name: "Deutsch" } },
            defaultLanguage: "en",
            enforced: ["en", "de"],
            base: { en, ar: { save: "حفظ", greet: "مرحبا {name}" }, de: { save: "Speichern", greet: "Hallo {name}" } },
        });

        expectTypeOf(withTurkish).toExtend<LambderI18nReadonlyInstance<typeof en>>();
        expectTypeOf(withArabicAndGerman).toExtend<LambderI18nReadonlyInstance<typeof en>>();
        type Mutator = "setLanguage" | "resetLanguage" | "loadLanguage" | "registerDictionary" | "applyToDocument" | "checkPluralCoverage" | "extend" | "extendPartial";
        expectTypeOf<Extract<keyof LambderI18nReadonlyInstance<typeof en>, Mutator>>().toEqualTypeOf<never>();

        const readers: LambderI18nReadonlyInstance<typeof en>[] = [withTurkish, withArabicAndGerman];
        // The contract still types each call: params are required where the text has tokens.
        expect(readers.map((reader) => reader.forLanguage(reader.languageList[1]!)("greet", { name: "Ada" }))).toEqual(["Merhaba Ada", "مرحبا Ada"]);
        expect(readers.map((reader) => reader.t("save"))).toEqual(["Save", "Save"]);
        expect(readers.map((reader) => reader.languageMetaList.map((meta) => meta.code))).toEqual([["en", "tr"], ["en", "ar", "de"]]);
    });
});

describe("LambderI18n: runtime dictionaries", () => {
    it("registerDictionary merges translations at runtime", () => {
        const i18n = makeI18n();
        i18n.registerDictionary("tr", { save: "Sakla" });
        expect(i18n.forLanguage("tr")("save")).toBe("Sakla");
    });

    it("registrations on the parent are visible to previously-created children", () => {
        const i18n = makeI18n();
        const child = i18n.extendPartial({ en: { extra: "Extra" } });
        i18n.registerDictionary("tr", { extra: "Ekstra" } as any);
        expect(child.forLanguage("tr")("extra")).toBe("Ekstra");
    });

    it("child registrations shadow the parent", () => {
        const i18n = makeI18n();
        const child = i18n.extendPartial({ en: { extra: "Extra" } });
        child.registerDictionary("en", { save: "Store" });
        expect(child.forLanguage("en")("save")).toBe("Store");
        expect(i18n.forLanguage("en")("save")).toBe("Save");
    });
});

/** English inline, Turkish and Arabic behind loaders that count their runs. */
const makeLazyI18n = () => {
    const runs = { tr: 0, ar: 0 };
    const i18n = createLambderI18n({
        languages: {
            en: { name: "English" },
            tr: { name: "Türkçe" },
            ar: { name: "العربية", dir: "rtl" },
        },
        defaultLanguage: "en",
        enforced: ["en"],
        base: {
            en: { save: "Save", greet: "Hello {name}" },
            tr: async () => { runs.tr += 1; return { save: "Kaydet", greet: "Merhaba {name}" }; },
            ar: async () => { runs.ar += 1; return { save: "حفظ", greet: "مرحبا {name}" }; },
        },
    });
    return { i18n, runs };
};

describe("LambderI18n: loaders", () => {
    it("falls back to the default language until the language is loaded", async () => {
        const { i18n, runs } = makeLazyI18n();
        const tr = i18n.forLanguage("tr");
        expect(tr("save")).toBe("Save");
        expect(runs.tr).toBe(0); // nothing runs before it is asked for
        await i18n.loadLanguage("tr");
        expect(tr("save")).toBe("Kaydet");
        expect(tr("greet", { name: "Ada" })).toBe("Merhaba Ada");
        expect(runs.ar).toBe(0); // only the language asked for
    });

    it("loads the active language by default", async () => {
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en: { save: "Save" }, tr: async () => ({ save: "Kaydet" }) },
            detectLanguage: () => "tr",
        });
        await i18n.loadLanguage();
        expect(i18n.t("save")).toBe("Kaydet");
    });

    it("loads a named language without switching to it", async () => {
        const { i18n } = makeLazyI18n();
        await i18n.loadLanguage("ar");
        expect(i18n.currentLanguage).toBe("en");
        expect(i18n.forLanguage("ar")("save")).toBe("حفظ");
    });

    it("runs each loader once and notifies once, across repeated and concurrent calls", async () => {
        const { i18n, runs } = makeLazyI18n();
        let notified = 0;
        i18n.onLanguageChange(() => { notified += 1; });
        await Promise.all([i18n.loadLanguage("tr"), i18n.loadLanguage("tr")]);
        await i18n.loadLanguage("tr");
        expect(runs.tr).toBe(1);
        expect(notified).toBe(1);
    });

    it("takes a module whose default export is the dictionary", async () => {
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: {
                en: { save: "Save", greet: "Hello {name}" },
                tr: () => import("../fixtures/i18n/turkish-dictionary.js"),
            },
        });
        await i18n.loadLanguage("tr");
        expect(i18n.forLanguage("tr")("greet", { name: "Ada" })).toBe("Merhaba Ada");
    });

    it("reads a dictionary with a key named default as a dictionary", async () => {
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: {
                en: { default: "Default" },
                tr: async () => ({ default: "Varsayılan" }),
            },
        });
        await i18n.loadLanguage("tr");
        expect(i18n.forLanguage("tr")("default")).toBe("Varsayılan");
    });

    it("mixes inline and loaded languages, and resolves at once when nothing is left to load", async () => {
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" }, ar: { name: "العربية" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: {
                en: { save: "Save" },
                tr: { save: "Kaydet" },
                ar: async () => ({ save: "حفظ" }),
            },
        });
        let notified = 0;
        i18n.onLanguageChange(() => { notified += 1; });
        expect(i18n.forLanguage("tr")("save")).toBe("Kaydet");
        await i18n.loadLanguage("tr");
        await i18n.loadLanguage("en");
        expect(notified).toBe(0);
        await i18n.loadLanguage("ar");
        expect(notified).toBe(1);
        expect(i18n.forLanguage("ar")("save")).toBe("حفظ");
    });

    it("notifies change listeners once the dictionary has arrived", async () => {
        const { i18n } = makeLazyI18n();
        const seen: string[] = [];
        i18n.onLanguageChange(() => seen.push(i18n.forLanguage("tr")("save")));
        await i18n.loadLanguage("tr");
        expect(seen).toEqual(["Kaydet"]);
    });

    it("setLanguage starts the language's loaders and notifies again when they land", async () => {
        const { i18n, runs } = makeLazyI18n();
        const seen: string[] = [];
        i18n.onLanguageChange(() => seen.push(i18n.t("save")));
        i18n.setLanguage("tr");
        expect(i18n.t("save")).toBe("Save");
        await vi.waitFor(() => expect(i18n.t("save")).toBe("Kaydet"));
        expect(seen).toEqual(["Save", "Kaydet"]);
        expect(runs.tr).toBe(1);
    });

    it("resetLanguage starts the loaders of the language detection lands on", async () => {
        stubPage({ languages: ["tr"], language: "tr" });
        const { i18n } = makeLazyI18n();
        i18n.setLanguage("en");
        i18n.resetLanguage();
        expect(i18n.currentLanguage).toBe("tr");
        await vi.waitFor(() => expect(i18n.t("save")).toBe("Kaydet"));
    });

    it("logs, rather than throws, when the load setLanguage started fails", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en: { save: "Save" }, tr: async () => { throw new Error("offline"); } },
        });
        expect(() => i18n.setLanguage("tr")).not.toThrow();
        await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
        expect(i18n.t("save")).toBe("Save");
    });

    it("rejects when a loader fails, keeps the fallback, and runs the loader again next time", async () => {
        let attempts = 0;
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: {
                en: { save: "Save" },
                tr: async () => {
                    attempts += 1;
                    if (attempts === 1) throw new Error("chunk failed to load");
                    return { save: "Kaydet" };
                },
            },
        });
        await expect(i18n.loadLanguage("tr")).rejects.toThrow("chunk failed to load");
        expect(i18n.forLanguage("tr")("save")).toBe("Save");
        await i18n.loadLanguage("tr");
        expect(i18n.forLanguage("tr")("save")).toBe("Kaydet");
        expect(attempts).toBe(2);
    });

    it("rejects a loader that resolves to something other than a dictionary", async () => {
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en: { save: "Save" }, tr: (async () => "Kaydet") as any },
        });
        await expect(i18n.loadLanguage("tr")).rejects.toThrow(/"tr" loader resolved to neither a dictionary/);
    });

    it("rejects an unsupported language code", async () => {
        const { i18n } = makeLazyI18n();
        await expect((i18n.loadLanguage as any)("xx")).rejects.toThrow(/unsupported language code "xx"/);
    });

    it("keeps translations registered before the loader ran over the ones it brings", async () => {
        const { i18n } = makeLazyI18n();
        i18n.registerDictionary("tr", { save: "Sakla" });
        await i18n.loadLanguage("tr");
        const t = i18n.forLanguage("tr");
        expect(t("save")).toBe("Sakla");
        expect(t("greet", { name: "Ada" })).toBe("Merhaba Ada");
    });

    it("loads every instance sharing the root, whichever one is asked", async () => {
        const { i18n } = makeLazyI18n();
        const child = i18n.extendPartial({
            en: { upload: "Upload" },
            tr: async () => ({ upload: "Yükle" }),
        });
        await child.loadLanguage("tr");
        expect(child.forLanguage("tr")("upload")).toBe("Yükle");
        expect(i18n.forLanguage("tr")("save")).toBe("Kaydet");
    });

    it("creating an extension loads and notifies nothing; its own loadLanguage runs only what is missing", async () => {
        const { i18n, runs } = makeLazyI18n();
        await i18n.loadLanguage("tr");
        let notified = 0;
        i18n.onLanguageChange(() => { notified += 1; });
        const upload = { tr: 0 };
        const child = i18n.extend({
            en: { upload: "Upload" },
            tr: async () => { upload.tr += 1; return { upload: "Yükle" }; },
            ar: async () => ({ upload: "رفع" }),
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(upload.tr).toBe(0);
        expect(notified).toBe(0);
        expect(child.forLanguage("tr")("upload")).toBe("Upload");
        await child.loadLanguage("tr");
        expect(child.forLanguage("tr")("upload")).toBe("Yükle");
        expect(runs.tr).toBe(1); // the root's block was already there
        expect(notified).toBe(1);
    });

    it("does not loop when a change listener creates extensions", async () => {
        const { i18n } = makeLazyI18n();
        await i18n.loadLanguage("tr");
        let renders = 0;
        i18n.onLanguageChange(() => {
            renders += 1;
            if (renders > 10) return;
            i18n.extendPartial({ en: { upload: "Upload" }, tr: async () => ({ upload: "Yükle" }) });
        });
        i18n.setLanguage("tr"); // one render for the switch, one when the extension created in it lands
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(renders).toBe(2);
    });

    it("spends a loader that answered with a block redeclaring a parent key: one rejection, no refetch", async () => {
        const { i18n } = makeLazyI18n();
        let runs = 0;
        const child = i18n.extendPartial({
            en: { upload: "Upload" },
            tr: (async () => { runs += 1; return { upload: "Yükle", save: "Gölge" }; }) as any,
        });
        await expect(i18n.loadLanguage("tr")).rejects.toThrow(/"tr" loader redeclares existing key "save"/);
        await i18n.loadLanguage("tr");
        expect(runs).toBe(1);
        expect(child.forLanguage("tr")("upload")).toBe("Upload"); // the refused block is dropped
        expect(child.forLanguage("tr")("save")).toBe("Kaydet");
    });

    it("refuses a loader for the default language", () => {
        expect(() => createLambderI18n({
            languages: { en: { name: "English" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en: (async () => ({ a: "A" })) as any },
        })).toThrow(/default language "en" inline, not as a loader/);
        const { i18n } = makeLazyI18n();
        expect(() => (i18n.extendPartial as any)({ en: async () => ({ a: "A" }) }))
            .toThrow(/default language "en" inline, not as a loader/);
    });
});

describe("LambderI18n: placeholders kept", () => {
    const languages = { en: { name: "English" }, tr: { name: "Türkçe" } };

    it("refuses a translation that drops or adds a placeholder, naming each key", () => {
        // Dropped, the value a caller passes is lost; added, the token shows
        // as it is. Every mismatch of the block is listed at once.
        const creating = () => createLambderI18n({
            languages, defaultLanguage: "en", enforced: ["en"],
            base: {
                en: { items: "{count} items", greet: "Hello {name}", save: "Save" },
                tr: { items: "Öğeler", greet: "Merhaba {name} {store}", save: "Kaydet" },
            },
        });
        expect(creating).toThrow(/base dictionary, these "tr" translations/);
        expect(creating).toThrow(/"items" has none where the default language has \{count\}/);
        expect(creating).toThrow(/"greet" has \{name\}, \{store\} where the default language has \{name\}/);
    });

    it("takes the placeholders in any order, and repeated", () => {
        const i18n = createLambderI18n({
            languages, defaultLanguage: "en", enforced: ["en"],
            base: {
                en: { move: "Move {from} to {to}" },
                tr: { move: "{to} yerine {from}, {from}" },
            },
        });
        expect(i18n.forLanguage("tr")("move", { from: "A", to: "B" })).toBe("B yerine A, A");
    });

    it("checks an extension against its own default block", () => {
        const base = createLambderI18n({ languages, defaultLanguage: "en", enforced: ["en"], base: { en: { save: "Save" }, tr: { save: "Kaydet" } } });
        expect(() => base.extendPartial({ en: { hi: "Hi {name}" }, tr: { hi: "Selam" } })).toThrow(/extendPartial\(\) dictionary, these "tr" translations/);
    });

    it("refuses a loaded language that breaks one, leaving it on the default language", async () => {
        // A loader that fails to load is a case every app handles already:
        // the language falls back to the default one.
        const i18n = createLambderI18n({
            languages, defaultLanguage: "en", enforced: ["en"],
            base: { en: { greet: "Hello {name}" }, tr: async () => ({ greet: "Merhaba {isim}" }) },
        });
        await expect(i18n.loadLanguage("tr")).rejects.toThrow(/the "tr" loader, these "tr" translations[\s\S]*"greet" has \{isim\} where the default language has \{name\}/);
        expect(i18n.forLanguage("tr")("greet", { name: "Ada" })).toBe("Hello Ada");
    });

    it("checks translations registered at runtime", () => {
        const i18n = createLambderI18n({ languages, defaultLanguage: "en", enforced: ["en"], base: { en: { greet: "Hello {name}" }, tr: { greet: "Merhaba {name}" } } });
        expect(() => i18n.registerDictionary("tr", { greet: "Merhaba" })).toThrow(/registerDictionary\("tr"\)/);
        expect(i18n.forLanguage("tr")("greet", { name: "Ada" })).toBe("Merhaba Ada");
    });
});

/** English and Arabic, with a count-varying entry each: two categories against six. */
const pluralLanguages = {
    en: { name: "English", intlLocale: "en" },
    ar: { name: "العربية", intlLocale: "ar", dir: "rtl" },
} as const;
const pluralEnglish = {
    items: { one: "{count} item", other: "{count} items" },
    ordersAt: { one: "One order at {store}", other: "{count} orders at {store}" },
    save: "Save",
} as const;
const pluralArabic = {
    items: {
        zero: "لا توجد منتجات",
        one: "منتج واحد",
        two: "منتجان",
        few: "{count} منتجات",
        many: "{count} منتجًا",
        other: "{count} منتج",
    },
    ordersAt: {
        zero: "لا توجد طلبات في {store}",
        one: "طلب واحد في {store}",
        two: "طلبان في {store}",
        few: "{count} طلبات في {store}",
        many: "{count} طلبًا في {store}",
        other: "{count} طلب في {store}",
    },
    save: "حفظ",
};
const makePluralI18n = () => createLambderI18n({
    languages: pluralLanguages,
    defaultLanguage: "en",
    enforced: ["en"],
    base: { en: pluralEnglish, ar: pluralArabic },
});

describe("LambderI18n: plural entries", () => {
    it("picks the form for the count under each language's plural rules", () => {
        const i18n = makePluralI18n();
        const english = i18n.forLanguage("en");
        const arabic = i18n.forLanguage("ar");

        expect([0, 1, 2, 5].map((count) => english("items", { count }))).toEqual(["0 items", "1 item", "2 items", "5 items"]);
        // Arabic's six: 0 zero, 1 one, 2 two, and by n % 100, 3-10 few, 11-99 many, the rest (100) other.
        expect([0, 1, 2, 3, 11, 100].map((count) => arabic("items", { count }))).toEqual([
            "لا توجد منتجات", "منتج واحد", "منتجان", "3 منتجات", "11 منتجًا", "100 منتج",
        ]);
        expect(english("ordersAt", { count: 1, store: "Main St" })).toBe("One order at Main St");
        expect(arabic("ordersAt", { count: 2, store: "Main St" })).toBe("طلبان في Main St");

        i18n.setLanguage("ar");
        expect(i18n.t("items", { count: 2 })).toBe("منتجان");
    });

    it("falls back to the default language's entry, picking its form under the default language's rules", () => {
        const i18n = makePluralI18n();
        const child = i18n.extendPartial({ en: { tickets: { one: "{count} ticket", other: "{count} tickets" } } });
        // Under Arabic's rules 2 is "two", a form English has no text for.
        expect(child.forLanguage("ar")("tickets", { count: 2 })).toBe("2 tickets");
        expect(child.forLanguage("ar")("tickets", { count: 1 })).toBe("1 ticket");
    });

    it("picks under the language's Intl locale, so two variants of one language can differ", () => {
        // Brazilian Portuguese counts 0 as one; European Portuguese as other.
        const orders = { one: "{count} pedido", many: "{count} de pedidos", other: "{count} pedidos" };
        const i18n = createLambderI18n({
            languages: { br: { name: "Português (Brasil)", intlLocale: "pt-BR" }, pt: { name: "Português", intlLocale: "pt-PT" } },
            defaultLanguage: "br",
            enforced: ["br"],
            base: { br: { orders }, pt: { orders } },
        });
        expect(i18n.forLanguage("br")("orders", { count: 0 })).toBe("0 pedido");
        expect(i18n.forLanguage("pt")("orders", { count: 0 })).toBe("0 pedidos");
    });

    it("takes a plain text for a plural key in a language whose rules use only other", () => {
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, ja: { name: "日本語" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en: { items: pluralEnglish.items }, ja: { items: "商品 {count} 点" } },
        });
        expect(i18n.forLanguage("ja")("items", { count: 1 })).toBe("商品 1 点");
        i18n.registerDictionary("ja", { items: { other: "{count} 点の商品" } });
        expect(i18n.forLanguage("ja")("items", { count: 3 })).toBe("3 点の商品");
    });

    it("answers the other form for a count the caller did not pass, rather than throwing", () => {
        const i18n = makePluralI18n();
        const untyped = i18n.forLanguage("en") as (key: string, params?: Record<string, unknown>) => string;
        expect(untyped("items")).toBe("{count} items");
        expect(untyped("items", { count: "1" })).toBe("1 item");
    });
});

describe("LambderI18n: plural coverage at runtime", () => {
    /** Arabic items written with two of the six forms Arabic's rules use. */
    const sparseArabic = { ...pluralArabic, items: { one: "منتج واحد", other: "{count} منتج" } };

    it("never refuses an entry for a category it lacks, and shows its other form for a count in that category", async () => {
        // Which categories a language uses is the runtime's plural data, and
        // runtimes ship different data, so a gap must never stop a page.
        const i18n = createLambderI18n({
            languages: pluralLanguages, defaultLanguage: "en", enforced: ["en"],
            base: { en: pluralEnglish, ar: sparseArabic },
        });
        const arabic = i18n.forLanguage("ar");
        expect(arabic("items", { count: 1 })).toBe("منتج واحد");
        expect([0, 2, 3, 11].map((count) => arabic("items", { count }))).toEqual(["0 منتج", "2 منتج", "3 منتج", "11 منتج"]);

        // Nor where an extension, a loader or a registration brings one.
        expect(() => i18n.extend({
            en: { tickets: { one: "{count} ticket", other: "{count} tickets" } },
            ar: { tickets: { other: "{count} تذكرة" } },
        })).not.toThrow();
        const lazy = createLambderI18n({
            languages: pluralLanguages, defaultLanguage: "en", enforced: ["en"],
            base: { en: pluralEnglish, ar: async () => sparseArabic },
        });
        await lazy.loadLanguage("ar");
        expect(lazy.forLanguage("ar")("items", { count: 2 })).toBe("2 منتج");
        expect(() => i18n.registerDictionary("ar", { items: { other: "{count} منتج" } })).not.toThrow();
        expect(() => i18n.registerDictionary("en", { items: { other: "{count} items" } })).not.toThrow();
        expect(i18n.forLanguage("en")("items", { count: 1 })).toBe("1 items");
    });

    it("starts on a runtime whose plural data lists a category the dictionary was not written for", () => {
        // A runtime newer than the one the dictionary was tested on: its
        // English also uses many, for a million.
        const Real = Intl.PluralRules;
        class NewerPluralRules extends Real {
            resolvedOptions() { return { ...super.resolvedOptions(), pluralCategories: ["one", "many", "other"] as Intl.LDMLPluralRule[] }; }
            select(count: number) { return count === 1_000_000 ? "many" : super.select(count); }
        }
        // Intl's members are not enumerable, so the stub chains to it rather than copying it.
        vi.stubGlobal("Intl", Object.assign(Object.create(Intl), { PluralRules: NewerPluralRules }));

        const i18n = makePluralI18n();
        expect(i18n.forLanguage("en")("items", { count: 1_000_000 })).toBe("1000000 items");
        expect(i18n.forLanguage("en")("items", { count: 1 })).toBe("1 item");
    });

    it("takes a plain text for a plural key as its other form, in any language", () => {
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" } }, defaultLanguage: "en", enforced: ["en"],
            base: { en: { items: pluralEnglish.items }, tr: { items: "{count} ürün" } },
        });
        expect(i18n.forLanguage("tr")("items", { count: 1 })).toBe("1 ürün");
        i18n.registerDictionary("en", { items: "Items: {count}" });
        expect(i18n.forLanguage("en")("items", { count: 1 })).toBe("Items: 1");
    });

    it("does not warn while it falls back", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const i18n = createLambderI18n({
            languages: pluralLanguages, defaultLanguage: "en", enforced: ["en"],
            base: { en: pluralEnglish, ar: sparseArabic },
        });
        for (const count of [0, 2, 3, 11, 0, 2]) i18n.forLanguage("ar")("items", { count });
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });
});

describe("LambderI18n: checkPluralCoverage", () => {
    it("resolves when every entry holds every category its language uses", async () => {
        await expect(makePluralI18n().checkPluralCoverage()).resolves.toBeUndefined();
    });

    it("rejects with every gap, by key, language and the categories missing, the default language's included", async () => {
        const { few: _few, many: _many, ...arabicItems } = pluralArabic.items;
        const i18n = createLambderI18n({
            languages: { ...pluralLanguages, tr: { name: "Türkçe", intlLocale: "tr" }, ja: { name: "日本語", intlLocale: "ja" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: {
                en: { ...pluralEnglish, tickets: { other: "{count} tickets" } },
                ar: { ...pluralArabic, items: arabicItems as LambderI18nPluralEntry, tickets: { other: "{count} تذكرة" } },
                tr: { items: "{count} ürün", ordersAt: { one: "{store} için {count} sipariş", other: "{store} için {count} sipariş" }, save: "Kaydet", tickets: { one: "{count} bilet", other: "{count} bilet" } },
                // Japanese uses other alone, so a plain text is complete.
                ja: { items: "商品 {count} 点", ordersAt: { other: "{store} の注文 {count} 件" }, save: "保存", tickets: { other: "チケット {count} 枚" } },
            },
        });
        const failure = await i18n.checkPluralCoverage().then(() => null, (err: Error) => err);
        expect(failure?.message).toMatch(/^LambderI18n: these plural entries lack forms for categories their language's plural rules use/);
        expect(failure?.message.split("\n").slice(1).sort()).toEqual([
            `  "items" in "ar" lacks few, many: "ar" uses zero, one, two, few, many, other`,
            `  "items" in "tr" is a text, which stands for the other form alone, and lacks one: "tr" uses one, other`,
            `  "tickets" in "ar" lacks zero, one, two, few, many: "ar" uses zero, one, two, few, many, other`,
            `  "tickets" in "en" lacks one: "en" uses one, other`,
        ]);
    });

    it("loads the languages behind loaders first, and checks them too", async () => {
        let loads = 0;
        const i18n = createLambderI18n({
            languages: pluralLanguages, defaultLanguage: "en", enforced: ["en"],
            base: { en: pluralEnglish, ar: async () => { loads += 1; return { ...pluralArabic, items: { other: "{count} منتج" } }; } },
        });
        await expect(i18n.checkPluralCoverage()).rejects.toThrow(/"items" in "ar" lacks zero, one, two, few, many/);
        expect(loads).toBe(1);

        const failing = createLambderI18n({
            languages: pluralLanguages, defaultLanguage: "en", enforced: ["en"],
            base: { en: pluralEnglish, ar: async () => { throw new Error("ar.json: 503"); } },
        });
        await expect(failing.checkPluralCoverage()).rejects.toThrow("ar.json: 503");
    });

    it("checks the entries an extension translates with, its parents' included, by the entry t would use", async () => {
        const i18n = makePluralI18n();
        const child = i18n.extendPartial({
            en: { tickets: { one: "{count} ticket", other: "{count} tickets" } },
            ar: { tickets: { one: "تذكرة واحدة", other: "{count} تذكرة" } },
        });
        await expect(i18n.checkPluralCoverage()).resolves.toBeUndefined();
        await expect(child.checkPluralCoverage()).rejects.toThrow(/"tickets" in "ar" lacks zero, two, few, many/);

        // A registration that completes the entry closes the gap.
        child.registerDictionary("ar", { tickets: { zero: "لا توجد تذاكر", one: "تذكرة واحدة", two: "تذكرتان", few: "{count} تذاكر", many: "{count} تذكرة", other: "{count} تذكرة" } });
        await expect(child.checkPluralCoverage()).resolves.toBeUndefined();
    });
});

describe("LambderI18n: plural entries refused", () => {
    it("refuses a plural entry where the default language has a text, since t takes no count for it", () => {
        const i18n = makePluralI18n();
        expect(() => i18n.registerDictionary("ar", { save: { one: "حفظ", other: "حفظ" } } as never))
            .toThrow(/"save" is a plural entry where the default language has a text, for which t takes no count/);
    });

    it("refuses a key that is no plural category, a form that is no text, a missing other, and a value that is neither", () => {
        const i18n = makePluralI18n();
        expect(() => i18n.registerDictionary("en", { items: { one: "{count} item", ones: "{count} item", other: "{count} items" } } as never))
            .toThrow(/these "en" entries are refused:[\s\S]*"items" has "ones", which is no plural category \(zero, one, two, few, many, other\)/);
        expect(() => i18n.registerDictionary("en", { items: { one: 1, other: "{count} items" } } as never))
            .toThrow(/"items" has a one form that is not a text/);
        expect(() => i18n.registerDictionary("ar", { items: { one: "منتج واحد" } } as never))
            .toThrow(/"items" has no other form, which every plural entry needs/);
        expect(() => i18n.registerDictionary("en", { save: 5, cancel: ["Cancel"] } as never))
            .toThrow(/"save" is neither a text nor a plural entry[\s\S]*"cancel" is neither a text nor a plural entry/);
        expect(i18n.forLanguage("en")("items", { count: 1 })).toBe("1 item");
    });

    it("refuses the same where an extension or a loader brings it, the loaded language staying on the default one", async () => {
        const i18n = makePluralI18n();
        expect(() => i18n.extend({
            en: { tickets: { one: "{count} ticket", other: "{count} tickets" } },
            ar: { tickets: { one: "تذكرة واحدة" } as never },
        })).toThrow(/extend\(\) dictionary, these "ar" entries are refused:[\s\S]*"tickets" has no other form/);

        const lazy = createLambderI18n({
            languages: pluralLanguages, defaultLanguage: "en", enforced: ["en"],
            base: { en: pluralEnglish, ar: async () => ({ ...pluralArabic, items: { one: "منتج واحد", lots: "{count} منتج", other: "{count} منتج" } }) },
        });
        await expect(lazy.loadLanguage("ar")).rejects.toThrow(/the "ar" loader, these "ar" entries are refused:[\s\S]*"items" has "lots"/);
        expect(lazy.forLanguage("ar")("items", { count: 2 })).toBe("2 items");
    });

    it("needs an Intl locale that is a well-formed tag, for a language that has plural entries only", () => {
        // Every runtime refuses a malformed tag alike, so this one fails where
        // the dictionary arrives rather than in t.
        const languages = { en: { name: "English" }, xx: { name: "Test", intlLocale: "en_US" } };
        expect(() => createLambderI18n({ languages, defaultLanguage: "en", enforced: ["en"], base: { en: { save: "Save" }, xx: { save: "Save" } } }))
            .not.toThrow();
        expect(() => createLambderI18n({
            languages, defaultLanguage: "en", enforced: ["en"],
            base: { en: { items: pluralEnglish.items }, xx: { items: { one: "{count} item", other: "{count} items" } } },
        })).toThrow(/"xx" has plural entries, and Intl.PluralRules refuses its Intl locale "en_US"/);
    });
});

describe("LambderI18n: plural placeholders", () => {
    it("lets any form leave out {count} to spell the number, and holds every form to the other tokens", () => {
        // Arabic names one and two in words, so those forms carry no {count},
        // and every form carries {store}: the value a caller passes.
        expect(() => makePluralI18n()).not.toThrow();

        const dropped = { ...pluralArabic, ordersAt: { ...pluralArabic.ordersAt, few: "{count} طلبات" } };
        const added = { ...pluralArabic, ordersAt: { ...pluralArabic.ordersAt, many: "{count} طلبًا في {store} {city}" } };
        const creating = (ar: typeof pluralArabic) => () => createLambderI18n({
            languages: pluralLanguages, defaultLanguage: "en", enforced: ["en"], base: { en: pluralEnglish, ar },
        });
        expect(creating(dropped)).toThrow(/these "ar" translations carry other placeholders[\s\S]*"ordersAt" \(few\) has \{count\} where every form needs \{store\} and may add \{count\}/);
        expect(creating(added)).toThrow(/"ordersAt" \(many\) has \{city\}, \{count\}, \{store\} where every form needs \{store\}/);
    });

    it("holds the default language's own forms to each other", () => {
        expect(() => createLambderI18n({
            languages: { en: { name: "English" } }, defaultLanguage: "en", enforced: ["en"],
            base: { en: { ordersAt: { one: "One order", other: "{count} orders at {store}" } } },
        })).toThrow(/these "en" plural forms carry other placeholders[\s\S]*"ordersAt" \(one\) has none where every form needs \{store\}/);
    });

    it("lists entry and placeholder refusals of one block in one error", () => {
        const creating = () => createLambderI18n({
            languages: pluralLanguages, defaultLanguage: "en", enforced: ["en"],
            base: { en: pluralEnglish, ar: { ...pluralArabic, items: { ...pluralArabic.items, lots: "{count} منتج" } as never, save: "حفظ {x}" } },
        });
        expect(creating).toThrow(/entries are refused:[\s\S]*"items" has "lots"[\s\S]*carry other placeholders[\s\S]*"save" has \{x\} where the default language has none/);
    });
});

describe("LambderI18n: a plural key named default in a loaded dictionary", () => {
    it("reads it as the dictionary's own entry where the contract makes default plural, and as a module's export otherwise", async () => {
        const languages = { en: { name: "English" }, ar: { name: "العربية" } };
        const en = { default: { one: "{count} default item", other: "{count} default items" }, save: "Save" } as const;
        const arDictionary = { default: { ...pluralArabic.items }, save: "حفظ" };

        const bare = createLambderI18n({ languages, defaultLanguage: "en", enforced: ["en"], base: { en, ar: async () => arDictionary } });
        await bare.loadLanguage("ar");
        expect(bare.forLanguage("ar")("default", { count: 2 })).toBe("منتجان");
        expect(bare.forLanguage("ar")("save")).toBe("حفظ");

        const asModule = createLambderI18n({ languages, defaultLanguage: "en", enforced: ["en"], base: { en, ar: async () => ({ default: arDictionary }) } });
        await asModule.loadLanguage("ar");
        expect(asModule.forLanguage("ar")("default", { count: 2 })).toBe("منتجان");
    });
});

describe("LambderI18n: config validation", () => {
    it("throws when defaultLanguage is not enforced", () => {
        expect(() => createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" } },
            defaultLanguage: "en",
            enforced: ["tr"] as any,
            base: { en: { a: "A" }, tr: { a: "T" } },
        })).toThrow(/must be listed in enforced/);
    });

    it("throws when base is missing a language", () => {
        expect(() => createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en: { a: "A" } } as any,
        })).toThrow(/base dictionary is missing language "tr"/);
    });

    it("throws when base contains an unsupported language", () => {
        expect(() => createLambderI18n({
            languages: { en: { name: "English" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en: { a: "A" }, xx: { a: "A" } } as any,
        })).toThrow(/unsupported language "xx"/);
    });

    it("extensions copy the dictionary (no aliasing of the caller's object)", () => {
        const i18n = makeI18n();
        const source = { en: { k: "V" } };
        const child = i18n.extendPartial(source);
        child.registerDictionary("en", { other: "O" });
        expect(source.en).toEqual({ k: "V" });
        // "other" arrived at runtime, so it is outside the typed contract.
        const translate = child.forLanguage("en") as (key: string) => string;
        expect(translate("other")).toBe("O");
    });

    it("exposes registry helpers", () => {
        const i18n = makeI18n();
        expect(i18n.languageList).toEqual(["en", "tr", "ar"]);
        expect(i18n.isLanguageCode("tr")).toBe(true);
        expect(i18n.isLanguageCode("xx")).toBe(false);
        expect(i18n.defaultLanguage).toBe("en");
        expect(i18n.languages.ar.dir).toBe("rtl");
    });

    it("languageMetaList injects codes in declaration order", () => {
        const i18n = makeI18n();
        expect(i18n.languageMetaList.map((m) => m.code)).toEqual(["en", "tr", "ar"]);
        expect(i18n.languageMetaList[1]).toMatchObject({ code: "tr", name: "Türkçe" });
    });

    it("currentLanguageMeta / currentDir / currentIntlLocale follow the active language", () => {
        const i18n = makeI18n();
        i18n.setLanguage("ar");
        expect(i18n.currentLanguageMeta).toMatchObject({ code: "ar", dir: "rtl" });
        expect(i18n.currentDir).toBe("rtl");
        expect(i18n.currentIntlLocale).toBe("ar");
        i18n.setLanguage("en");
        expect(i18n.currentDir).toBe("ltr");
    });

    it("currentIntlLocale falls back to the code when meta omits it", () => {
        const i18n = createLambderI18n({
            languages: { "zh-cn": { name: "简体中文", intlLocale: "zh-CN" }, en: { name: "English" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { "zh-cn": { a: "A" }, en: { a: "A" } },
        });
        expect(i18n.currentIntlLocale).toBe("en"); // no intlLocale on en → code
        i18n.setLanguage("zh-cn");
        expect(i18n.currentIntlLocale).toBe("zh-CN");
    });
});

describe("LambderI18n: applyToDocument", () => {
    it("sets html lang and dir from the active language", () => {
        const documentElement = { lang: "", dir: "" };
        vi.stubGlobal("document", { documentElement });
        const i18n = makeI18n();
        i18n.setLanguage("ar");
        i18n.applyToDocument();
        expect(documentElement.lang).toBe("ar");
        expect(documentElement.dir).toBe("rtl");
        i18n.setLanguage("en");
        i18n.applyToDocument();
        expect(documentElement.dir).toBe("ltr");
    });

    it("no-ops outside a browser", () => {
        const i18n = makeI18n();
        expect(() => i18n.applyToDocument()).not.toThrow();
    });
});

describe("LambderI18n: quality behaviors", () => {
    it("forLanguage caches translators per code (hot-path, no re-allocation)", () => {
        const i18n = makeI18n();
        expect(i18n.forLanguage("tr")).toBe(i18n.forLanguage("tr"));
        expect(i18n.forLanguage("tr")).not.toBe(i18n.forLanguage("ar"));
    });

    it("fails open when detectLanguage throws", () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, tr: { name: "Türkçe" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: { en: { hi: "Hi" }, tr: { hi: "Selam" } },
            detectLanguage: () => { throw new Error("boom"); },
        });
        expect(i18n.t("hi")).toBe("Hi"); // chain continued to default
        expect(i18n.t("hi")).toBe("Hi");
        // Reported once, not on every t() that runs the detector.
        expect(consoleError).toHaveBeenCalledOnce();
        consoleError.mockRestore();
    });

    it("isolates throwing change listeners", () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const i18n = makeI18n();
        const seen: string[] = [];
        i18n.onLanguageChange(() => { throw new Error("bad listener"); });
        i18n.onLanguageChange((code) => seen.push(code));
        expect(() => i18n.setLanguage("tr")).not.toThrow();
        expect(seen).toEqual(["tr"]);
        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
    });

    it("registerDictionary notifies change listeners (reactive bridges re-render)", () => {
        const i18n = makeI18n();
        let notified = 0;
        i18n.onLanguageChange(() => { notified += 1; });
        i18n.registerDictionary("tr", { save: "Sakla" });
        expect(notified).toBe(1);
    });

    it("extend rejects redeclared parent keys at runtime", () => {
        const i18n = makeI18n();
        expect(() => (i18n.extendPartial as any)({ en: { save: "Shadow" } }))
            .toThrow(/redeclares existing key "save"/);
        const child = i18n.extendPartial({ en: { fresh: "Fresh" } });
        expect(() => (child.extendPartial as any)({ en: { fresh: "Again" } }))
            .toThrow(/redeclares existing key "fresh"/);
    });

    it("memoizes currentLanguageMeta and languageMetaList (stable identities)", () => {
        const i18n = makeI18n();
        expect(i18n.currentLanguageMeta).toBe(i18n.currentLanguageMeta);
        expect(i18n.languageMetaList).toBe(i18n.languageMetaList);
        const before = i18n.currentLanguageMeta;
        i18n.setLanguage("ar");
        expect(i18n.currentLanguageMeta).not.toBe(before);
        expect(i18n.currentLanguageMeta).toBe(i18n.currentLanguageMeta);
    });
});

describe("LambderI18n: compile-time plural contract", () => {
    it("requires a numeric count for a plural key, beside the tokens across its forms", () => {
        const i18n = makePluralI18n();
        i18n.t("items", { count: 2 });
        i18n.t("ordersAt", { count: 2, store: "Main St" });
        i18n.t("save");
        // @ts-expect-error - a plural key takes a count
        void (() => i18n.t("items"));
        // @ts-expect-error - the count is a number
        void (() => i18n.t("items", { count: "2" }));
        // @ts-expect-error - a token one form carries is required for every count
        void (() => i18n.t("ordersAt", { count: 2 }));
        // @ts-expect-error - no other params
        void (() => i18n.t("items", { count: 2, store: "Main St" }));
        expectTypeOf<LambderI18nKeys<typeof i18n>>().toEqualTypeOf<"items" | "ordersAt" | "save">();
        expect(i18n.forLanguage("ar")("save")).toBe("حفظ");
    });

    it("requires other in a plural entry, and keeps a text key a text in every language", () => {
        const languages = { en: { name: "English" }, ja: { name: "日本語" } } as const;
        void (() => createLambderI18n({
            languages, defaultLanguage: "en", enforced: ["en"],
            // @ts-expect-error - other is required
            base: { en: { items: { one: "{count} item" } }, ja: { items: "商品 {count} 点" } },
        }));
        void (() => createLambderI18n({
            languages, defaultLanguage: "en", enforced: ["en"],
            // @ts-expect-error - a plural entry where the contract has a text: t would take no count for it
            base: { en: { save: "Save" }, ja: { save: { other: "保存" } } },
        }));
        // A plural contract takes a plain text in another language: the
        // count still reaches t, and the rules decide whether one form is enough.
        const i18n = createLambderI18n({
            languages, defaultLanguage: "en", enforced: ["en"],
            base: { en: { items: { one: "{count} item", other: "{count} items" } }, ja: { items: "商品 {count} 点" } },
        });
        const child = i18n.extendPartial({ en: { tickets: { one: "{count} ticket", other: "{count} tickets" } }, ja: { tickets: { other: "チケット {count} 枚" } } });
        child.t("tickets", { count: 1 });
        // @ts-expect-error - extendPartial keeps the plural contract
        void (() => child.t("tickets"));
        expect(child.forLanguage("ja")("tickets", { count: 4 })).toBe("チケット 4 枚");
    });

    it("lets a read-only view take an instance whose contract has plural entries", () => {
        const withArabic = makePluralI18n();
        expectTypeOf(withArabic).toExtend<LambderI18nReadonlyInstance<typeof pluralEnglish>>();
        const reader: LambderI18nReadonlyInstance<typeof pluralEnglish> = withArabic;
        expect(reader.forLanguage("ar")("items", { count: 3 })).toBe("3 منتجات");
        // @ts-expect-error - the contract still types each call
        void (() => reader.t("items"));
    });
});

describe("LambderI18n: compile-time contract", () => {
    it("keeps the contract when the base is a non-inline const (imported dictionary map)", () => {
        // Mirrors the app pattern: `en` declared as const in one module, the
        // full map assembled in another, then passed as `base`.
        const en = { plain: "Plain", withParam: "Hi {name}" } as const;
        const de: Record<keyof typeof en, string> = { plain: "Schlicht", withParam: "Hallo {name}" };
        const DICT = { en, de };
        const i18n = createLambderI18n({
            languages: { en: { name: "English" }, de: { name: "Deutsch" } },
            defaultLanguage: "en",
            enforced: ["en"],
            base: DICT,
        });
        expect(i18n.forLanguage("de")("withParam", { name: "X" })).toBe("Hallo X");
        // @ts-expect-error - {name} param is required (literal types survived)
        void (() => i18n.t("withParam"));
        // @ts-expect-error - unknown key
        void (() => i18n.t("nope"));
    });

    it("enforces keys and params at the type level", () => {
        const i18n = makeI18n();
        const child = i18n.extendPartial({ en: { withParam: "Value: {value}" }, tr: { withParam: "Değer: {value}" } });

        // Valid usages:
        child.t("save");
        child.t("greet", { name: "X" });
        child.t("withParam", { value: 1 });

        // @ts-expect-error - unknown key
        void (() => child.t("unknownKey"));
        // @ts-expect-error - missing required params for a {token} key
        void (() => child.t("greet"));
        // @ts-expect-error - wrong param name
        void (() => child.t("withParam", { wrong: 1 }));
        // @ts-expect-error - extend (strict) requires every language block
        void (() => i18n.extend({ en: { k: "V" }, tr: { k: "V" } }));
        // @ts-expect-error - extendPartial still requires enforced languages
        void (() => i18n.extendPartial({ tr: { k: "V" } }));
        // @ts-expect-error - redeclaring an existing parent key is rejected
        void (() => i18n.extendPartial({ en: { save: "Shadow" } }));

        expect(child.forLanguage("tr")("withParam", { value: 2 })).toBe("Değer: 2");
    });

    it("holds loaders to the same contract as inline blocks", () => {
        const languages = { en: { name: "English" }, tr: { name: "Türkçe" } } as const;
        const en = { save: "Save", greet: "Hello {name}" } as const;

        // Valid: a loader resolving to the dictionary, or to a module exporting it as default.
        const i18n = createLambderI18n({
            languages, defaultLanguage: "en", enforced: ["en"],
            base: { en, tr: () => import("../fixtures/i18n/turkish-dictionary.js") },
        });
        createLambderI18n({
            languages, defaultLanguage: "en", enforced: ["en"],
            base: { en, tr: async () => ({ save: "Kaydet", greet: "Merhaba {name}" }) },
        });
        // The contract still comes from the inline default block.
        i18n.t("greet", { name: "X" });
        // @ts-expect-error - {name} param is required
        void (() => i18n.t("greet"));

        void (() => createLambderI18n({
            languages, defaultLanguage: "en", enforced: ["en"],
            // @ts-expect-error - a loaded dictionary must provide every key
            base: { en, tr: async () => ({ save: "Kaydet" }) },
        }));
        void (() => createLambderI18n({
            languages, defaultLanguage: "en", enforced: ["en"],
            // @ts-expect-error - the default language cannot be a loader
            base: { en: async () => en, tr: { save: "Kaydet", greet: "Merhaba {name}" } },
        }));

        // Extensions: strict loaders must be complete, partial ones may be a subset.
        void (() => i18n.extend({
            en: { upload: "Upload", cancel: "Cancel" },
            // @ts-expect-error - extend requires every key from a loader too
            tr: async () => ({ upload: "Yükle" }),
        }));
        const child = i18n.extendPartial({
            en: { upload: "Upload", cancel: "Cancel" },
            tr: async () => ({ upload: "Yükle" }),
        });
        child.t("cancel");
        expect(child.t("upload")).toBe("Upload");
    });
});
