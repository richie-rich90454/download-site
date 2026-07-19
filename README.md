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

## Architecture Overview

The server is built on [Fastify](https://www.fastify.io/).

- **Web frontend** - A small Vite-built SPA served from `dist/public` via `@fastify/static`.
- **Release service** - Fetches GitHub releases through the `GitHubProvider` and exposes them through the API.
- **Metadata cache** - A SQLite-backed cache (`SqliteMetadataCacheService`) stores release metadata to reduce GitHub API calls.
- **Asset cache** - A disk-backed cache (`DiskAssetCacheService`) downloads, checksums, and stores release installers. A SQLite index tracks file paths, sizes, checksums, and access times.
- **Download service** - Resolves and serves assets. It uses the `PlatformDetector` to pick the best asset for a user-agent or explicit `platform` hint and supports HTTP range requests.
- **Updaters** - Dedicated services translate releases into the formats expected by popular auto-updaters:
    - `TauriUpdaterService` for Tauri v1 and v2
    - `SquirrelUpdaterService` for Squirrel.Windows
    - `SparkleUpdaterService` for Sparkle (macOS)
    - `GenericUpdaterService` for a generic JSON manifest
- **Security** - Admin endpoints require `ADMIN_API_KEY`. GitHub webhooks are verified with `WEBHOOK_SECRET`. Helmet, CORS, and rate limiting are configured by plugins.
- **Observability** - Prometheus-compatible metrics at `/metrics`, structured logging via Pino, and health/readiness/liveness probes at `/health/*`.

## Configuration

Configuration is driven by environment variables. You can also override values with a JSON file pointed to by `CONFIG_PATH`.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `PORT` | Yes | `3000` | HTTP port the server listens on. |
| `CACHE_DIR` | Yes | `./cache` | Directory for the SQLite metadata index and cached assets. |
| `APPS` | Yes | - | JSON array of `{ id, repo, name }` objects defining the apps to serve. |
| `GITHUB_TOKEN` | No | - | GitHub personal access token for higher API rate limits. |
| `GITHUB_APP_ID` | No | - | GitHub App ID for GitHub App authentication. |
| `GITHUB_PRIVATE_KEY` | No | - | PEM private key for GitHub App authentication. |
| `CONFIG_PATH` | No | - | Path to a JSON config file that overrides environment variables. |
| `LOG_LEVEL` | No | `info` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`). |
| `CORS_ORIGIN` | No | - | Allowed CORS origin. |
| `ADMIN_API_KEY` | Yes* | - | API key for admin endpoints. |
| `WEBHOOK_SECRET` | No | - | Secret used to verify GitHub release webhooks. |
| `MAX_CACHEABLE_SIZE` | No | - | Reserved for the upcoming smart-proxy threshold (bytes). Assets larger than this value will be streamed without caching. Currently unused. |

\* Required for admin endpoints to function.

## Docker Deployment

### Build and run with Docker

```sh
docker build -t download-server .

docker run -d \
  -p 3000:3000 \
  --env-file .env \
  -v ./cache:/app/cache \
  --name download-server \
  download-server
```

### Run with Docker Compose

```sh
docker compose up -d
```

The compose file mounts `./cache` on the host to `/app/cache` inside the container. The image runs as the non-root `node` user (UID 1000); ensure the host cache directory is writable by that UID, or let Docker create it on first start. Port `3000` is exposed and a `HEALTHCHECK` is configured against `/health/live`.

## Updater Integration Examples

Upload release installers together with their `.sig` signature files when the updater requires them.

### Tauri v1

```
https://your-server.com/api/update/tauri/myapp?target=x86_64-pc-windows-msvc&current_version=1.0.0
```

Response:

```json
{
    "version": "1.1.0",
    "notes": "Release notes",
    "pub_date": "2025-01-01T00:00:00Z",
    "signature": "base64-or-hex-signature",
    "url": "https://your-server.com/download/myapp?version=v1.1.0&asset=myapp_1.1.0_x64-setup.exe"
}
```

### Tauri v2

```
https://your-server.com/api/update/tauri-v2/myapp?current_version=1.0.0
```

Response includes a `platforms` map with keys such as `windows-x86_64`, `darwin-aarch64`, and `linux-x86_64`:

```json
{
    "version": "1.1.0",
    "notes": "Release notes",
    "pub_date": "2025-01-01T00:00:00Z",
    "platforms": {
        "windows-x86_64": {
            "signature": "base64-or-hex-signature",
            "url": "https://your-server.com/download/myapp?version=v1.1.0&asset=myapp_1.1.0_x64-setup.exe"
        },
        "darwin-aarch64": {
            "signature": "base64-or-hex-signature",
            "url": "https://your-server.com/download/myapp?version=v1.1.0&asset=myapp_1.1.0_aarch64.dmg"
        }
    }
}
```

### Squirrel.Windows

```
https://your-server.com/api/update/squirrel/myapp?current_version=1.0.0
```

Response:

```json
{
    "url": "https://your-server.com/download/myapp?version=v1.1.0&asset=myapp-1.1.0-full.nupkg",
    "name": "v1.1.0",
    "notes": "Release notes",
    "pub_date": "2025-01-01T00:00:00Z"
}
```

### Sparkle (macOS)

```
https://your-server.com/api/update/sparkle/myapp?current_version=1.0.0
```

Returns an RSS appcast XML feed with `enclosure` entries for Intel and Apple Silicon macOS builds. Configure this URL as the appcast feed in your `.app` bundle or `Info.plist`.

### Generic JSON

```
https://your-server.com/api/update/generic/myapp?current_version=1.0.0
```

Response:

```json
{
    "version": "1.1.0",
    "notes": "Release notes",
    "pubDate": "2025-01-01T00:00:00Z",
    "platforms": {
        "windows_x64": {
            "signature": "base64-or-hex-signature",
            "url": "https://your-server.com/download/myapp?version=v1.1.0&asset=myapp_1.1.0_x64-setup.exe"
        },
        "darwin_arm64": {
            "signature": "base64-or-hex-signature",
            "url": "https://your-server.com/download/myapp?version=v1.1.0&asset=myapp_1.1.0_aarch64.dmg"
        },
        "linux_x64": {
            "signature": "base64-or-hex-signature",
            "url": "https://your-server.com/download/myapp?version=v1.1.0&asset=myapp_1.1.0_x86_64.AppImage"
        }
    }
}
```

## API Endpoint Summary

| Method | Path | Description | Auth |
| --- | --- | --- | --- |
| GET | `/health` | Overall health status. | None |
| GET | `/health/ready` | Readiness probe. Returns 503 when not ready. | None |
| GET | `/health/live` | Liveness probe. | None |
| GET | `/api/apps` | List configured applications. | None |
| GET | `/api/releases/:app` | List releases for an app. | None |
| GET | `/api/update/:app` | Default update payload with release metadata and asset links. | None |
| GET | `/api/update/tauri/:app` | Tauri v1 updater endpoint. | None |
| GET | `/api/update/tauri-v2/:app` | Tauri v2 updater endpoint. | None |
| GET | `/api/update/generic/:app` | Generic JSON updater endpoint. | None |
| GET | `/api/update/squirrel/:app` | Squirrel.Windows updater endpoint. | None |
| GET | `/api/update/sparkle/:app` | Sparkle appcast XML endpoint. | None |
| GET | `/download/:app` | Download the best-matching asset. | None |
| POST | `/admin/cache/purge` | Purge metadata and/or asset cache. | `ADMIN_API_KEY` |
| POST | `/admin/cache/refresh` | Refresh metadata cache from GitHub. | `ADMIN_API_KEY` |
| POST | `/admin/assets/redownload` | Purge and redownload cached assets. | `ADMIN_API_KEY` |
| POST | `/webhooks/github/release` | Receive GitHub release webhooks. | `WEBHOOK_SECRET` |
| GET | `/metrics` | Prometheus-compatible metrics. | None |
| GET | `/` | Web frontend (serves `index.html` for non-API routes). | None |

See `.env.example` for all available environment variables.
