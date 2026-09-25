import { describe, it, expect, afterEach, vi } from "vitest";
import { createLambderI18n } from "../src/shared/LambderI18n.js";

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
            base: { en: { invited: "{name} invited you to {org}" } },
        });
        expect(i18n.t("invited", { name: "Eve {org}", org: "Acme" })).toBe("Eve {org} invited you to Acme");
        expect(i18n.t("invited", { name: "$& and $1", org: "Acme" })).toBe("$& and $1 invited you to Acme");
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
                tr: () => import("./fixtures/i18n/turkish-dictionary.js"),
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
            base: { en, tr: () => import("./fixtures/i18n/turkish-dictionary.js") },
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
