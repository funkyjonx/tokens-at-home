FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

# Install build deps for better-sqlite3 (native module)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace manifests first for better layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/coordinator/package.json ./packages/coordinator/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/coordinator ./packages/coordinator

# Build shared first, then coordinator
RUN pnpm --filter @tah/shared build
RUN pnpm --filter @tah/coordinator build

# ---- runtime image ----
FROM node:22-slim AS runtime
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/coordinator/package.json ./packages/coordinator/

# Production deps only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=base /app/packages/shared/dist ./packages/shared/dist
COPY --from=base /app/packages/coordinator/dist ./packages/coordinator/dist

EXPOSE 3000

ENV PORT=3000
ENV DATABASE_URL=/data/tah.db
ENV NODE_ENV=production

CMD ["node", "packages/coordinator/dist/index.js"]
