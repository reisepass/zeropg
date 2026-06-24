# webhookx app image for Cloud Run on zeropg + Dragonfly.
#
# webhookx (github.com/webhookx-io/webhookx) is a Go webhook gateway that needs
# PostgreSQL (>=13) + Redis (>=6.2). On zeropg the Postgres is the GCS-backed
# single-session PGlite wire (the `db` sidecar on 127.0.0.1:5432); Redis is the
# `dragonfly` sidecar on 127.0.0.1:6379.
#
# Two changes vs the upstream image:
#   1. an entrypoint that waits for the db sidecar, runs `webhookx db up`
#      (golang-migrate, idempotent), then `webhookx start`. Marker-gated so a
#      warm restart that finds the schema present skips straight to start.
#   2. nothing else patched: the single-session-wire compatibility is achieved
#      purely via the DSN (default_query_exec_mode=simple_protocol) and a pool
#      size of 1, both set as env in service.yaml. No app code changes.
ARG WEBHOOKX_REF=v1.1.0

FROM golang:1.26.2 AS build
ARG WEBHOOKX_REF
RUN git clone --depth 1 --branch "${WEBHOOKX_REF}" https://github.com/webhookx-io/webhookx.git /src
WORKDIR /src
RUN make build

FROM alpine:3.22
RUN apk add --no-cache ca-certificates bash postgresql-client curl
COPY --from=build /src/webhookx /usr/local/bin/webhookx
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
# Proxy (webhook ingress) is the Cloud Run port; admin/status stay loopback.
EXPOSE 9600
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
