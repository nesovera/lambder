import type ts from "typescript";
/** How the printed module is punctuated. */
export type ContractPrintStyle = {
    quote: "'" | "\"";
    semicolon: "" | ";";
};
/** The contract as text: each entry by name, and the named types the entries refer to. */
export type PrintedContract = {
    entries: {
        name: string;
        text: string;
    }[];
    declarations: {
        name: string;
        text: string;
    }[];
    /** Where the contract holds something with no plain form, and what it is. */
    failures: string[];
};
export declare class ContractTypePrinter {
    private readonly ts;
    private readonly program;
    private readonly checker;
    private readonly style;
    private failures;
    /** Every declaration by the type it stands for. */
    private declarations;
    /** The name each declaration is printed under, settled from all of them; empty on the pass that finds them. */
    private settledNames;
    /** Names a declaration may not take: the default library's, and the contract's own. */
    private readonly reservedNames;
    /** The anonymous types being printed: meeting one again inside itself is recursion, and it needs a name. */
    private readonly inProgress;
    /** Under exactOptionalPropertyTypes an optional member's type carries the compiler's own "missing" undefined, which its source never wrote. */
    private readonly exactOptionalProperties;
    constructor(ts: typeof import("typescript"), program: ts.Program, checker: ts.TypeChecker, style: ContractPrintStyle, contractName: string);
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
    printContract(contract: ts.Type): PrintedContract;
    /**
     * A name for every declaration the first pass found. Of the types that
     * want one name, the one declared first (by file, then position) keeps
     * it, and the others take the lowest free number after it once every
     * type has claimed its own name, so a number never takes the name
     * another type is declared under. Types declared at one place (two
     * instantiations of a generic) keep the order the entries reached them
     * in, by entry name.
     */
    private settleNames;
    /**
     * `label value`, with a union too long for one line starting on the next
     * line, one member per line: what a property, an index signature and a
     * declaration all print through.
     */
    labeledValue(label: string, value: string): string;
    private print;
    /** A union, an intersection or an object: printed in place, or as a reference to a declaration of its own. */
    private printComposite;
    /** A type's declaration, under the name it is settled to once the first pass has settled them. */
    private declare;
    /** The name a type is declared under and where, when it is one to print as a declaration: non-generic, and not the default library's. */
    private ownDeclarationOf;
    /** A symbol's name to declare a type under, and where the symbol is declared. */
    private declaredAs;
    /** Where a symbol is declared, as text that orders by file and then position; empty for one declared nowhere. */
    private originOf;
    /** The name a symbol is declared under, read off its declaration, so `export default interface Customer` is Customer; undefined when it has none to print. */
    private nameOf;
    /**
     * A name for a type that refers to itself and has none of its own: what it
     * instantiates followed by its arguments (a JSON mapping of a Tree is
     * `JsonOfTree`, a `Tree<string>` is `TreeString`), or `RecursiveType`.
     * Its origin is where what it instantiates is declared, then where each
     * argument is, so two instantiations named alike are told apart by their
     * arguments.
     */
    private recursiveDeclarationOf;
    private printStructure;
    private printUnion;
    private printUnionOf;
    private printIntersection;
    private printObject;
    private printMembers;
    /**
     * An optional member's type as its source wrote it. Under
     * exactOptionalPropertyTypes the compiler adds its own "missing"
     * undefined, a different type from the `undefined` a source writes;
     * printed as `| undefined` it would let the member be undefined, which
     * the source does not.
     */
    private printOptionalMember;
    private printTuple;
    private printTemplateLiteral;
    /** Why a property cannot be printed as a plain member, or undefined when it can. */
    private unprintableProperty;
    /** An object type printed member by member: not an array, a tuple, a function or a default library interface. */
    private isPlainObject;
    private isCallable;
    private isDefaultLibraryInterface;
    /** Declared in the default library, even where a package augments it (as @types/node does some globals). */
    private isDefaultLibrary;
    private wrapped;
    keyOf(name: string): string;
    private quoted;
    private fail;
}
