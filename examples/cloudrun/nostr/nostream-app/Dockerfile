# nostream (the Node nostr relay) built from source for Cloud Run.
#
# This is nostream's own multi-stage Dockerfile, plus ONE addition: we seed
# /app/.nostr/settings.yaml from the bundled defaults. nostream's
# SettingsStatic.watchSettings() does fs.watch() on $NOSTR_CONFIG_DIR/settings.yaml
# and crashes if the file is missing (createSettings never actually writes it on a
# fresh dir), so the file MUST exist before boot.
ARG PNPM_VERSION=10.33.0
ARG NOSTREAM_REF=main

FROM node:24-alpine AS build
ARG PNPM_VERSION
ARG NOSTREAM_REF
RUN apk add --no-cache git
WORKDIR /build
RUN git clone --depth 1 --branch "$NOSTREAM_REF" https://github.com/cameri/nostream . \
 && corepack enable && corepack prepare pnpm@$PNPM_VERSION --activate \
 && pnpm install --frozen-lockfile --silent \
 && pnpm build

FROM node:24-alpine
ARG PNPM_VERSION
WORKDIR /app
RUN apk add --no-cache --update git
COPY --from=build /build/resources /app/resources
COPY --from=build /build/dist .
COPY --from=build /build/package.json /build/pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@$PNPM_VERSION --activate \
 && pnpm install --prod --frozen-lockfile --silent

# Seed the settings file the watcher requires. NOSTR_CONFIG_DIR defaults to
# /app/.nostr (cwd/.nostr). Make it owned by node so reloads can write.
RUN mkdir -p /app/.nostr \
 && cp /app/resources/default-settings.yaml /app/.nostr/settings.yaml \
 && chown -R node:node /app/.nostr

ENV NODE_ENV=production
ENV NOSTR_CONFIG_DIR=/app/.nostr
USER node:node
CMD ["node", "src/index.js"]
