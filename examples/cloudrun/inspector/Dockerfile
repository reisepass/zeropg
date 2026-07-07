# The CLI console image for `zeropg console --inspector` (the cloud trust
# mode). Built from the monorepo tree - the console + replica-wire code is not
# published to npm - with deploy.sh staging the subset this needs
# (package.json, package-lock.json, tsconfig.json, packages/) as the build
# context next to this Dockerfile.

# ---- build: install the workspace and compile the package dists ----
# tsx runs the CLI from TypeScript source at runtime, but the @zeropg/*
# workspace packages resolve through their package.json exports, which point
# at dist/ - so the dists must exist.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund
RUN npm run build
RUN npm prune --omit=dev

# pgweb pre-baked (editors.ts finds it on PATH), so the container never
# downloads at runtime. Cloud Build produces amd64 images.
ADD https://github.com/sosedoff/pgweb/releases/download/v0.17.0/pgweb_linux_amd64.zip /tmp/pgweb.zip
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
 && unzip /tmp/pgweb.zip -d /usr/local/bin \
 && mv /usr/local/bin/pgweb_linux_amd64 /usr/local/bin/pgweb \
 && chmod 0755 /usr/local/bin/pgweb

# ---- runtime ----
FROM node:22-slim
WORKDIR /app
# tsx globally: the runtime interpreter for the CLI's TypeScript source (the
# workspace's own tsx is a dev dependency and got pruned above).
RUN npm install -g --no-audit --no-fund tsx@4
COPY --from=build /usr/local/bin/pgweb /usr/local/bin/pgweb
COPY --from=build /app /app
ENV NODE_ENV=production
# PORT comes from Cloud Run; INSPECTOR_TOKEN and the fleet envs from service.yaml.
CMD ["tsx", "packages/cli/src/zeropg.ts", "console", "--inspector"]
