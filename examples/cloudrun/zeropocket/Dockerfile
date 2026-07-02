# zeropocket — a minimal PocketBase-STYLE backend on zeropg, as a fast-booting
# single static Go binary. This is the INGRESS (app) container; the GCS-backed
# Postgres is the `db` sidecar (zeropg-db-sidecar) on 127.0.0.1:5432.
#
# WHY not fork PocketBase: PocketBase is hard-coupled to SQLite (its filter/query
# core emits SQLite JSON SQL — json_extract '$.path', json_each, iif — and its
# schema sync reads sqlite_master / runs PRAGMA). Porting that to Postgres is a
# semantic rewrite of the product's heart plus a permanent unmaintained fork
# (upstream rejects multi-dialect). So this reproduces the PocketBase PATTERN
# directly on the zeropg Postgres wire via pgx. See README.md.
#
# The single-session-wire compatibility is achieved purely via the DSN
# (default_query_exec_mode=cache_describe, pool >1) — no driver patching.
FROM golang:1.24 AS build
WORKDIR /src
COPY app/go.mod app/go.sum ./
RUN go mod download
COPY app/ ./
# Fully static, stripped, no cgo: smallest + fastest-loading binary.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /zeropocket .

# distroless static: tiny base, no shell, ~2MB OS layer => fast image pull + boot.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /zeropocket /zeropocket
EXPOSE 8080
ENTRYPOINT ["/zeropocket"]
