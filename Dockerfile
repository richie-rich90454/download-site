# syntax=docker/dockerfile:1

# -----------------------------
# Build stage
# -----------------------------
FROM node:20-alpine AS builder

# Install native build tools required by better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# -----------------------------
# Production stage
# -----------------------------
FROM node:20-alpine AS runner

# Install curl for the HEALTHCHECK
RUN apk add --no-cache curl

WORKDIR /app

# Ensure the cache directory is writable by the non-root user
RUN mkdir -p /app/cache && chown -R node:node /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health/live || exit 1

CMD ["npm", "run", "start"]
