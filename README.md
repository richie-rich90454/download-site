# download-server

![CI](https://github.com/rjian/download-server/actions/workflows/ci.yml/badge.svg)

SaaS-grade download server with GitHub releases, asset caching, and updater endpoints.

## Setup

1. Copy `.env.example` to `.env` and fill in your values:
    ```sh
    cp .env.example .env
    ```
2. Add a valid `GITHUB_TOKEN` and configure the `APPS` array with your repositories.
3. Install dependencies:
    ```sh
    npm install
    ```

## Development

```sh
npm run dev:public   # Vite dev server for the frontend
npm test             # Run the test suite
npm run test -- --coverage  # Run tests with coverage
npm run lint         # Run ESLint
npm run typecheck    # Run TypeScript type checking
npm run format       # Format code with Prettier
```

## Production

```sh
npm run build        # Build server and public assets
npm run start        # Run the built server
npm run prod         # Build and start in one command
```

## Configuration

See `.env.example` for all available environment variables.
