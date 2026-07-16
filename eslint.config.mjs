import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
    eslint.configs.recommended,
    tseslint.configs.recommended,
    tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            parserOptions: {
                project: "./tsconfig.eslint.json",
                tsconfigRootDir: import.meta.dirname
            }
        },
        rules: {
            "@typescript-eslint/no-explicit-any": "error",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_"
                }
            ],
            "no-restricted-syntax": [
                "error",
                {
                    selector: "ArrowFunctionExpression",
                    message: "Arrow functions are not allowed."
                },
                {
                    selector: "ChainExpression",
                    message: "Optional chaining is not allowed."
                },
                {
                    selector: "LogicalExpression[operator='??']",
                    message: "Nullish coalescing is not allowed."
                },
                {
                    selector: "ObjectPattern",
                    message: "Destructuring is not allowed."
                },
                {
                    selector: "ArrayPattern",
                    message: "Destructuring is not allowed."
                },
                {
                    selector: "SpreadElement",
                    message: "Spread syntax is not allowed."
                },
                {
                    selector: "ObjectExpression > Property[shorthand=true]",
                    message: "Shorthand properties are not allowed."
                },
                {
                    selector: "AssignmentPattern",
                    message: "Default parameters are not allowed."
                },
                {
                    selector: "ComputedPropertyName",
                    message: "Computed property names are not allowed."
                }
            ],
            "no-console": "error",
            "@typescript-eslint/require-await": "off",
            "@typescript-eslint/no-this-alias": "off"
        }
    },
    {
        files: ["src/server/main.ts"],
        rules: {
            "no-console": "off"
        }
    },
    {
        files: ["src/server/routes/*.ts"],
        rules: {
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-unnecessary-type-assertion": "off"
        }
    },
    {
        files: ["src/server/config/config.ts"],
        rules: {
            "@typescript-eslint/no-unsafe-assignment": "off"
        }
    },
    {
        files: ["tests/**/*.ts"],
        rules: {
            "@typescript-eslint/no-unsafe-assignment": "off",
            "@typescript-eslint/no-unsafe-member-access": "off",
            "@typescript-eslint/no-unsafe-call": "off",
            "@typescript-eslint/no-unsafe-return": "off",
            "@typescript-eslint/no-unsafe-argument": "off",
            "@typescript-eslint/no-misused-promises": "off",
            "@typescript-eslint/unbound-method": "off",
            "@typescript-eslint/only-throw-error": "off"
        }
    },
    {
        ignores: ["dist/**", "node_modules/**", "*.js", "*.mjs", "public/**"]
    },
    prettier
);
