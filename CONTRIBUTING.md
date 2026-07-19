# Contributing

Thank you for contributing to the download server.

## Getting started

1. Fork the repository and clone your fork.
2. Install Node.js 20 or later.
3. Copy `.env.example` to `.env` and fill in at least `GITHUB_TOKEN` and `APPS`.
4. Run `npm install`.

## Development workflow

- `npm run dev:public` starts the Vite dev server for frontend work.
- `npm test` runs the full test suite.
- `npm run test -- --coverage` runs tests with coverage (must be 100%).
- `npm run typecheck` runs TypeScript type checking.
- `npm run lint` runs ESLint.
- `npm run format` runs Prettier.

## Code style

- TypeScript strict mode is required.
- Use PascalCase for class names and camelCase for everything else.
- Use 4-space indentation.
- Opening braces go on the same line as the statement.
- Use double quotes for strings and mandatory semicolons.
- Avoid syntax sugar such as arrow functions, optional chaining, nullish coalescing, destructuring, spread, shorthand properties, default parameters, and computed property names.
- Every change must keep `npm run test` at 100% line and branch coverage.

## Pull request process

1. Create a feature branch from `main`.
2. Make focused, incremental commits.
3. Ensure `npm run typecheck`, `npm run lint`, and `npm run test -- --coverage` all pass.
4. Push your branch and open a pull request.
5. Wait for the GitHub Actions CI checks to pass before requesting review.

## Reporting issues

Open a GitHub issue with a clear description, reproduction steps, and the expected behavior.
