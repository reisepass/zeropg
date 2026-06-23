# Stage 1: pull Cal.com's REAL, untouched Prisma migrations straight out of the
# official app image. Taking them from the SAME image the app runs guarantees the
# schema is exactly what the app's bundled Prisma client expects — no version drift
# (e.g. v6.2.0's `users.disableImpersonation` column). The migrations are copied
# verbatim; nothing is patched.
FROM calcom/cal.com:latest AS calmigrations

FROM node:22-slim

WORKDIR /app

# @zeropg/client is installed from a packed tarball (run ../prepare.sh first) so
# this example works without publishing. Its peers (PGlite + the wire) are
# installed explicitly. Cal.com's schema needs NO Postgres contrib extensions
# (no citext/pgcrypto/pgvector) — verified by replaying all 588 migrations.
COPY zeropg-client-0.0.1.tgz ./
RUN npm install --no-audit --no-fund \
      ./zeropg-client-0.0.1.tgz \
      @electric-sql/pglite@^0.5 \
      @electric-sql/pglite-socket@^0.2

# Cal.com's real migrations, copied verbatim from the official app image (not modified).
COPY --from=calmigrations /calcom/packages/prisma/migrations /app/migrations

COPY server.mjs ./

EXPOSE 5432
CMD ["node", "server.mjs"]
