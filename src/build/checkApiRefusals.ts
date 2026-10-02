import { dirname, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import type ts from "typescript";
import { loadTypeScriptCompiler, type TypeScriptModule } from "./loadTypeScriptCompiler.js";

/*
 * Every refusal a handler can reach, held to the codes its endpoint may send.
 *
 * An endpoint names the codes it may refuse with (its `refusals` option and
 * its guards'), and a refusal it sends with any other code, or with none in
 * an app that requires codes, is a crash rather than an answer
 * (checkedRefusal). A handler's own `ctx.refuse` is typed to those codes, so
 * a mistake written there does not compile. A shared helper cannot be: it
 * raises with the init's refuse or the free refuse(), typed to the whole
 * vocabulary or to none, because it serves many endpoints. A code a helper
 * raises for an endpoint that does not declare it compiles, and fails only
 * when a call reaches that line, which a test may never do.
 *
 * This reads the project through the compiler and closes that gap. For every
 * handler Lambder hands a typed `ctx.refuse` (an endpoint's, a guard's, a mock
 * entry's), it follows the handler into every function it can reach (a call,
 * a method, a function passed along, a lazily imported one) and collects the
 * codes raised there, each at its line; the codes the handler may send are
 * read off its `ctx.refuse` type, which is what the type system computed from
 * the endpoint's own declaration and its guards'. A reached code outside
 * them is a finding, and so is an own declared code nothing reaches, and a
 * refusal with no code where the app requires one.
 *
 * What it follows is the program's own code: a function of a dependency is
 * not read, and a call through an interface with no body behind it reaches
 * nothing. What it reads as a code is the type of the `code` a raise site
 * passes, so a code held in a constant counts, and one typed as any string
 * is a finding of its own, since nothing can say which code it will be. A
 * code a helper takes as a parameter reads as every code the parameter's
 * type allows, at every call of the helper, since the check does not follow
 * which one each caller passes.
 *
 * It fails rather than pass what it could not check: a handler handed no
 * typed refuse (a mock guard from a mock that declared no vocabulary, say)
 * is a finding unless the caller lets such handlers stand unchecked, so is a
 * handler handed a typed refuse whose function it cannot find (a parameter
 * of the app's own wrapper around a registration, say), and a project in
 * which it finds no handler to check fails as one that could not be read.
 */

export type LambderApiRefusalCheckOptions = {
    /** The tsconfig.json the project compiles under, whose options and path aliases resolve its imports. Relative to the working directory. */
    tsconfig: string;
    /** The files the program starts from, relative to the working directory; everything they import is read too. Default: the tsconfig's own files. */
    files?: string[];
    /** Whether a refusal with no code is a finding, as it is a crash in an app whose vocabulary requires codes (declareRefusals's requireCodes). Default: true. */
    requireCodes?: boolean;
    /** Whether a handler handed no typed refuse is a finding, since nothing it reaches could be checked. Default: true; false lists such handlers without failing. */
    requireTypedRefuse?: boolean;
};

/** What one handler's check found. */
export type LambderRefusalCheckFinding = {
    /** The handler, as its registration names it: an endpoint's `group.action`, a mock entry's name, a guard's name. */
    handler: string;
    /** Where the handler is registered, as `file:line` relative to the working directory. */
    at: string;
    /**
     * - `undeclared`: a code the handler can reach that it may not send.
     * - `unused`: a code the handler's own `refusals` option names that nothing it reaches raises. Never a mock guard's, whose codes are its server guard's.
     * - `uncoded`: a refusal with no code it can reach, where codes are required.
     * - `unreadable`: a refusal it can reach whose code is not a string literal type.
     * - `untraced`: a handler handed a typed refuse whose function cannot be
     *   found (a parameter, a dependency's value), so nothing it reaches was
     *   checked.
     * - `unchecked`: a handler handed no typed refuse, built by an init that
     *   declared no refusal vocabulary, so there is nothing to hold what it
     *   reaches to. Not a finding with `requireTypedRefuse: false`.
     */
    problem: "undeclared" | "unused" | "uncoded" | "unreadable" | "untraced" | "unchecked";
    /** The code, for `undeclared` and `unused`. */
    code?: string;
    /** Where the refusal is raised, as `file:line`, for `undeclared`, `uncoded` and `unreadable`. */
    raisedAt?: string;
};

export type LambderApiRefusalCheckResult = {
    /** False when the project could not be read, no handler in it could be checked, or any handler has a finding, an unchecked one included unless `requireTypedRefuse` is false. */
    ok: boolean;
    /** How many handlers were checked. */
    handlers: number;
    findings: LambderRefusalCheckFinding[];
    /** What happened, as lines to print: a summary, then one line per finding. */
    lines: string[];
};

/** The registrations whose handler Lambder types a refuse for, by the name they are called under, and where each one's handler is. */
const HANDLER_REGISTRATIONS: Record<string, "second" | "optionsHandler" | "secondOrItsHandler"> = {
    defineApi: "second",
    guard: "optionsHandler",
    lambderGuard: "optionsHandler",
    api: "secondOrItsHandler",
    override: "secondOrItsHandler",
};

/** A refusal raised somewhere a handler can reach. */
type RaiseSite = { at: string } & ({ code: string } | { uncoded: true } | { unreadable: true });

type FunctionNode = ts.FunctionLikeDeclaration;

/** Every raise site a handler can reach, and how many functions of the project it reached them through. */
type Reach = { raises: RaiseSite[]; functions: number };

/**
 * Checks every handler of a project against the codes it may send, and
 * answers what it found.
 *
 * ```ts
 * import { checkApiRefusals } from "lambder/build";
 *
 * const result = await checkApiRefusals({ tsconfig: "server/tsconfig.json" });
 * console.log(result.lines.join("\n"));
 * process.exit(result.ok ? 0 : 1);
 * ```
 *
 * Run it where the app runs its other build checks, or from a test: it
 * compiles the project, so it takes as long as a type check does.
 */
export const checkApiRefusals = async (options: LambderApiRefusalCheckOptions): Promise<LambderApiRefusalCheckResult> => {
    const ts = await loadTypeScriptCompiler("checkApiRefusals reads the project");
    const requireCodes = options.requireCodes ?? true;
    const requireTypedRefuse = options.requireTypedRefuse ?? true;
    const configPath = resolve(options.tsconfig);
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if(read.error) return failed(`✗ ${options.tsconfig} could not be read: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath);
    if(parsed.errors.length) return failed(`✗ ${options.tsconfig} has errors: ${parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, " ")).join("; ")}`);
    const rootNames = options.files?.map((file) => resolve(file)) ?? parsed.fileNames;
    const program = ts.createProgram({ rootNames, options: { ...parsed.options, noEmit: true, composite: false, incremental: false, declaration: false } });
    const checker = program.getTypeChecker();

    const lambderRoot = realPathOf(ts, resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));
    const ownFiles = new Map<string, boolean>();
    /** A file of the project itself: not a dependency's, not a declaration file, and not Lambder's own (its tests excepted, which are apps). */
    const isOwnFile = (sourceFile: ts.SourceFile): boolean => {
        const known = ownFiles.get(sourceFile.fileName);
        if(known !== undefined) return known;
        const path = realPathOf(ts, sourceFile.fileName);
        const own = !sourceFile.isDeclarationFile
            && !path.split(sep).includes("node_modules")
            && (!isInside(path, lambderRoot) || isInside(path, resolve(lambderRoot, "tests")));
        ownFiles.set(sourceFile.fileName, own);
        return own;
    };
    /**
     * A declaration of Lambder's: in the declaration files of any installed
     * copy (a workspace holds one per set of peer versions, and a package's
     * imports resolve to its own), or in its sources when this runs over its
     * own tests.
     */
    const isLambderDeclaration = (node: ts.Node | undefined): boolean => {
        if(!node) return false;
        const path = realPathOf(ts, node.getSourceFile().fileName);
        const parts = path.split(sep);
        if(parts.some((part, index) => part === "node_modules" && parts[index + 1] === "lambder")) return true;
        return isInside(path, lambderRoot) && !isInside(path, resolve(lambderRoot, "tests")) && !parts.slice(lambderRoot.split(sep).length).includes("node_modules");
    };
    /**
     * Whether a registration is a mock guard: `guard` read off a mock init,
     * whose builder Lambder declares in its mock entry, where a server init's
     * is declared in its own.
     */
    const isMockGuard = (call: ts.CallExpression, registration: string): boolean => {
        if(registration !== "guard" || !ts.isPropertyAccessExpression(call.expression)) return false;
        const declaration = checker.getSymbolAtLocation(call.expression.name)?.declarations?.[0];
        if(!declaration || !isLambderDeclaration(declaration)) return false;
        const path = realPathOf(ts, declaration.getSourceFile().fileName);
        const parts = path.split(sep);
        const packageAt = parts.findIndex((part, index) => part === "lambder" && parts[index - 1] === "node_modules");
        // The path inside the package: dist/mock/... installed, src/mock/... over its own sources.
        const inside = packageAt >= 0 ? parts.slice(packageAt + 1) : relative(lambderRoot, path).split(sep);
        return inside[1] === "mock";
    };
    const where = (node: ts.Node): string => {
        const sourceFile = node.getSourceFile();
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        return `${relative(process.cwd(), sourceFile.fileName)}:${line + 1}`;
    };

    // ── Raise sites ──────────────────────────────────────────────────────

    /** The string literal values of a type, or null when it is not made of string literals alone. */
    const literalsOf = (type: ts.Type): string[] | null => {
        const parts = type.isUnion() ? type.types : [type];
        const values: string[] = [];
        for(const part of parts){
            if(part.isStringLiteral()) values.push(part.value);
            else return null;
        }
        return values;
    };

    /** The code a refuse options argument names, read off its type. */
    const codeOfOptions = (argument: ts.Expression | undefined, property: "code" | "refusal", at: string): RaiseSite[] => {
        if(!argument) return [{ at, uncoded: true }];
        let optionsType = checker.getTypeAtLocation(argument);
        if(property === "refusal"){
            const refusal = checker.getPropertyOfType(optionsType, "refusal");
            if(!refusal) return [{ at, uncoded: true }];
            optionsType = checker.getTypeOfSymbolAtLocation(refusal, argument);
        }
        const code = checker.getPropertyOfType(optionsType, "code");
        if(!code) return [{ at, uncoded: true }];
        const codeType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(code, argument));
        if(codeType.flags & ts.TypeFlags.Never) return [{ at, uncoded: true }];
        const values = literalsOf(codeType);
        if(values === null) return [{ at, unreadable: true }];
        return values.map((value) => ({ at, code: value }));
    };

    /**
     * Whether a signature's declaration (one of Lambder's) is a refuse
     * function: a function type in LambderDeclaredRefuse, which types every
     * context's, guard's and init's refuse, or the type of something Lambder
     * declares as `refuse`, the free refuse() and the members an emitted
     * declaration file spells out in place of the alias. Read off the
     * declaration rather than off the call, so a refuse the app reaches under
     * a name of its own (an import renamed, a context's refuse held in a
     * variable or destructured under another name, a parameter typed as one)
     * is a raise all the same.
     */
    const isRefuseDeclaration = (declaration: ts.Declaration): boolean => {
        let node: ts.Node = declaration;
        while(ts.isTypeNode(node.parent)) node = node.parent;
        const holder = node.parent;
        if(ts.isTypeAliasDeclaration(holder)) return holder.name.text === "LambderDeclaredRefuse";
        return (ts.isVariableDeclaration(holder) || ts.isPropertySignature(holder) || ts.isPropertyDeclaration(holder))
            && holder.type === node && ts.isIdentifier(holder.name) && holder.name.text === "refuse";
    };

    /**
     * The refusal a call or construction raises, when it is one of Lambder's
     * refuse functions or its refusal class's constructor. Both are told by
     * the signature the call resolves to rather than by the name written, so
     * a refuse counts however the app names it, and the constructor counts
     * constructed as itself, as a class of the app's own that declares no
     * constructor and inherits it, or as the super() of one that declares
     * its own, which is then raised wherever that class is constructed.
     */
    const raiseSitesOf = (node: ts.CallExpression | ts.NewExpression): RaiseSite[] => {
        const constructs = ts.isNewExpression(node) || node.expression.kind === ts.SyntaxKind.SuperKeyword;
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if(!declaration || !isLambderDeclaration(declaration)) return [];
        if(constructs ? !(ts.isConstructorDeclaration(declaration) && declaration.parent.name?.text === "LambderApiRefusal") : !isRefuseDeclaration(declaration)) return [];
        const args = node.arguments ?? ts.factory.createNodeArray<ts.Expression>();
        return constructs ? codeOfOptions(args[1], "refusal", where(node)) : codeOfOptions(args[1], "code", where(node));
    };

    // ── The call graph ───────────────────────────────────────────────────

    const unwrap = (expression: ts.Expression): ts.Expression => {
        let current = expression;
        while(ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)){
            current = current.expression;
        }
        return current;
    };
    const isFunctionWithBody = (node: ts.Node): node is FunctionNode =>
        (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
            || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node)) && node.body !== undefined;

    /** The functions a declaration stands for: itself, the function it is initialized to, or a class's constructor where it is constructed. */
    const functionsOfDeclaration = (declaration: ts.Declaration, reference: ts.Identifier): FunctionNode[] => {
        if(isFunctionWithBody(declaration)) return [declaration];
        if((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer){
            const initializer = unwrap(declaration.initializer);
            return isFunctionWithBody(initializer) ? [initializer] : [];
        }
        if(ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)){
            const constructed = ts.isNewExpression(reference.parent) && reference.parent.expression === reference;
            return constructed ? declaration.members.filter((member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && member.body !== undefined) : [];
        }
        return [];
    };

    /** The functions of the project an identifier refers to, followed through an import, a shorthand property or a destructured binding. */
    const functionsReferredToBy = (reference: ts.Identifier): FunctionNode[] => {
        let symbol = checker.getSymbolAtLocation(reference);
        if(!symbol) return [];
        if(ts.isShorthandPropertyAssignment(reference.parent) && reference.parent.name === reference){
            symbol = checker.getShorthandAssignmentValueSymbol(reference.parent) ?? symbol;
        }
        if(symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const found: FunctionNode[] = [];
        for(const declaration of symbol.declarations ?? []){
            if(!isOwnFile(declaration.getSourceFile())) continue;
            if(ts.isBindingElement(declaration)){
                // `const { stamp } = await import("./stamper.js")`: the binding names no
                // function, and the type it is given does.
                for(const signature of checker.getTypeOfSymbolAtLocation(symbol, reference).getCallSignatures()){
                    if(signature.declaration && isFunctionWithBody(signature.declaration) && isOwnFile(signature.declaration.getSourceFile())) found.push(signature.declaration);
                }
                continue;
            }
            found.push(...functionsOfDeclaration(declaration, reference));
        }
        return found;
    };

    type Scanned = { raises: RaiseSite[]; reaches: FunctionNode[] };
    const scanned = new Map<ts.Node, Scanned>();
    /**
     * A function's own raise sites and the functions it refers to, or an
     * expression's (a handler written as a wrapper's call, say). A function
     * written inside it is one it reaches, since it runs as part of it.
     */
    const scan = (root: ts.Node): Scanned => {
        const known = scanned.get(root);
        if(known) return known;
        const result: Scanned = { raises: [], reaches: [] };
        const visit = (node: ts.Node): void => {
            if(node !== root && isFunctionWithBody(node)){
                result.reaches.push(node);
                return;
            }
            if(ts.isCallExpression(node) || ts.isNewExpression(node)) result.raises.push(...raiseSitesOf(node));
            if(ts.isIdentifier(node)) result.reaches.push(...functionsReferredToBy(node));
            ts.forEachChild(node, visit);
        };
        visit(root);
        scanned.set(root, result);
        return result;
    };

    /** Every raise site a handler can reach, through everything it refers to. */
    const reachOf = (handler: ts.Node): Reach => {
        const seen = new Set<ts.Node>();
        const stack: ts.Node[] = [handler];
        const raises: RaiseSite[] = [];
        let functions = 0;
        while(stack.length){
            const node = stack.pop()!;
            if(seen.has(node)) continue;
            seen.add(node);
            if(isFunctionWithBody(node)) functions += 1;
            const { raises: own, reaches } = scan(node);
            raises.push(...own);
            stack.push(...reaches);
        }
        return { raises, functions };
    };

    // ── Handlers ─────────────────────────────────────────────────────────

    /** The codes a handler's `ctx.refuse` takes, or null when its context carries no typed refuse. */
    const allowedCodesOf = (handler: ts.Node): string[] | null => {
        const contextNode = handler;
        // The type the registration expects the handler to have, which holds
        // however the handler is written (a function, one held elsewhere, a
        // wrapper's result) and whether or not it names its context. A
        // registration that takes a handler or an entry holding one expects a
        // union: the function member is the handler's. A method written in an
        // options object is read off its own type, which the registration
        // gave it.
        const expected = ts.isMethodDeclaration(handler) ? checker.getTypeAtLocation(handler) : checker.getContextualType(handler as ts.Expression);
        const members = expected?.isUnion() ? expected.types : expected ? [expected] : [];
        const parameter = members.flatMap((member) => member.getCallSignatures())[0]?.parameters[0];
        const contextType = parameter && checker.getTypeOfSymbolAtLocation(parameter, contextNode);
        const refuse = contextType && checker.getPropertyOfType(contextType, "refuse");
        if(!refuse) return null;
        const codes = new Set<string>();
        for(const signature of checker.getTypeOfSymbolAtLocation(refuse, contextNode).getCallSignatures()){
            const optionsParameter = signature.parameters[1];
            if(!optionsParameter) return null;
            const optionsType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(optionsParameter, contextNode));
            for(const part of optionsType.isUnion() ? optionsType.types : [optionsType]){
                const code = checker.getPropertyOfType(part, "code");
                if(!code) continue;
                const codeType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(code, contextNode));
                // A handler whose endpoint declares no code is handed a refuse that takes none.
                if(codeType.flags & ts.TypeFlags.Never) continue;
                const values = literalsOf(codeType);
                // A refuse whose code is any string is the untyped one: it says nothing of what the handler may send.
                if(values === null) return null;
                for(const value of values) codes.add(value);
            }
        }
        return [...codes];
    };

    /**
     * The codes an options object's `refusals` property names: one code or a
     * list, each a literal or a constant typed as one. Null where it has no
     * such property, which for a guard built without the vocabulary is the
     * difference between declaring no codes (`refusals: []`) and saying
     * nothing of what it may send.
     */
    const ownRefusalsOf = (optionsNode: ts.Expression | undefined): string[] | null => {
        const options = optionsNode && unwrap(optionsNode);
        if(!options || !ts.isObjectLiteralExpression(options)) return null;
        const property = options.properties.find((candidate) =>
            ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === "refusals");
        if(!property || !ts.isPropertyAssignment(property)) return null;
        const value = unwrap(property.initializer);
        const entries = ts.isArrayLiteralExpression(value) ? [...value.elements] : [value];
        return entries.flatMap((entry) => ts.isStringLiteralLike(entry) ? [entry.text] : literalsOf(checker.getTypeAtLocation(entry)) ?? []);
    };

    /** How a registration names its handler: `group.action` for an endpoint in a group, the key or variable it is held under otherwise, the name a mock entry is given, or the registration's own name when it is held under none. */
    const handlerNameOf = (call: ts.CallExpression, registration: string): string => {
        if(registration === "api" || registration === "override"){
            const [name] = call.arguments;
            if(name && ts.isStringLiteralLike(name)) return name.text;
        }
        const holder = call.parent;
        const key = ts.isPropertyAssignment(holder) ? holder.name.getText()
            : ts.isVariableDeclaration(holder) ? holder.name.getText() : null;
        if(registration === "defineApi" && key && ts.isPropertyAssignment(holder)){
            const group = holder.parent.parent;
            if(ts.isCallExpression(group) && group.arguments[1] === holder.parent && group.arguments[0] && ts.isStringLiteralLike(group.arguments[0])){
                return `${group.arguments[0].text}.${key}`;
            }
        }
        // Unnamed (inside an app's own wrapper, say): the finding's `at` says where.
        return key ?? registration;
    };

    const findings: LambderRefusalCheckFinding[] = [];
    const unchecked: LambderRefusalCheckFinding[] = [];
    let handlers = 0;

    const checkRegistration = (call: ts.CallExpression): void => {
        const callee = call.expression;
        const registration = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
        const form = registration ? HANDLER_REGISTRATIONS[registration] : undefined;
        if(!registration || !form) return;
        if(!isLambderDeclaration(checker.getResolvedSignature(call)?.declaration)) return;
        const [first, second] = call.arguments;
        const handlerOf = (holder: ts.Expression | undefined): ts.Node | undefined => {
            if(!holder || !ts.isObjectLiteralExpression(unwrap(holder))) return undefined;
            const property = (unwrap(holder) as ts.ObjectLiteralExpression).properties.find((candidate) => candidate.name?.getText() === "handler");
            if(!property) return undefined;
            if(ts.isPropertyAssignment(property)) return property.initializer;
            if(ts.isMethodDeclaration(property)) return property;
            if(ts.isShorthandPropertyAssignment(property)) return property.name;
            return undefined;
        };
        const handler = form === "second" ? second
            : form === "optionsHandler" ? handlerOf(first)
            : second && isFunctionWithBody(unwrap(second)) ? second : handlerOf(second) ?? second;
        const optionsNode = form === "second" ? first : form === "optionsHandler" ? first : second;
        if(!handler) return;

        const name = handlerNameOf(call, registration);
        const at = where(call);
        // A guard built without the vocabulary may send the codes its own
        // refusals option names, which is what the server checks it against.
        const allowed = allowedCodesOf(handler) ?? (registration === "guard" || registration === "lambderGuard" ? ownRefusalsOf(optionsNode) : null);
        if(allowed === null){
            unchecked.push({ handler: name, at, problem: "unchecked" });
            return;
        }
        handlers += 1;
        const { raises, functions } = reachOf(ts.isMethodDeclaration(handler) ? handler : unwrap(handler as ts.Expression));
        if(functions === 0){
            findings.push({ handler: name, at, problem: "untraced" });
            return;
        }
        const allowedSet = new Set(allowed);
        const reached = new Set<string>();
        const reported = new Set<string>();
        for(const raise of raises){
            if("code" in raise){
                if(raise.code.startsWith("lambder/")) continue;
                reached.add(raise.code);
                if(!allowedSet.has(raise.code) && !reported.has(raise.code)){
                    reported.add(raise.code);
                    findings.push({ handler: name, at, problem: "undeclared", code: raise.code, raisedAt: raise.at });
                }
            } else if("uncoded" in raise){
                if(requireCodes) findings.push({ handler: name, at, problem: "uncoded", raisedAt: raise.at });
            } else {
                findings.push({ handler: name, at, problem: "unreadable", raisedAt: raise.at });
            }
        }
        // A mock guard declares its server guard's codes, which create() holds
        // it to against guardDeclarations. Standing in for that guard it may
        // raise fewer of them, which only lets more through, so a code it
        // never raises is no declaration to trim.
        if(isMockGuard(call, registration)) return;
        for(const code of ownRefusalsOf(optionsNode) ?? []){
            if(!reached.has(code)) findings.push({ handler: name, at, problem: "unused", code });
        }
    };

    for(const sourceFile of program.getSourceFiles()){
        if(!isOwnFile(sourceFile)) continue;
        const visit = (node: ts.Node): void => {
            if(ts.isCallExpression(node)) checkRegistration(node);
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }

    // Found, or only listed where the caller lets them stand unchecked.
    if(requireTypedRefuse) findings.push(...unchecked);
    const uncheckedLine = !requireTypedRefuse && unchecked.length
        ? [`  ${unchecked.length} ${unchecked.length === 1 ? "handler has" : "handlers have"} no typed refuse to check against: ${unchecked.map(({ handler, at }) => `${handler} (${at})`).join(", ")}`]
        : [];
    if(handlers === 0){
        const nothingChecked = `✗ ${options.tsconfig}: no handler Lambder hands a typed refuse was found, so nothing was checked. Do its APIs come from an init that declares its refusals (declareRefusals), and do its files resolve lambder?`;
        return { ...failed(nothingChecked, [...findings.map(describeFinding), ...uncheckedLine]), findings };
    }
    // Duplicate uncoded or unreadable findings of one site through two paths say the same thing once.
    const unique = [...new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values()];
    const lines = [
        unique.length === 0
            ? `✓ ${handlers} handlers reach only the refusals they may send`
            // Out of every handler found, the unchecked ones among them, which are never counted as checked.
            : `✗ ${unique.length} refusal ${unique.length === 1 ? "finding" : "findings"} in ${new Set(unique.map((finding) => finding.handler)).size} of ${handlers + unchecked.length} handlers`,
        ...unique.map(describeFinding),
        ...uncheckedLine,
    ];
    return { ok: unique.length === 0, handlers, findings: unique, lines };
};

const describeFinding = (finding: LambderRefusalCheckFinding): string => {
    switch(finding.problem){
        case "undeclared": return `  ${finding.handler} (${finding.at}) can refuse with "${finding.code}" (${finding.raisedAt}), which it may not send: name it in its refusals, or keep the handler from reaching it`;
        case "unused": return `  ${finding.handler} (${finding.at}) declares "${finding.code}", which nothing it reaches raises`;
        case "uncoded": return `  ${finding.handler} (${finding.at}) can reach a refusal with no code (${finding.raisedAt})`;
        case "unreadable": return `  ${finding.handler} (${finding.at}) can reach a refusal whose code is not a string literal (${finding.raisedAt}), so which code it sends cannot be told`;
        case "untraced": return `  ${finding.handler} (${finding.at}) is handed a typed refuse, but its function cannot be found (a parameter, a dependency's value), so nothing it reaches was checked`;
        case "unchecked": return `  ${finding.handler} (${finding.at}) is handed no typed refuse, so nothing it reaches could be checked: build it from an init that declares the refusal vocabulary (declareRefusals, on initLambderMock() as on initLambder()), or give a guard a refusals option naming the codes it may send`;
    }
};

const failed = (line: string, details: string[] = []): LambderApiRefusalCheckResult => ({ ok: false, handlers: 0, findings: [], lines: [line, ...details] });

const isInside = (path: string, directory: string): boolean => path === directory || path.startsWith(directory + sep);

const realPathOf = (ts: TypeScriptModule, path: string): string => ts.sys.realpath?.(path) ?? path;
