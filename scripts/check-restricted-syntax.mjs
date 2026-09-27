import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

/**
 * Enforces the syntax this project refuses to use.
 *
 * These used to live in ESLint as `no-restricted-syntax`, which works by matching AST selectors.
 * Oxlint deliberately has no selector-based rules - they need a query engine it does not ship - so
 * there is no way to express them in configuration. Rather than quietly drop nine rules that the
 * whole codebase is written to, they are checked here directly.
 *
 * The compiler is already a dependency, so this costs a parse of the files that were about to be
 * linted anyway and no new package. It is a checker, not a linter: it reports the constructs it
 * finds and nothing else, and oxlint remains the thing that decides whether the code is correct.
 *
 * Each entry is [test, message]. A predicate rather than a node kind, because several of these
 * constructs have no kind of their own.
 */
const BANNED = [
    [node => node.kind === ts.SyntaxKind.ArrowFunction, "Arrow functions are not allowed."],
    [node => node.kind === ts.SyntaxKind.SpreadElement, "Spread syntax is not allowed."],
    [
        // A parameter default is an `initializer` on the Parameter; AssignmentPattern is only what a
        // destructuring default desugars to.
        node => node.kind === ts.SyntaxKind.Parameter && node.initializer !== undefined,
        "Default parameters are not allowed."
    ],
    [node => node.kind === ts.SyntaxKind.AssignmentPattern, "Default parameters are not allowed."],
    [node => node.kind === ts.SyntaxKind.ComputedPropertyName, "Computed property names are not allowed."],
    [
        node => node.kind === ts.SyntaxKind.PropertyAccessExpression && node.questionDotToken !== undefined,
        "Optional chaining is not allowed."
    ],
    [
        node =>
            node.kind === ts.SyntaxKind.BinaryExpression &&
            node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken,
        "Nullish coalescing is not allowed."
    ],
    [
        node =>
            node.kind === ts.SyntaxKind.ObjectBindingPattern ||
            node.kind === ts.SyntaxKind.ArrayBindingPattern ||
            // A destructuring assignment has no binding pattern, so its left side is a plain one.
            (node.kind === ts.SyntaxKind.BinaryExpression && node.left.kind === ts.SyntaxKind.ObjectLiteralExpression),
        "Destructuring is not allowed."
    ],
    [node => node.kind === ts.SyntaxKind.ShorthandPropertyAssignment, "Shorthand properties are not allowed."]
];

const ROOTS = ["src", "tests"];
const EXTRA_FILES = ["vite.config.ts", "vitest.config.ts", "drizzle.config.ts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", "drizzle"]);

function collectFiles(target, out) {
    if (fs.statSync(target).isFile()) {
        if (target.endsWith(".ts") || target.endsWith(".mjs")) {
            out.push(target);
        }
        return;
    }
    for (const entry of fs.readdirSync(target)) {
        if (!SKIP_DIRS.has(entry)) {
            collectFiles(path.join(target, entry), out);
        }
    }
}

function checkFile(file) {
    const text = fs.readFileSync(file, "utf-8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const problems = [];
    const visit = function (node) {
        for (const rule of BANNED) {
            if (rule[0](node)) {
                const where = source.getLineAndCharacterOfPosition(node.getStart(source));
                problems.push(file + ":" + String(where.line + 1) + ":" + String(where.character + 1) + "  " + rule[1]);
            }
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    return problems;
}

const files = [];
for (const root of ROOTS) {
    if (fs.existsSync(root)) {
        collectFiles(root, files);
    }
}
for (const file of EXTRA_FILES) {
    if (fs.existsSync(file)) {
        files.push(file);
    }
}

const all = [];
for (const file of files) {
    all.push(...checkFile(file));
}

if (all.length > 0) {
    for (const problem of all) {
        console.error(problem);
    }
    console.error("\n" + String(all.length) + " restricted syntax use(s) found.");
    process.exit(1);
}

console.log("No restricted syntax. " + String(files.length) + " files checked.");
