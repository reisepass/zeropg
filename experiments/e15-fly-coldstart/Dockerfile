# E15 image. Same base and same runtime deps as experiments/e11-fly-baseline so
# the cold-start numbers are comparable to E11's; the only additions are the
# tracer entry point and the observation face.
#
# node:22-slim, not alpine, and deliberately: PGlite ships a glibc-linked native
# build, and swapping to musl would change what is being measured from "Fly cold
# start" to "does PGlite work on musl". Image size is experiment 3's question,
# and it gets its own variant rather than contaminating the baseline.
FROM node:22-slim

WORKDIR /app

COPY image-package.json package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY dist/server.mjs ./server.mjs
COPY dist/boot-trace.mjs ./boot-trace.mjs
COPY dist/seed.tar.gz ./seed.tar.gz

ENV NODE_ENV=production
ENV PORT=8080
ENV ZEROPG_POSTGREST=off
EXPOSE 8080
EXPOSE 8081
EXPOSE 5432

# boot-trace.mjs is prebind.mjs plus timestamps: it owns public 5432 from the
# first tick and parks clients through the restore, and it stamps every phase
# boundary against the kernel clock, the Node timing origin and the wall clock.
CMD ["node", "boot-trace.mjs"]
