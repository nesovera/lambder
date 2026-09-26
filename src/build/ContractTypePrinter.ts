import type ts from "typescript";

/*
 * Prints a type as plain TypeScript that names nothing outside the printed
 * text: every type a declaration elsewhere would supply (a zod inference, a
 * mapped or conditional type, an interface in the server's code) is written
 * out as the structure it resolves to. What the client compiles is then the
 * structure alone, without the schemas and libraries that produced it.
 *
 * Two kinds of name survive. The default library's own interfaces (Date,
 * Uint8Array) are printed by name, since every TypeScript program has them.
 * A non-generic type alias, interface or class from anywhere else is printed
 * once as a declaration of its own, under its own name, and referred to by
 * that name: the file stays as small as the contract, a recursive type
 * (JSON, a tree) can refer to itself, and a diagnostic names the type rather
 * than spilling it. Any other type that recurses (an instance of a generic
 * one, a mapped type) is given a name after what it instantiates.
 *
 * Whatever has no plain form (a function, a symbol key, an enum, a class's
 * private member, a type parameter the contract leaves open) is collected as
 * a failure naming where it sits, rather than printed as a name that only
 * resolves back in the server. So is a type the compiler could not resolve,
 * which reaches the contract as `any` wherever the app's sources have a
 * compile error, and would print as `any` and verify as itself.
 */

/** How the printed module is punctuated. */
export type ContractPrintStyle = { quote: "'" | "\""; semicolon: "" | ";" };

/** The contract as text: each entry by name, and the named types the entries refer to. */
export type PrintedContract = {
    entries: { name: string; text: string }[];
    declarations: { name: string; text: string }[];
    /** Where the contract holds something with no plain form, and what it is. */
    failures: string[];
};

/**
 * A printed type, and whether it is a union or an intersection (or starts
 * with `readonly`), which an array element, an intersection member or an
 * optional tuple element has to wrap in parentheses.
 */
type PrintedType = { text: string; compound: boolean };

const INDENT = "    ";
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** How long a union may run on one line before each member goes on a line of its own. */
const UNION_LINE_WIDTH = 80;

const atom = (text: string): PrintedType => ({ text, compound: false });
const indentFollowingLines = (text: string, indent: string) => text.replace(/\n/g, `\n${indent}`);
/** Code-unit order, so the output never depends on the locale it is generated under. */
const byCodeUnits = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/**
 * Properties in the order they are written in the source: the file, then the
 * position, then the name for those declared together (a Record's keys) or
 * not at all. The compiler's own order is not used, because the properties of
 * a mapped type (every zod inference) follow a union of their keys, and a
 * union is ordered by when each key's type was first created, which moves
 * whenever unrelated code is checked in another order.
 */
const bySourceOrder = (a: ts.Symbol, b: ts.Symbol): number => {
    const first = a.declarations?.[0];
    const second = b.declarations?.[0];
    if(first && second){
        const byFile = byCodeUnits(first.getSourceFile().fileName, second.getSourceFile().fileName);
        if(byFile) return byFile;
        if(first.pos !== second.pos) return first.pos - second.pos;
    }else if(first || second){
        return first ? -1 : 1;
    }
    return byCodeUnits(a.name, b.name);
};
/** Union members in a stable order, with null and undefined last as they are usually written. */
const unionMemberRank = (text: string) => text === "null" ? 1 : text === "undefined" ? 2 : 0;

export class ContractTypePrinter {
    private readonly failures: string[] = [];
    /** Every named declaration by the type it stands for; its text is null while it is being printed. */
    private readonly declarations = new Map<ts.Type, { name: string; text: string | null }>();
    /** Names a declaration may not take: the default library's, and the contract's own. */
    private readonly takenNames = new Set<string>();
    /** The anonymous types being printed: meeting one again inside itself is recursion, and it needs a name. */
    private readonly inProgress = new Set<ts.Type>();
    /** Under exactOptionalPropertyTypes an optional member's type carries the compiler's own "missing" undefined, which its source never wrote. */
    private readonly exactOptionalProperties: boolean;

    constructor(
        private readonly ts: typeof import("typescript"),
        private readonly program: ts.Program,
        private readonly checker: ts.TypeChecker,
        private readonly style: ContractPrintStyle,
        contractName: string,
    ) {
        this.takenNames.add(contractName);
        this.exactOptionalProperties = !!program.getCompilerOptions().exactOptionalPropertyTypes;
        // A declaration named after a global the printed text refers to by
        // name (Date) would shadow it.
        for(const sourceFile of program.getSourceFiles()){
            if(!program.isSourceFileDefaultLibrary(sourceFile)) continue;
            for(const statement of sourceFile.statements){
                if((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isModuleDeclaration(statement))
                    && statement.name && ts.isIdentifier(statement.name)) this.takenNames.add(statement.name.text);
            }
        }
    }

    /** Prints each member of the contract type, sorted by name, and every declaration they refer to. */
    printContract(contract: ts.Type): PrintedContract {
        const entries = this.checker.getPropertiesOfType(contract)
            .map((entry) => ({ name: entry.name, text: this.print(this.checker.getTypeOfSymbol(entry), this.keyOf(entry.name)).text }))
            .sort((a, b) => byCodeUnits(a.name, b.name));
        const declarations = [...this.declarations.values()]
            .map(({ name, text }) => ({ name, text: text ?? "never" }))
            .sort((a, b) => byCodeUnits(a.name, b.name));
        return { entries, declarations, failures: this.failures };
    }

    /**
     * `label value`, with a union too long for one line starting on the next
     * line, one member per line: what a property, an index signature and a
     * declaration all print through.
     */
    labeledValue(label: string, value: string): string {
        return value.startsWith("| ") ? `${label}\n${INDENT}${indentFollowingLines(value, INDENT)}` : `${label} ${value}`;
    }

    private print(type: ts.Type, path: string): PrintedType {
        const { TypeFlags } = this.ts;
        const flags = type.flags;
        // The compiler's own `any` is the one a source wrote (or inferred);
        // any other is the error type a compile error leaves behind.
        if(flags & TypeFlags.Any){
            return type === this.checker.getAnyType() ? atom("any") : this.fail(path, "a type the compiler could not resolve, which a compile error in the app's sources leaves behind: run its typecheck");
        }
        if(flags & TypeFlags.Unknown) return atom("unknown");
        if(flags & TypeFlags.Never) return atom("never");
        if(flags & TypeFlags.String) return atom("string");
        if(flags & TypeFlags.Number) return atom("number");
        if(flags & TypeFlags.BigInt) return atom("bigint");
        if(flags & TypeFlags.Boolean) return atom("boolean");
        if(flags & TypeFlags.Void) return atom("void");
        if(flags & TypeFlags.Undefined) return atom("undefined");
        if(flags & TypeFlags.Null) return atom("null");
        if(flags & TypeFlags.ESSymbol) return atom("symbol");
        if(flags & TypeFlags.NonPrimitive) return atom("object");
        // Before the literals: an enum member is a literal type as well.
        if(flags & TypeFlags.EnumLike) return this.fail(path, `${this.checker.typeToString(type)}, an enum, which only its declaration can name`);
        if(flags & TypeFlags.StringLiteral) return atom(this.quoted((type as ts.StringLiteralType).value));
        if(flags & TypeFlags.NumberLiteral) return atom(String((type as ts.NumberLiteralType).value));
        if(flags & TypeFlags.BigIntLiteral){
            const { negative, base10Value } = (type as ts.BigIntLiteralType).value;
            return atom(`${negative ? "-" : ""}${base10Value}n`);
        }
        if(flags & TypeFlags.BooleanLiteral) return atom(this.checker.typeToString(type));
        if(flags & TypeFlags.UniqueESSymbol) return this.fail(path, "a unique symbol, which only its declaration can name");
        if(flags & TypeFlags.TemplateLiteral) return this.printTemplateLiteral(type as ts.TemplateLiteralType, path);
        if(flags & TypeFlags.StringMapping){
            const mapping = type as ts.StringMappingType;
            return atom(`${mapping.symbol.name}<${this.print(mapping.type, path).text}>`);
        }
        if(flags & (TypeFlags.Union | TypeFlags.Intersection | TypeFlags.Object)) return this.printComposite(type, path);
        return this.fail(path, `${this.checker.typeToString(type)}, which only resolves where it was written (a type parameter, or a conditional or indexed type over one)`);
    }

    /** A union, an intersection or an object: printed in place, or as a reference to a declaration of its own. */
    private printComposite(type: ts.Type, path: string): PrintedType {
        const known = this.declarations.get(type);
        if(known) return atom(known.name);
        const ownName = this.declaredNameOf(type);
        if(ownName !== undefined){
            // Registered before the body is printed, so a reference to itself
            // inside the body finds the name.
            const declaration: { name: string; text: string | null } = { name: this.takeName(ownName), text: null };
            this.declarations.set(type, declaration);
            declaration.text = this.printStructure(type, path).text;
            return atom(declaration.name);
        }
        if(this.inProgress.has(type)){
            const declaration = { name: this.takeName(this.recursiveNameOf(type)), text: null };
            this.declarations.set(type, declaration);
            return atom(declaration.name);
        }
        this.inProgress.add(type);
        const printed = this.printStructure(type, path);
        this.inProgress.delete(type);
        // Named while its body was being printed: it refers to itself.
        const recursive = this.declarations.get(type);
        if(!recursive) return printed;
        recursive.text = printed.text;
        return atom(recursive.name);
    }

    /** The name a type is declared under, when it is one to print as a declaration: non-generic, and not the default library's. */
    private declaredNameOf(type: ts.Type): string | undefined {
        const { ObjectFlags, TypeFlags } = this.ts;
        if(type.aliasSymbol){
            return type.aliasTypeArguments?.length || this.isDefaultLibrary(type.aliasSymbol) ? undefined : this.nameOf(type.aliasSymbol);
        }
        if(!(type.flags & TypeFlags.Object)) return undefined;
        const objectFlags = (type as ts.ObjectType).objectFlags;
        if(!(objectFlags & (ObjectFlags.Interface | ObjectFlags.Class))) return undefined;
        // A class, or an interface with a base type, is a reference to itself
        // (for its `this` type). A generic one's instances are references to
        // it instead, and are printed in place.
        if(objectFlags & ObjectFlags.Reference && ((type as ts.TypeReference).target !== type || (type as ts.InterfaceType).typeParameters?.length)) return undefined;
        return this.isDefaultLibrary(type.symbol) ? undefined : this.nameOf(type.symbol);
    }

    /** The name a symbol is declared under, read off its declaration, so `export default interface Customer` is Customer; undefined when it has none to print. */
    private nameOf(symbol: ts.Symbol): string | undefined {
        const declaration = symbol.declarations?.[0];
        const declared = declaration && this.ts.getNameOfDeclaration(declaration);
        const name = declared && this.ts.isIdentifier(declared) ? declared.text : symbol.name;
        return IDENTIFIER.test(name) && name !== "default" && !name.startsWith("__") ? name : undefined;
    }

    /**
     * A name for a type that refers to itself and has none of its own: what it
     * instantiates followed by its arguments (a JSON mapping of a Tree is
     * `JsonOfTree`, a `Tree<string>` is `TreeString`), or `RecursiveType`.
     */
    private recursiveNameOf(type: ts.Type): string {
        const { ObjectFlags, TypeFlags } = this.ts;
        let instantiated: { symbol: ts.Symbol; typeArguments: readonly ts.Type[] } | undefined;
        if(type.aliasSymbol){
            instantiated = { symbol: type.aliasSymbol, typeArguments: type.aliasTypeArguments ?? [] };
        }else if(type.flags & TypeFlags.Object && (type as ts.ObjectType).objectFlags & ObjectFlags.Reference){
            const { target } = type as ts.TypeReference;
            const typeArguments = this.checker.getTypeArguments(type as ts.TypeReference).slice(0, target.typeParameters?.length ?? 0);
            instantiated = { symbol: target.symbol, typeArguments };
        }
        const base = instantiated && this.nameOf(instantiated.symbol);
        if(!instantiated || !base) return "RecursiveType";
        const argumentNames = instantiated.typeArguments
            .map((argument) => (argument.aliasSymbol && this.nameOf(argument.aliasSymbol)) ?? (argument.symbol && this.nameOf(argument.symbol)) ?? this.checker.typeToString(argument))
            .filter((name) => IDENTIFIER.test(name));
        return `${base}${argumentNames.map((name) => name[0]!.toUpperCase() + name.slice(1)).join("")}`;
    }

    private printStructure(type: ts.Type, path: string): PrintedType {
        const { TypeFlags } = this.ts;
        if(type.flags & TypeFlags.Union) return this.printUnion(type as ts.UnionType, path);
        if(type.flags & TypeFlags.Intersection) return this.printIntersection(type as ts.IntersectionType, path);
        return this.printObject(type as ts.ObjectType, path);
    }

    private printUnion(type: ts.UnionType, path: string): PrintedType {
        return this.printUnionOf(type.types, path);
    }

    private printUnionOf(types: readonly ts.Type[], path: string): PrintedType {
        const members: string[] = [];
        // boolean is the union of its two literals, and a union holding it
        // holds them flattened in: they are put back together.
        const booleans = new Set<string>();
        for(const member of types){
            if(member.flags & this.ts.TypeFlags.BooleanLiteral) booleans.add(this.checker.typeToString(member));
            else members.push(this.print(member, path).text);
        }
        if(booleans.size === 2) members.push("boolean");
        else members.push(...booleans);
        members.sort((a, b) => unionMemberRank(a) - unionMemberRank(b) || byCodeUnits(a, b));
        const oneLine = members.join(" | ");
        if(oneLine.length <= UNION_LINE_WIDTH && !oneLine.includes("\n")) return { text: oneLine, compound: true };
        return { text: members.map((member) => `| ${indentFollowingLines(member, "  ")}`).join("\n"), compound: true };
    }

    private printIntersection(type: ts.IntersectionType, path: string): PrintedType {
        // Objects intersected are one object, and printed as the one they are.
        if(type.types.every((member) => this.isPlainObject(member))) return this.printMembers(type, path);
        const members = type.types.map((member) => this.wrapped(this.print(member, path))).sort(byCodeUnits);
        return { text: members.join(" & "), compound: true };
    }

    private printObject(type: ts.ObjectType, path: string): PrintedType {
        const { checker, ts } = this;
        if(checker.isTupleType(type)) return this.printTuple(type as ts.TupleTypeReference, path);
        if(checker.isArrayType(type)){
            const reference = type as ts.TypeReference;
            const element = this.print(checker.getTypeArguments(reference)[0]!, `${path}[]`);
            const readonly = reference.target.symbol?.escapedName === "ReadonlyArray";
            return { text: `${readonly ? "readonly " : ""}${this.wrapped(element)}[]`, compound: readonly };
        }
        if(this.isCallable(type)) return this.fail(path, `${checker.typeToString(type)}, a function, which is not data`);
        if(this.isDefaultLibraryInterface(type)){
            const reference = type as ts.TypeReference;
            const parameterCount = type.objectFlags & ts.ObjectFlags.Reference ? (reference.target as ts.InterfaceType).typeParameters?.length ?? 0 : 0;
            const typeArguments = parameterCount ? checker.getTypeArguments(reference).slice(0, parameterCount) : [];
            const name = checker.getFullyQualifiedName(type.symbol);
            return atom(typeArguments.length ? `${name}<${typeArguments.map((argument) => this.print(argument, path).text).join(", ")}>` : name);
        }
        return this.printMembers(type, path);
    }

    private printMembers(type: ts.Type, path: string): PrintedType {
        const { checker, ts } = this;
        const lines: string[] = [];
        for(const index of checker.getIndexInfosOfType(type)){
            const key = this.print(index.keyType, `${path}[key]`).text;
            lines.push(this.labeledValue(`${index.isReadonly ? "readonly " : ""}[key: ${key}]:`, this.print(index.type, `${path}[${key}]`).text));
        }
        for(const property of [...checker.getPropertiesOfType(type)].sort(bySourceOrder)){
            const propertyPath = `${path}.${property.name}`;
            const unprintable = this.unprintableProperty(property);
            if(unprintable){
                this.fail(propertyPath, unprintable);
                continue;
            }
            const optional = !!(property.flags & ts.SymbolFlags.Optional);
            const printed = optional ? this.printOptionalMember(checker.getTypeOfSymbol(property), propertyPath) : this.print(checker.getTypeOfSymbol(property), propertyPath);
            lines.push(this.labeledValue(`${this.keyOf(property.name)}${optional ? "?" : ""}:`, printed.text));
        }
        if(!lines.length) return atom("{}");
        return atom(`{\n${lines.map((line) => INDENT + indentFollowingLines(line, INDENT) + this.style.semicolon).join("\n")}\n}`);
    }

    /**
     * An optional member's type as its source wrote it. Under
     * exactOptionalPropertyTypes the compiler adds its own "missing"
     * undefined, a different type from the `undefined` a source writes;
     * printed as `| undefined` it would let the member be undefined, which
     * the source does not.
     */
    private printOptionalMember(type: ts.Type, path: string): PrintedType {
        if(!this.exactOptionalProperties || !(type.flags & this.ts.TypeFlags.Union)) return this.print(type, path);
        const undefinedType = this.checker.getUndefinedType();
        const written = (type as ts.UnionType).types.filter((member) => !(member.flags & this.ts.TypeFlags.Undefined) || member === undefinedType);
        if(written.length === (type as ts.UnionType).types.length) return this.print(type, path);
        return written.length === 1 ? this.print(written[0]!, path) : this.printUnionOf(written, path);
    }

    private printTuple(type: ts.TupleTypeReference, path: string): PrintedType {
        const { ElementFlags } = this.ts;
        const { elementFlags, labeledElementDeclarations, readonly } = type.target;
        const labelOf = (index: number) => {
            const declaration = labeledElementDeclarations?.[index];
            return declaration && this.ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
        };
        // Labels are all or nothing in a tuple.
        const labeled = elementFlags.every((_, index) => labelOf(index) !== undefined);
        const elements = this.checker.getTypeArguments(type).slice(0, elementFlags.length).map((element, index) => {
            const flag = elementFlags[index]!;
            const printed = this.print(element, `${path}[${index}]`);
            const label = labeled ? `${labelOf(index)}` : "";
            if(flag & ElementFlags.Rest) return `...${label ? `${label}: ` : ""}${this.wrapped(printed)}[]`;
            if(flag & ElementFlags.Variadic) return `...${label ? `${label}: ` : ""}${printed.text}`;
            if(flag & ElementFlags.Optional) return label ? `${label}?: ${printed.text}` : `${this.wrapped(printed)}?`;
            return label ? `${label}: ${printed.text}` : printed.text;
        });
        return { text: `${readonly ? "readonly " : ""}[${elements.join(", ")}]`, compound: readonly };
    }

    private printTemplateLiteral(type: ts.TemplateLiteralType, path: string): PrintedType {
        // A cooked text as template source: JSON's escapes, plus the two a template adds.
        const escape = (text: string) => JSON.stringify(text).slice(1, -1).replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
        const spans = type.types.map((span, index) => `\${${this.print(span, path).text}}${escape(type.texts[index + 1]!)}`);
        return atom(`\`${escape(type.texts[0]!)}${spans.join("")}\``);
    }

    /** Why a property cannot be printed as a plain member, or undefined when it can. */
    private unprintableProperty(property: ts.Symbol): string | undefined {
        const { ts } = this;
        if(String(property.escapedName).startsWith("__@")) return "a symbol-keyed property, which only its declaration can name";
        if(property.name.startsWith("#")) return "a private field of a class, which only its declaration can hold";
        const hidden = property.declarations?.some((declaration) => ts.getCombinedModifierFlags(declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
        return hidden ? "a private or protected member of a class, which only its declaration can hold" : undefined;
    }

    /** An object type printed member by member: not an array, a tuple, a function or a default library interface. */
    private isPlainObject(type: ts.Type): boolean {
        return !!(type.flags & this.ts.TypeFlags.Object)
            && !this.checker.isArrayType(type) && !this.checker.isTupleType(type)
            && !this.isCallable(type) && !this.isDefaultLibraryInterface(type);
    }

    private isCallable(type: ts.Type): boolean {
        const { SignatureKind } = this.ts;
        return this.checker.getSignaturesOfType(type, SignatureKind.Call).length > 0 || this.checker.getSignaturesOfType(type, SignatureKind.Construct).length > 0;
    }

    private isDefaultLibraryInterface(type: ts.Type): boolean {
        const { SymbolFlags } = this.ts;
        return !!type.symbol && !!(type.symbol.flags & (SymbolFlags.Interface | SymbolFlags.Class)) && this.isDefaultLibrary(type.symbol);
    }

    /** Declared in the default library, even where a package augments it (as @types/node does some globals). */
    private isDefaultLibrary(symbol: ts.Symbol): boolean {
        return !!symbol.declarations?.some((declaration) => this.program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
    }

    private wrapped(printed: PrintedType): string {
        if(!printed.compound) return printed.text;
        if(printed.text.startsWith("| ")) return `(\n${INDENT}${indentFollowingLines(printed.text, INDENT)}\n)`;
        return `(${printed.text})`;
    }

    keyOf(name: string): string {
        return IDENTIFIER.test(name) ? name : this.quoted(name);
    }

    private quoted(value: string): string {
        const doubleQuoted = JSON.stringify(value);
        if(this.style.quote === "\"") return doubleQuoted;
        // Every double quote inside is escaped, so each \" is a quote and
        // never the tail of an escaped backslash.
        return `'${doubleQuoted.slice(1, -1).replace(/\\"/g, "\"").replace(/'/g, "\\'")}'`;
    }

    private takeName(base: string): string {
        let name = base;
        for(let suffix = 2; this.takenNames.has(name); suffix++) name = `${base}${suffix}`;
        this.takenNames.add(name);
        return name;
    }

    private fail(path: string, reason: string): PrintedType {
        this.failures.push(`${path}: ${reason}`);
        return atom("unknown");
    }
}
