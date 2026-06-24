# airtable-on-zeropg backend: a single static Go binary. Scratch final image so
# the app container is tiny and boots near-instantly. It talks the zeropg `db`
# sidecar over localhost:5432 with default_query_exec_mode=cache_describe.
FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /airtable .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /airtable /airtable
EXPOSE 8080
ENTRYPOINT ["/airtable"]
