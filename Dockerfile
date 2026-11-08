# syntax=docker/dockerfile:1

# Same Bun as `packageManager` in package.json.
ARG BUN_VERSION=1.4.4

FROM oven/bun:${BUN_VERSION}-alpine AS bun

# ---- build the web UI ----
FROM bun AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/release-parser/package.json packages/release-parser/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ---- server runtime dependencies only ----
FROM bun AS deps
WORKDIR /src
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/release-parser/package.json packages/release-parser/
RUN bun install --frozen-lockfile --production --filter @mangarr/server
COPY packages/release-parser/src packages/release-parser/src
COPY apps/server/src apps/server/src
COPY apps/server/scripts apps/server/scripts
COPY apps/server/drizzle apps/server/drizzle
COPY --from=build /src/apps/web/dist apps/web/dist

# ---- final image ----
FROM ghcr.io/linuxserver/baseimage-alpine:3.24

# set version label
ARG BUILD_DATE
ARG VERSION
LABEL build_version="mangarr version:- ${VERSION} Build-date:- ${BUILD_DATE}"
LABEL org.opencontainers.image.title="mangarr"

# environment settings
ENV CONFIG_DIR=/config \
  PORT=6262 \
  BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

RUN \
  echo "**** install packages ****" && \
  apk add -U --upgrade --no-cache \
    libgcc \
    libstdc++ && \
  printf "mangarr version: ${VERSION}\nBuild-date: ${BUILD_DATE}" > /build_version

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=deps /src /app/mangarr

# copy local files (s6-overlay services). --chmod because the exec bit is lost on Windows checkouts.
COPY --chmod=755 root/ /

# ports and volumes
EXPOSE 6262

VOLUME /config
