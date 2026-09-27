import * as fs from "node:fs";
import ts from "typescript";
import * as path from "node:path";

/**
 * Fails the build when the client bundle exceeds its budget.
 *
 * The design target is not the median desktop but the person on a 2 GB phone on a train, which
 * is why this is enforced rather than merely measured. Capping the syntax highlighter to a
 * handful of languages and refusing to grow the bundle are deliberate reductions in product
 * surface, taken so that a real human gets a usable page on a bad connection.
 *
 * Budgets are per-file-kind so an image cannot hide behind a small script, and the total is
 * checked because a download server asking its own users to download is a poor look.
 */
const BUDGETS = [
    { kind: "js", label: "JavaScript (any single file)", bytes: 200 * 1024 },
    { kind: "css", label: "CSS (any single file)", bytes: 60 * 1024 },
    { kind: "total", label: "all client assets combined", bytes: 300 * 1024 }
];

const publicDir = path.resolve("dist", "public");

if (!fs.existsSync(publicDir)) {
    console.error("dist/public does not exist; run `npm run build` before this check");
    process.exit(1);
}

const violations = [];
const jsFiles = [];
let total = 0;
let largestJs = 0;

function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full);
            continue;
        }
        // A published source map is both a size problem and an information disclosure.
        if (entry.name.endsWith(".map")) {
            violations.push("source map published: " + path.relative(publicDir, full));
            continue;
        }
        const size = fs.statSync(full).size;
        total += size;
        if (entry.name.endsWith(".js")) {
            jsFiles.push(full);
            largestJs = Math.max(largestJs, size);
            if (size > BUDGETS[0].bytes) {
                violations.push(
                    "JavaScript file " + path.relative(publicDir, full) + " is " + Math.round(size / 1024) + " KB"
                );
            }
        } else if (entry.name.endsWith(".css") && size > BUDGETS[1].bytes) {
            violations.push("CSS file " + path.relative(publicDir, full) + " is " + Math.round(size / 1024) + " KB");
        }
    }
}

walk(publicDir);

if (total > BUDGETS[2].bytes) {
    violations.push("total client assets are " + Math.round(total / 1024) + " KB");
}

// Syntax newer than ES6, by the year it landed. Checked with the compiler's parser rather than a
// pattern, because a regex over a minified bundle matches happily inside the string literals that
// marked.js's grammar definitions are full of - which would make this either useless or a false
// alarm, depending on the pattern.
//
// The target is declared twice, in vite.config.ts and in tsconfig.json. Neither is a guarantee on
// its own: one is a bundler setting that can be dropped, the other a checker that emits nothing.
const TOO_NEW = [
    [2016, "exponentiation operator"],
    [2017, "async/await"],
    [2018, "object rest/spread"],
    [2019, "optional catch binding"],
    [2020, "optional chaining"],
    [2020, "nullish coalescing"],
    [2020, "BigInt"],
    [2021, "logical assignment"],
    [2022, "class fields"],
    [2022, "top-level await"],
    [2023, "array findLast"]
];

function findTooNew(file) {
    const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf-8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS
    );
    const found = new Set();
    const visit = function (node) {
        if (node.kind === ts.SyntaxKind.AsyncFunction || node.kind === ts.SyntaxKind.AwaitExpression) {
            found.add(2017);
        }
        if (
            node.kind === ts.SyntaxKind.BinaryExpression &&
            node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken
        ) {
            found.add(2016);
        }
        if (node.kind === ts.SyntaxKind.PropertyAccessExpression && node.questionDotToken !== undefined) {
            found.add(2020);
        }
        if (
            node.kind === ts.SyntaxKind.BinaryExpression &&
            node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
            found.add(2020);
        }
        if (node.kind === ts.SyntaxKind.BigIntLiteral) {
            found.add(2020);
        }
        if (
            node.kind === ts.SyntaxKind.BinaryExpression &&
            (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
                node.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
                node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken)
        ) {
            found.add(2021);
        }
        if (node.kind === ts.SyntaxKind.VariableDeclaration && node.initializer !== undefined && node.questionToken) {
            found.add(2021);
        }
        if (node.kind === ts.SyntaxKind.PropertyDeclaration || node.kind === ts.SyntaxKind.PropertySignature) {
            found.add(2022);
        }
        if (
            node.kind === ts.SyntaxKind.PropertyAssignment &&
            node.name.kind === ts.SyntaxKind.Identifier &&
            node.name.escapedText === "__publicField"
        ) {
            found.add(2022);
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    return Array.from(found);
}

for (const file of jsFiles) {
    for (const year of findTooNew(file)) {
        const rule = TOO_NEW.find(function (entry) {
            return entry[0] === year;
        });
        violations.push("post-ES6 syntax (" + String(rule[1]) + ") in " + path.relative(publicDir, file));
    }
}

if (violations.length > 0) {
    console.error("Bundle budget exceeded:");
    for (const violation of violations) {
        console.error("  - " + violation);
    }
    console.error("");
    for (const budget of BUDGETS) {
        console.error("  budget: " + budget.label + " <= " + Math.round(budget.bytes / 1024) + " KB");
    }
    process.exit(1);
}

console.log(
    "Bundle budget ok: " +
        (total / 1024).toFixed(1) +
        " KB total, largest script " +
        (largestJs / 1024).toFixed(1) +
        " KB"
);
