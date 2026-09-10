/**
 * Lint rules for the Lambder sources, tests and examples.
 *
 * The framework leans on generics hard, so the defaults that assume ordinary
 * application code are relaxed deliberately rather than silenced case by case:
 * `any` and `{}` are load-bearing in the type-level machinery (accumulator
 * defaults, variance positions), and handler arguments are routinely declared
 * for their signature and left unused. What stays on is the part that still
 * catches real mistakes: dead variables and imports, unreachable code, and the
 * rest of eslint:recommended.
 */
module.exports = {
    root: true,
    env: { es2022: true, node: true, browser: true },
    parser: "@typescript-eslint/parser",
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    plugins: ["@typescript-eslint"],
    extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
    ignorePatterns: ["dist/", "node_modules/"],
    rules: {
        // Deliberate in the type-level machinery.
        "@typescript-eslint/no-explicit-any": "off",
        "@typescript-eslint/ban-types": ["error", {
            extendDefaults: true,
            // The generic accumulator default (`_TContract extends Record<string, any> = {}`).
            types: { "{}": false },
        }],
        // Handlers declare the arguments their signature has; unused ones are
        // normal. Variables and imports are still checked.
        // A leading underscore is this codebase's marker for a declaration
        // that exists to be typechecked rather than used (`_AssertHandlerV1`).
        "@typescript-eslint/no-unused-vars": ["error", {
            args: "none",
            caughtErrors: "none",
            varsIgnorePattern: "^_",
        }],
        // Style the codebase already settled on.
        "no-extra-semi": "off",
        "@typescript-eslint/no-extra-semi": "off",
        // `catch {}` as a deliberate swallow (best-effort body parsing).
        "no-empty": ["error", { allowEmptyCatch: true }],
    },
    overrides: [
        {
            // Illustrative files that do not typecheck against a real app.
            files: ["examples/**/*.ts"],
            rules: { "@typescript-eslint/ban-ts-comment": "off" },
        },
    ],
};
