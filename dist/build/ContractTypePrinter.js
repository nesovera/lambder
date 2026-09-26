const INDENT = "    ";
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** How long a union may run on one line before each member goes on a line of its own. */
const UNION_LINE_WIDTH = 80;
const atom = (text) => ({ text, compound: false });
const indentFollowingLines = (text, indent) => text.replace(/\n/g, `\n${indent}`);
/** Code-unit order, so the output never depends on the locale it is generated under. */
const byCodeUnits = (a, b) => a < b ? -1 : a > b ? 1 : 0;
/**
 * Properties in the order they are written in the source: the file, then the
 * position, then the name for those declared together (a Record's keys) or
 * not at all. The compiler's own order is not used, because the properties of
 * a mapped type (every zod inference) follow a union of their keys, and a
 * union is ordered by when each key's type was first created, which moves
 * whenever unrelated code is checked in another order.
 */
const bySourceOrder = (a, b) => {
    const first = a.declarations?.[0];
    const second = b.declarations?.[0];
    if (first && second) {
        const byFile = byCodeUnits(first.getSourceFile().fileName, second.getSourceFile().fileName);
        if (byFile)
            return byFile;
        if (first.pos !== second.pos)
            return first.pos - second.pos;
    }
    else if (first || second) {
        return first ? -1 : 1;
    }
    return byCodeUnits(a.name, b.name);
};
/** Union members in a stable order, with null and undefined last as they are usually written. */
const unionMemberRank = (text) => text === "null" ? 1 : text === "undefined" ? 2 : 0;
export class ContractTypePrinter {
    ts;
    program;
    checker;
    style;
    failures = [];
    /** Every declaration by the type it stands for. */
    declarations = new Map();
    /** The name each declaration is printed under, settled from all of them; empty on the pass that finds them. */
    settledNames = new Map();
    /** Names a declaration may not take: the default library's, and the contract's own. */
    reservedNames = new Set();
    /** The anonymous types being printed: meeting one again inside itself is recursion, and it needs a name. */
    inProgress = new Set();
    /** Under exactOptionalPropertyTypes an optional member's type carries the compiler's own "missing" undefined, which its source never wrote. */
    exactOptionalProperties;
    constructor(ts, program, checker, style, contractName) {
        this.ts = ts;
        this.program = program;
        this.checker = checker;
        this.style = style;
        this.reservedNames.add(contractName);
        this.exactOptionalProperties = !!program.getCompilerOptions().exactOptionalPropertyTypes;
        // A declaration named after a global the printed text refers to by
        // name (Date) would shadow it.
        for (const sourceFile of program.getSourceFiles()) {
            if (!program.isSourceFileDefaultLibrary(sourceFile))
                continue;
            for (const statement of sourceFile.statements) {
                if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isModuleDeclaration(statement))
                    && statement.name && ts.isIdentifier(statement.name))
                    this.reservedNames.add(statement.name.text);
            }
        }
    }
    /**
     * Prints each member of the contract type, sorted by name, and every
     * declaration they refer to.
     *
     * In two passes: the first finds every type that needs a declaration,
     * and the second prints with their names settled from all of them. Named
     * as the printer met them, two types wanting one name would trade it
     * whenever the APIs were registered in another order, or a union's
     * members created in another, and the file would move with no API
     * changed.
     */
    printContract(contract) {
        const members = [...this.checker.getPropertiesOfType(contract)].sort((a, b) => byCodeUnits(a.name, b.name));
        const printEntries = () => members.map((entry) => ({ name: entry.name, text: this.print(this.checker.getTypeOfSymbol(entry), this.keyOf(entry.name)).text }));
        printEntries();
        this.settledNames = this.settleNames();
        this.failures = [];
        this.declarations = new Map();
        const entries = printEntries();
        const declarations = [...this.declarations.values()]
            .map(({ name, text }) => ({ name, text: text ?? "never" }))
            .sort((a, b) => byCodeUnits(a.name, b.name));
        return { entries, declarations, failures: this.failures };
    }
    /**
     * A name for every declaration the first pass found. Of the types that
     * want one name, the one declared first (by file, then position) keeps
     * it, and the others take the lowest free number after it once every
     * type has claimed its own name, so a number never takes the name
     * another type is declared under. Types declared at one place (two
     * instantiations of a generic) keep the order the entries reached them
     * in, by entry name.
     */
    settleNames() {
        const wanting = [...this.declarations].sort(([, a], [, b]) => byCodeUnits(a.base, b.base) || byCodeUnits(a.origin, b.origin));
        const taken = new Set(this.reservedNames);
        const settled = new Map();
        const numbered = [];
        for (const [type, { base }] of wanting) {
            if (taken.has(base)) {
                numbered.push([type, base]);
                continue;
            }
            taken.add(base);
            settled.set(type, base);
        }
        for (const [type, base] of numbered) {
            let suffix = 2;
            while (taken.has(`${base}${suffix}`))
                suffix++;
            taken.add(`${base}${suffix}`);
            settled.set(type, `${base}${suffix}`);
        }
        return settled;
    }
    /**
     * `label value`, with a union too long for one line starting on the next
     * line, one member per line: what a property, an index signature and a
     * declaration all print through.
     */
    labeledValue(label, value) {
        return value.startsWith("| ") ? `${label}\n${INDENT}${indentFollowingLines(value, INDENT)}` : `${label} ${value}`;
    }
    print(type, path) {
        const { TypeFlags } = this.ts;
        const flags = type.flags;
        // The compiler's own `any` is the one a source wrote (or inferred);
        // any other is the error type a compile error leaves behind.
        if (flags & TypeFlags.Any) {
            return type === this.checker.getAnyType() ? atom("any") : this.fail(path, "a type the compiler could not resolve, which a compile error in the app's sources leaves behind: run its typecheck");
        }
        if (flags & TypeFlags.Unknown)
            return atom("unknown");
        if (flags & TypeFlags.Never)
            return atom("never");
        if (flags & TypeFlags.String)
            return atom("string");
        if (flags & TypeFlags.Number)
            return atom("number");
        if (flags & TypeFlags.BigInt)
            return atom("bigint");
        if (flags & TypeFlags.Boolean)
            return atom("boolean");
        if (flags & TypeFlags.Void)
            return atom("void");
        if (flags & TypeFlags.Undefined)
            return atom("undefined");
        if (flags & TypeFlags.Null)
            return atom("null");
        if (flags & TypeFlags.ESSymbol)
            return atom("symbol");
        if (flags & TypeFlags.NonPrimitive)
            return atom("object");
        // Before the literals: an enum member is a literal type as well.
        if (flags & TypeFlags.EnumLike)
            return this.fail(path, `${this.checker.typeToString(type)}, an enum, which only its declaration can name`);
        if (flags & TypeFlags.StringLiteral)
            return atom(this.quoted(type.value));
        if (flags & TypeFlags.NumberLiteral)
            return atom(String(type.value));
        if (flags & TypeFlags.BigIntLiteral) {
            const { negative, base10Value } = type.value;
            return atom(`${negative ? "-" : ""}${base10Value}n`);
        }
        if (flags & TypeFlags.BooleanLiteral)
            return atom(this.checker.typeToString(type));
        if (flags & TypeFlags.UniqueESSymbol)
            return this.fail(path, "a unique symbol, which only its declaration can name");
        if (flags & TypeFlags.TemplateLiteral)
            return this.printTemplateLiteral(type, path);
        if (flags & TypeFlags.StringMapping) {
            const mapping = type;
            return atom(`${mapping.symbol.name}<${this.print(mapping.type, path).text}>`);
        }
        if (flags & (TypeFlags.Union | TypeFlags.Intersection | TypeFlags.Object))
            return this.printComposite(type, path);
        return this.fail(path, `${this.checker.typeToString(type)}, which only resolves where it was written (a type parameter, or a conditional or indexed type over one)`);
    }
    /** A union, an intersection or an object: printed in place, or as a reference to a declaration of its own. */
    printComposite(type, path) {
        const known = this.declarations.get(type);
        if (known)
            return atom(known.name);
        const own = this.ownDeclarationOf(type);
        if (own) {
            // Registered before the body is printed, so a reference to itself
            // inside the body finds the name.
            const declaration = this.declare(type, own);
            declaration.text = this.printStructure(type, path).text;
            return atom(declaration.name);
        }
        if (this.inProgress.has(type))
            return atom(this.declare(type, this.recursiveDeclarationOf(type)).name);
        this.inProgress.add(type);
        const printed = this.printStructure(type, path);
        this.inProgress.delete(type);
        // Named while its body was being printed: it refers to itself.
        const recursive = this.declarations.get(type);
        if (!recursive)
            return printed;
        recursive.text = printed.text;
        return atom(recursive.name);
    }
    /** A type's declaration, under the name it is settled to once the first pass has settled them. */
    declare(type, { base, origin }) {
        const declaration = { base, origin, name: this.settledNames.get(type) ?? base, text: null };
        this.declarations.set(type, declaration);
        return declaration;
    }
    /** The name a type is declared under and where, when it is one to print as a declaration: non-generic, and not the default library's. */
    ownDeclarationOf(type) {
        const { ObjectFlags, TypeFlags } = this.ts;
        if (type.aliasSymbol) {
            return type.aliasTypeArguments?.length || this.isDefaultLibrary(type.aliasSymbol) ? undefined : this.declaredAs(type.aliasSymbol);
        }
        if (!(type.flags & TypeFlags.Object))
            return undefined;
        const objectFlags = type.objectFlags;
        if (!(objectFlags & (ObjectFlags.Interface | ObjectFlags.Class)))
            return undefined;
        // A class, or an interface with a base type, is a reference to itself
        // (for its `this` type). A generic one's instances are references to
        // it instead, and are printed in place.
        if (objectFlags & ObjectFlags.Reference && (type.target !== type || type.typeParameters?.length))
            return undefined;
        return this.isDefaultLibrary(type.symbol) ? undefined : this.declaredAs(type.symbol);
    }
    /** A symbol's name to declare a type under, and where the symbol is declared. */
    declaredAs(symbol) {
        const base = this.nameOf(symbol);
        return base === undefined ? undefined : { base, origin: this.originOf(symbol) };
    }
    /** Where a symbol is declared, as text that orders by file and then position; empty for one declared nowhere. */
    originOf(symbol) {
        const declaration = symbol?.declarations?.[0];
        return declaration ? `${declaration.getSourceFile().fileName}\0${String(declaration.pos).padStart(10, "0")}` : "";
    }
    /** The name a symbol is declared under, read off its declaration, so `export default interface Customer` is Customer; undefined when it has none to print. */
    nameOf(symbol) {
        const declaration = symbol.declarations?.[0];
        const declared = declaration && this.ts.getNameOfDeclaration(declaration);
        const name = declared && this.ts.isIdentifier(declared) ? declared.text : symbol.name;
        return IDENTIFIER.test(name) && name !== "default" && !name.startsWith("__") ? name : undefined;
    }
    /**
     * A name for a type that refers to itself and has none of its own: what it
     * instantiates followed by its arguments (a JSON mapping of a Tree is
     * `JsonOfTree`, a `Tree<string>` is `TreeString`), or `RecursiveType`.
     * Its origin is where what it instantiates is declared, then where each
     * argument is, so two instantiations named alike are told apart by their
     * arguments.
     */
    recursiveDeclarationOf(type) {
        const { ObjectFlags, TypeFlags } = this.ts;
        let instantiated;
        if (type.aliasSymbol) {
            instantiated = { symbol: type.aliasSymbol, typeArguments: type.aliasTypeArguments ?? [] };
        }
        else if (type.flags & TypeFlags.Object && type.objectFlags & ObjectFlags.Reference) {
            const { target } = type;
            const typeArguments = this.checker.getTypeArguments(type).slice(0, target.typeParameters?.length ?? 0);
            instantiated = { symbol: target.symbol, typeArguments };
        }
        const base = instantiated && this.nameOf(instantiated.symbol);
        if (!instantiated || !base)
            return { base: "RecursiveType", origin: this.originOf(type.symbol) };
        const argumentNames = instantiated.typeArguments
            .map((argument) => (argument.aliasSymbol && this.nameOf(argument.aliasSymbol)) ?? (argument.symbol && this.nameOf(argument.symbol)) ?? this.checker.typeToString(argument))
            .filter((name) => IDENTIFIER.test(name));
        return {
            base: `${base}${argumentNames.map((name) => name[0].toUpperCase() + name.slice(1)).join("")}`,
            origin: [instantiated.symbol, ...instantiated.typeArguments.map((argument) => argument.aliasSymbol ?? argument.symbol)].map((symbol) => this.originOf(symbol)).join("\n"),
        };
    }
    printStructure(type, path) {
        const { TypeFlags } = this.ts;
        if (type.flags & TypeFlags.Union)
            return this.printUnion(type, path);
        if (type.flags & TypeFlags.Intersection)
            return this.printIntersection(type, path);
        return this.printObject(type, path);
    }
    printUnion(type, path) {
        return this.printUnionOf(type.types, path);
    }
    printUnionOf(types, path) {
        const members = [];
        // boolean is the union of its two literals, and a union holding it
        // holds them flattened in: they are put back together.
        const booleans = new Set();
        for (const member of types) {
            if (member.flags & this.ts.TypeFlags.BooleanLiteral)
                booleans.add(this.checker.typeToString(member));
            else
                members.push(this.print(member, path).text);
        }
        if (booleans.size === 2)
            members.push("boolean");
        else
            members.push(...booleans);
        members.sort((a, b) => unionMemberRank(a) - unionMemberRank(b) || byCodeUnits(a, b));
        const oneLine = members.join(" | ");
        if (oneLine.length <= UNION_LINE_WIDTH && !oneLine.includes("\n"))
            return { text: oneLine, compound: true };
        return { text: members.map((member) => `| ${indentFollowingLines(member, "  ")}`).join("\n"), compound: true };
    }
    printIntersection(type, path) {
        // Objects intersected are one object, and printed as the one they are.
        if (type.types.every((member) => this.isPlainObject(member)))
            return this.printMembers(type, path);
        const members = type.types.map((member) => this.wrapped(this.print(member, path))).sort(byCodeUnits);
        return { text: members.join(" & "), compound: true };
    }
    printObject(type, path) {
        const { checker, ts } = this;
        if (checker.isTupleType(type))
            return this.printTuple(type, path);
        if (checker.isArrayType(type)) {
            const reference = type;
            const element = this.print(checker.getTypeArguments(reference)[0], `${path}[]`);
            const readonly = reference.target.symbol?.escapedName === "ReadonlyArray";
            return { text: `${readonly ? "readonly " : ""}${this.wrapped(element)}[]`, compound: readonly };
        }
        if (this.isCallable(type))
            return this.fail(path, `${checker.typeToString(type)}, a function, which is not data`);
        if (this.isDefaultLibraryInterface(type)) {
            const reference = type;
            const parameterCount = type.objectFlags & ts.ObjectFlags.Reference ? reference.target.typeParameters?.length ?? 0 : 0;
            const typeArguments = parameterCount ? checker.getTypeArguments(reference).slice(0, parameterCount) : [];
            const name = checker.getFullyQualifiedName(type.symbol);
            return atom(typeArguments.length ? `${name}<${typeArguments.map((argument) => this.print(argument, path).text).join(", ")}>` : name);
        }
        return this.printMembers(type, path);
    }
    printMembers(type, path) {
        const { checker, ts } = this;
        const lines = [];
        for (const index of checker.getIndexInfosOfType(type)) {
            const key = this.print(index.keyType, `${path}[key]`).text;
            lines.push(this.labeledValue(`${index.isReadonly ? "readonly " : ""}[key: ${key}]:`, this.print(index.type, `${path}[${key}]`).text));
        }
        for (const property of [...checker.getPropertiesOfType(type)].sort(bySourceOrder)) {
            const propertyPath = `${path}.${property.name}`;
            const unprintable = this.unprintableProperty(property);
            if (unprintable) {
                this.fail(propertyPath, unprintable);
                continue;
            }
            const optional = !!(property.flags & ts.SymbolFlags.Optional);
            const printed = optional ? this.printOptionalMember(checker.getTypeOfSymbol(property), propertyPath) : this.print(checker.getTypeOfSymbol(property), propertyPath);
            lines.push(this.labeledValue(`${this.keyOf(property.name)}${optional ? "?" : ""}:`, printed.text));
        }
        if (!lines.length)
            return atom("{}");
        return atom(`{\n${lines.map((line) => INDENT + indentFollowingLines(line, INDENT) + this.style.semicolon).join("\n")}\n}`);
    }
    /**
     * An optional member's type as its source wrote it. Under
     * exactOptionalPropertyTypes the compiler adds its own "missing"
     * undefined, a different type from the `undefined` a source writes;
     * printed as `| undefined` it would let the member be undefined, which
     * the source does not.
     */
    printOptionalMember(type, path) {
        if (!this.exactOptionalProperties || !(type.flags & this.ts.TypeFlags.Union))
            return this.print(type, path);
        const undefinedType = this.checker.getUndefinedType();
        const written = type.types.filter((member) => !(member.flags & this.ts.TypeFlags.Undefined) || member === undefinedType);
        if (written.length === type.types.length)
            return this.print(type, path);
        return written.length === 1 ? this.print(written[0], path) : this.printUnionOf(written, path);
    }
    printTuple(type, path) {
        const { ElementFlags } = this.ts;
        const { elementFlags, labeledElementDeclarations, readonly } = type.target;
        const labelOf = (index) => {
            const declaration = labeledElementDeclarations?.[index];
            return declaration && this.ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
        };
        // Labels are all or nothing in a tuple.
        const labeled = elementFlags.every((_, index) => labelOf(index) !== undefined);
        const elements = this.checker.getTypeArguments(type).slice(0, elementFlags.length).map((element, index) => {
            const flag = elementFlags[index];
            const printed = this.print(element, `${path}[${index}]`);
            const label = labeled ? `${labelOf(index)}` : "";
            if (flag & ElementFlags.Rest)
                return `...${label ? `${label}: ` : ""}${this.wrapped(printed)}[]`;
            if (flag & ElementFlags.Variadic)
                return `...${label ? `${label}: ` : ""}${printed.text}`;
            if (flag & ElementFlags.Optional)
                return label ? `${label}?: ${printed.text}` : `${this.wrapped(printed)}?`;
            return label ? `${label}: ${printed.text}` : printed.text;
        });
        return { text: `${readonly ? "readonly " : ""}[${elements.join(", ")}]`, compound: readonly };
    }
    printTemplateLiteral(type, path) {
        // A cooked text as template source: JSON's escapes, plus the two a template adds.
        const escape = (text) => JSON.stringify(text).slice(1, -1).replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
        const spans = type.types.map((span, index) => `\${${this.print(span, path).text}}${escape(type.texts[index + 1])}`);
        return atom(`\`${escape(type.texts[0])}${spans.join("")}\``);
    }
    /** Why a property cannot be printed as a plain member, or undefined when it can. */
    unprintableProperty(property) {
        const { ts } = this;
        if (String(property.escapedName).startsWith("__@"))
            return "a symbol-keyed property, which only its declaration can name";
        if (property.name.startsWith("#"))
            return "a private field of a class, which only its declaration can hold";
        const hidden = property.declarations?.some((declaration) => ts.getCombinedModifierFlags(declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
        return hidden ? "a private or protected member of a class, which only its declaration can hold" : undefined;
    }
    /** An object type printed member by member: not an array, a tuple, a function or a default library interface. */
    isPlainObject(type) {
        return !!(type.flags & this.ts.TypeFlags.Object)
            && !this.checker.isArrayType(type) && !this.checker.isTupleType(type)
            && !this.isCallable(type) && !this.isDefaultLibraryInterface(type);
    }
    isCallable(type) {
        const { SignatureKind } = this.ts;
        return this.checker.getSignaturesOfType(type, SignatureKind.Call).length > 0 || this.checker.getSignaturesOfType(type, SignatureKind.Construct).length > 0;
    }
    isDefaultLibraryInterface(type) {
        const { SymbolFlags } = this.ts;
        return !!type.symbol && !!(type.symbol.flags & (SymbolFlags.Interface | SymbolFlags.Class)) && this.isDefaultLibrary(type.symbol);
    }
    /** Declared in the default library, even where a package augments it (as @types/node does some globals). */
    isDefaultLibrary(symbol) {
        return !!symbol.declarations?.some((declaration) => this.program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
    }
    wrapped(printed) {
        if (!printed.compound)
            return printed.text;
        if (printed.text.startsWith("| "))
            return `(\n${INDENT}${indentFollowingLines(printed.text, INDENT)}\n)`;
        return `(${printed.text})`;
    }
    keyOf(name) {
        return IDENTIFIER.test(name) ? name : this.quoted(name);
    }
    quoted(value) {
        const doubleQuoted = JSON.stringify(value);
        if (this.style.quote === "\"")
            return doubleQuoted;
        // Every double quote inside is escaped, so each \" is a quote and
        // never the tail of an escaped backslash.
        return `'${doubleQuoted.slice(1, -1).replace(/\\"/g, "\"").replace(/'/g, "\\'")}'`;
    }
    fail(path, reason) {
        this.failures.push(`${path}: ${reason}`);
        return atom("unknown");
    }
}
