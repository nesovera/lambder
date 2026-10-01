import { dirname, relative, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { loadTypeScriptCompiler } from "./loadTypeScriptCompiler.js";
/** The registrations whose handler Lambder types a refuse for, by the name they are called under, and where each one's handler is. */
const HANDLER_REGISTRATIONS = {
    defineApi: "second",
    guard: "optionsHandler",
    lambderGuard: "optionsHandler",
    api: "secondOrItsHandler",
    override: "secondOrItsHandler",
};
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
export const checkApiRefusals = async (options) => {
    const ts = await loadTypeScriptCompiler("checkApiRefusals reads the project");
    const requireCodes = options.requireCodes ?? true;
    const configPath = resolve(options.tsconfig);
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error)
        return failed(`✗ ${options.tsconfig} could not be read: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath), undefined, configPath);
    if (parsed.errors.length)
        return failed(`✗ ${options.tsconfig} has errors: ${parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, " ")).join("; ")}`);
    const rootNames = options.files?.map((file) => resolve(file)) ?? parsed.fileNames;
    const program = ts.createProgram({ rootNames, options: { ...parsed.options, noEmit: true, composite: false, incremental: false, declaration: false } });
    const checker = program.getTypeChecker();
    const lambderRoot = realPathOf(ts, resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));
    const ownFiles = new Map();
    /** A file of the project itself: not a dependency's, not a declaration file, and not Lambder's own (its tests excepted, which are apps). */
    const isOwnFile = (sourceFile) => {
        const known = ownFiles.get(sourceFile.fileName);
        if (known !== undefined)
            return known;
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
    const isLambderDeclaration = (node) => {
        if (!node)
            return false;
        const path = realPathOf(ts, node.getSourceFile().fileName);
        const parts = path.split(sep);
        if (parts.some((part, index) => part === "node_modules" && parts[index + 1] === "lambder"))
            return true;
        return isInside(path, lambderRoot) && !isInside(path, resolve(lambderRoot, "tests")) && !parts.slice(lambderRoot.split(sep).length).includes("node_modules");
    };
    const where = (node) => {
        const sourceFile = node.getSourceFile();
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        return `${relative(process.cwd(), sourceFile.fileName)}:${line + 1}`;
    };
    // ── Raise sites ──────────────────────────────────────────────────────
    /** The string literal values of a type, or null when it is not made of string literals alone. */
    const literalsOf = (type) => {
        const parts = type.isUnion() ? type.types : [type];
        const values = [];
        for (const part of parts) {
            if (part.isStringLiteral())
                values.push(part.value);
            else
                return null;
        }
        return values;
    };
    /** The code a refuse options argument names, read off its type. */
    const codeOfOptions = (argument, property, at) => {
        if (!argument)
            return [{ at, uncoded: true }];
        let optionsType = checker.getTypeAtLocation(argument);
        if (property === "refusal") {
            const refusal = checker.getPropertyOfType(optionsType, "refusal");
            if (!refusal)
                return [{ at, uncoded: true }];
            optionsType = checker.getTypeOfSymbolAtLocation(refusal, argument);
        }
        const code = checker.getPropertyOfType(optionsType, "code");
        if (!code)
            return [{ at, uncoded: true }];
        const codeType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(code, argument));
        if (codeType.flags & ts.TypeFlags.Never)
            return [{ at, uncoded: true }];
        const values = literalsOf(codeType);
        if (values === null)
            return [{ at, unreadable: true }];
        return values.map((value) => ({ at, code: value }));
    };
    /**
     * The refusal a call or construction raises, when it is one of Lambder's
     * refuse functions or its refusal class's constructor. The constructor is
     * told by the signature the call resolves to rather than by the name
     * written, so it counts constructed as itself, as a class of the app's
     * own that declares no constructor and inherits it, or as the super() of
     * one that declares its own, which is then raised wherever that class is
     * constructed.
     */
    const raiseSitesOf = (node) => {
        const callee = node.expression;
        const constructs = ts.isNewExpression(node) || callee.kind === ts.SyntaxKind.SuperKeyword;
        if (!constructs) {
            const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
            if (name !== "refuse")
                return [];
        }
        const declaration = checker.getResolvedSignature(node)?.declaration;
        if (!isLambderDeclaration(declaration))
            return [];
        if (constructs && !(declaration && ts.isConstructorDeclaration(declaration) && declaration.parent.name?.text === "LambderApiRefusal"))
            return [];
        const args = node.arguments ?? ts.factory.createNodeArray();
        return constructs ? codeOfOptions(args[1], "refusal", where(node)) : codeOfOptions(args[1], "code", where(node));
    };
    // ── The call graph ───────────────────────────────────────────────────
    const unwrap = (expression) => {
        let current = expression;
        while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) {
            current = current.expression;
        }
        return current;
    };
    const isFunctionWithBody = (node) => (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
        || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node)) && node.body !== undefined;
    /** The functions a declaration stands for: itself, the function it is initialized to, or a class's constructor where it is constructed. */
    const functionsOfDeclaration = (declaration, reference) => {
        if (isFunctionWithBody(declaration))
            return [declaration];
        if ((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer) {
            const initializer = unwrap(declaration.initializer);
            return isFunctionWithBody(initializer) ? [initializer] : [];
        }
        if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
            const constructed = ts.isNewExpression(reference.parent) && reference.parent.expression === reference;
            return constructed ? declaration.members.filter((member) => ts.isConstructorDeclaration(member) && member.body !== undefined) : [];
        }
        return [];
    };
    /** The functions of the project an identifier refers to, followed through an import, a shorthand property or a destructured binding. */
    const functionsReferredToBy = (reference) => {
        let symbol = checker.getSymbolAtLocation(reference);
        if (!symbol)
            return [];
        if (ts.isShorthandPropertyAssignment(reference.parent) && reference.parent.name === reference) {
            symbol = checker.getShorthandAssignmentValueSymbol(reference.parent) ?? symbol;
        }
        if (symbol.flags & ts.SymbolFlags.Alias)
            symbol = checker.getAliasedSymbol(symbol);
        const found = [];
        for (const declaration of symbol.declarations ?? []) {
            if (!isOwnFile(declaration.getSourceFile()))
                continue;
            if (ts.isBindingElement(declaration)) {
                // `const { stamp } = await import("./stamper.js")`: the binding names no
                // function, and the type it is given does.
                for (const signature of checker.getTypeOfSymbolAtLocation(symbol, reference).getCallSignatures()) {
                    if (signature.declaration && isFunctionWithBody(signature.declaration) && isOwnFile(signature.declaration.getSourceFile()))
                        found.push(signature.declaration);
                }
                continue;
            }
            found.push(...functionsOfDeclaration(declaration, reference));
        }
        return found;
    };
    const scanned = new Map();
    /**
     * A function's own raise sites and the functions it refers to, or an
     * expression's (a handler written as a wrapper's call, say). A function
     * written inside it is one it reaches, since it runs as part of it.
     */
    const scan = (root) => {
        const known = scanned.get(root);
        if (known)
            return known;
        const result = { raises: [], reaches: [] };
        const visit = (node) => {
            if (node !== root && isFunctionWithBody(node)) {
                result.reaches.push(node);
                return;
            }
            if (ts.isCallExpression(node) || ts.isNewExpression(node))
                result.raises.push(...raiseSitesOf(node));
            if (ts.isIdentifier(node))
                result.reaches.push(...functionsReferredToBy(node));
            ts.forEachChild(node, visit);
        };
        visit(root);
        scanned.set(root, result);
        return result;
    };
    /** Every raise site a handler can reach, through everything it refers to. */
    const reachOf = (handler) => {
        const seen = new Set();
        const stack = [handler];
        const raises = [];
        let functions = 0;
        while (stack.length) {
            const node = stack.pop();
            if (seen.has(node))
                continue;
            seen.add(node);
            if (isFunctionWithBody(node))
                functions += 1;
            const { raises: own, reaches } = scan(node);
            raises.push(...own);
            stack.push(...reaches);
        }
        return { raises, functions };
    };
    // ── Handlers ─────────────────────────────────────────────────────────
    /** The codes a handler's `ctx.refuse` takes, or null when its context carries no typed refuse. */
    const allowedCodesOf = (handler) => {
        const contextNode = handler;
        // The type the registration expects the handler to have, which holds
        // however the handler is written (a function, one held elsewhere, a
        // wrapper's result) and whether or not it names its context. A
        // registration that takes a handler or an entry holding one expects a
        // union: the function member is the handler's. A method written in an
        // options object is read off its own type, which the registration
        // gave it.
        const expected = ts.isMethodDeclaration(handler) ? checker.getTypeAtLocation(handler) : checker.getContextualType(handler);
        const members = expected?.isUnion() ? expected.types : expected ? [expected] : [];
        const parameter = members.flatMap((member) => member.getCallSignatures())[0]?.parameters[0];
        const contextType = parameter && checker.getTypeOfSymbolAtLocation(parameter, contextNode);
        const refuse = contextType && checker.getPropertyOfType(contextType, "refuse");
        if (!refuse)
            return null;
        const codes = new Set();
        for (const signature of checker.getTypeOfSymbolAtLocation(refuse, contextNode).getCallSignatures()) {
            const optionsParameter = signature.parameters[1];
            if (!optionsParameter)
                return null;
            const optionsType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(optionsParameter, contextNode));
            for (const part of optionsType.isUnion() ? optionsType.types : [optionsType]) {
                const code = checker.getPropertyOfType(part, "code");
                if (!code)
                    continue;
                const codeType = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(code, contextNode));
                // A handler whose endpoint declares no code is handed a refuse that takes none.
                if (codeType.flags & ts.TypeFlags.Never)
                    continue;
                const values = literalsOf(codeType);
                // A refuse whose code is any string is the untyped one: it says nothing of what the handler may send.
                if (values === null)
                    return null;
                for (const value of values)
                    codes.add(value);
            }
        }
        return [...codes];
    };
    /** The codes an options object's `refusals` property names: one code or a list, each a literal or a constant typed as one. */
    const ownRefusalsOf = (optionsNode) => {
        const options = optionsNode && unwrap(optionsNode);
        if (!options || !ts.isObjectLiteralExpression(options))
            return [];
        const property = options.properties.find((candidate) => ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === "refusals");
        if (!property || !ts.isPropertyAssignment(property))
            return [];
        const value = unwrap(property.initializer);
        const entries = ts.isArrayLiteralExpression(value) ? [...value.elements] : [value];
        return entries.flatMap((entry) => ts.isStringLiteralLike(entry) ? [entry.text] : literalsOf(checker.getTypeAtLocation(entry)) ?? []);
    };
    /** How a registration names its handler: `group.action` for an endpoint in a group, the key or variable it is held under otherwise, the name a mock entry is given, or the registration's own name when it is held under none. */
    const handlerNameOf = (call, registration) => {
        if (registration === "api" || registration === "override") {
            const [name] = call.arguments;
            if (name && ts.isStringLiteralLike(name))
                return name.text;
        }
        const holder = call.parent;
        const key = ts.isPropertyAssignment(holder) ? holder.name.getText()
            : ts.isVariableDeclaration(holder) ? holder.name.getText() : null;
        if (registration === "defineApi" && key && ts.isPropertyAssignment(holder)) {
            const group = holder.parent.parent;
            if (ts.isCallExpression(group) && group.arguments[1] === holder.parent && group.arguments[0] && ts.isStringLiteralLike(group.arguments[0])) {
                return `${group.arguments[0].text}.${key}`;
            }
        }
        // Unnamed (inside an app's own wrapper, say): the finding's `at` says where.
        return key ?? registration;
    };
    const findings = [];
    const unchecked = [];
    let handlers = 0;
    const checkRegistration = (call) => {
        const callee = call.expression;
        const registration = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
        const form = registration ? HANDLER_REGISTRATIONS[registration] : undefined;
        if (!registration || !form)
            return;
        if (!isLambderDeclaration(checker.getResolvedSignature(call)?.declaration))
            return;
        const [first, second] = call.arguments;
        const handlerOf = (holder) => {
            if (!holder || !ts.isObjectLiteralExpression(unwrap(holder)))
                return undefined;
            const property = unwrap(holder).properties.find((candidate) => candidate.name?.getText() === "handler");
            if (!property)
                return undefined;
            if (ts.isPropertyAssignment(property))
                return property.initializer;
            if (ts.isMethodDeclaration(property))
                return property;
            if (ts.isShorthandPropertyAssignment(property))
                return property.name;
            return undefined;
        };
        const handler = form === "second" ? second
            : form === "optionsHandler" ? handlerOf(first)
                : second && isFunctionWithBody(unwrap(second)) ? second : handlerOf(second) ?? second;
        const optionsNode = form === "second" ? first : form === "optionsHandler" ? first : second;
        if (!handler)
            return;
        const name = handlerNameOf(call, registration);
        const at = where(call);
        const allowed = allowedCodesOf(handler) ?? (registration === "guard" || registration === "lambderGuard" ? ownRefusalsOfOrNull(optionsNode) : null);
        if (allowed === null) {
            unchecked.push(`${name} (${at})`);
            return;
        }
        handlers += 1;
        const { raises, functions } = reachOf(ts.isMethodDeclaration(handler) ? handler : unwrap(handler));
        if (functions === 0) {
            findings.push({ handler: name, at, problem: "untraced" });
            return;
        }
        const allowedSet = new Set(allowed);
        const reached = new Set();
        const reported = new Set();
        for (const raise of raises) {
            if ("code" in raise) {
                if (raise.code.startsWith("lambder/"))
                    continue;
                reached.add(raise.code);
                if (!allowedSet.has(raise.code) && !reported.has(raise.code)) {
                    reported.add(raise.code);
                    findings.push({ handler: name, at, problem: "undeclared", code: raise.code, raisedAt: raise.at });
                }
            }
            else if ("uncoded" in raise) {
                if (requireCodes)
                    findings.push({ handler: name, at, problem: "uncoded", raisedAt: raise.at });
            }
            else {
                findings.push({ handler: name, at, problem: "unreadable", raisedAt: raise.at });
            }
        }
        for (const code of ownRefusalsOf(optionsNode)) {
            if (!reached.has(code))
                findings.push({ handler: name, at, problem: "unused", code });
        }
    };
    /** A guard's `refusals` option, or null when it has none: what a guard built without the vocabulary may send. */
    const ownRefusalsOfOrNull = (optionsNode) => {
        const own = ownRefusalsOf(optionsNode);
        return own.length ? own : null;
    };
    for (const sourceFile of program.getSourceFiles()) {
        if (!isOwnFile(sourceFile))
            continue;
        const visit = (node) => {
            if (ts.isCallExpression(node))
                checkRegistration(node);
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }
    const uncheckedLine = unchecked.length ? [`  ${unchecked.length} ${unchecked.length === 1 ? "handler has" : "handlers have"} no typed refuse to check against: ${unchecked.join(", ")}`] : [];
    if (handlers === 0) {
        return failed(`✗ ${options.tsconfig}: no handler Lambder hands a typed refuse was found, so nothing was checked. Do its APIs come from an init that declares its refusals (declareRefusals), and do its files resolve lambder?`, uncheckedLine);
    }
    // Duplicate uncoded or unreadable findings of one site through two paths say the same thing once.
    const unique = [...new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values()];
    const lines = [
        unique.length === 0
            ? `✓ ${handlers} handlers reach only the refusals they may send`
            : `✗ ${unique.length} refusal ${unique.length === 1 ? "finding" : "findings"} in ${new Set(unique.map((finding) => finding.handler)).size} of ${handlers} handlers`,
        ...unique.map(describeFinding),
        ...uncheckedLine,
    ];
    return { ok: unique.length === 0, handlers, findings: unique, lines };
};
const describeFinding = (finding) => {
    switch (finding.problem) {
        case "undeclared": return `  ${finding.handler} (${finding.at}) can refuse with "${finding.code}" (${finding.raisedAt}), which it may not send: name it in its refusals, or keep the handler from reaching it`;
        case "unused": return `  ${finding.handler} (${finding.at}) declares "${finding.code}", which nothing it reaches raises`;
        case "uncoded": return `  ${finding.handler} (${finding.at}) can reach a refusal with no code (${finding.raisedAt})`;
        case "unreadable": return `  ${finding.handler} (${finding.at}) can reach a refusal whose code is not a string literal (${finding.raisedAt}), so which code it sends cannot be told`;
        case "untraced": return `  ${finding.handler} (${finding.at}) is handed a typed refuse, but its function cannot be found (a parameter, a dependency's value), so nothing it reaches was checked`;
    }
};
const failed = (line, details = []) => ({ ok: false, handlers: 0, findings: [], lines: [line, ...details] });
const isInside = (path, directory) => path === directory || path.startsWith(directory + sep);
const realPathOf = (ts, path) => ts.sys.realpath?.(path) ?? path;
