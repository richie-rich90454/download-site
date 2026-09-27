import * as fs from "node:fs";
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
