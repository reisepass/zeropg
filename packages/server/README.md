# @zeropg/server

Standalone dedicated-Postgres server for zeropg: one scale-to-zero process holding the single-writer lease + PGlite + an object-storage bucket as its durable home. It exposes the real Postgres wire protocol (via `pglite-socket`), a default-on PostgREST auto-REST API, and an HTTP control face (`/wake`, `/ready`, `POST /sql`) that a remote app reaches through [`@zeropg/client`](https://www.npmjs.com/package/@zeropg/client)'s `http(s)://` engine.

Most apps don't import this directly - they `connect('https://your-instance')` with `@zeropg/client`. Use this package when you're standing up the instance itself.

## Install

```sh
npm install @zeropg/server @electric-sql/pglite @electric-sql/pglite-socket
```

`@electric-sql/pglite` and `@electric-sql/pglite-socket` are peer dependencies.

## License

MIT
