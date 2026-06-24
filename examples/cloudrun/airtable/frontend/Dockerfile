# airtable-on-zeropg frontend: a tiny static-SPA service. A single Go binary
# serves index.html/app.js and synthesises /config.js from AIRTABLE_API, so the
# image points at any backend with no rebuild. This is its OWN Cloud Run service,
# separate from the backend, so the shell renders instantly while the backend
# cold-starts behind user think-time. At entrypoint it also fires a server-side
# wake at the backend (see entrypoint.sh).
FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod ./
COPY server.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /frontend .

FROM alpine:3.22
RUN apk add --no-cache wget
COPY --from=build /frontend /frontend
COPY index.html app.js /app/static/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENV STATIC_DIR=/app/static
EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
