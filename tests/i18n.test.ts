import { describe, it, expect, afterEach, vi } from "vitest";
import { createLambderI18n } from "../src/LambderI18n.js";

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
});

describe("LambderI18n: base translation", () => {
    it("translates keys in the default language when no browser is present", () => {
        const i18n = makeI18n();
        expect(i18n.t("save")).toBe("Save");
    });

    it("interpolates {token} params", () => {
        const i18n = makeI18n();
        expect(i18n.t("greet", { name: "Ada" })).toBe("Hello Ada");
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
        vi.stubGlobal("navigator", { languages: ["fr-CA", "tr-TR", "en"], language: "fr-CA" });
        const i18n = makeI18n();
        expect(i18n.currentLanguage).toBe("tr"); // fr unsupported, tr via primary subtag
    });

    it("ignores navigator when nothing matches and falls back to default", () => {
        vi.stubGlobal("navigator", { languages: ["fr-FR"], language: "fr-FR" });
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
        vi.stubGlobal("navigator", { languages: ["tr"], language: "tr" });
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
        const child = i18n.extendPartial(source as any);
        child.registerDictionary("en", { other: "O" });
        expect(source.en).toEqual({ k: "V" });
        expect(child.forLanguage("en")("other" as never)).toBe("O");
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
        expect(consoleError).toHaveBeenCalled();
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
});
