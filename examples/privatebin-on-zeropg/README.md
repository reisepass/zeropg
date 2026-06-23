# PrivateBin on zeropg — swap Postgres for zeropg with no app patch

Proof that the **real, unmodified [PrivateBin](https://github.com/PrivateBin/PrivateBin)** (the official `privatebin/nginx-fpm-alpine` image, a PHP-FPM pastebin) can store its pastes in **zeropg** (PGlite exposed over the real Postgres wire) instead of a Postgres server — changing only Docker config, never PrivateBin's source.

PrivateBin talks to its DB through PHP's `pdo_pgsql` driver (libpq). This example proves that driver speaks fine to `pglite-socket` — the open question going in, now answered: **yes**.

## What changed vs. stock PrivateBin docker

Exactly two things, both config — zero source patches and the app image is the official one, untouched:

1. A **`zeropg-db`** service replaces a `postgres:*` server. It runs `@zeropg/client`'s `serveWire` (PGlite on a Docker volume, served over the Postgres wire via `pglite-socket`). **No contrib extensions** are loaded: PrivateBin's schema is plain `CHAR/TEXT/INT` with one index — stock PGlite handles all of it.
2. `cfg/conf.php` points PrivateBin's **Database (PDO) model** at `zeropg-db` instead of the default Filesystem model:

   ```ini
   [model]
   class = Database
   [model_options]
   dsn = "pgsql:host=zeropg-db;port=5432;dbname=privatebin"
   tbl = "privatebin_"
   usr = "postgres"
   pwd = "postgres"
   ```

PrivateBin **auto-creates its own tables** (`privatebin_paste`, `privatebin_comment`, `privatebin_config`) on first connection — there is no migration step. (`PDO::ATTR_PERSISTENT` is left off so each request opens a fresh connection to the single-session wire.)

## Run it

```sh
./prepare.sh                                          # refresh the packed @zeropg/client (tarball is also committed)
docker compose -p privatebin-zeropg up -d --build     # app on :3104, zeropg-db on :5464
# open http://localhost:3104
```

## Verify end-to-end (browser round-trip + read the zeropg row)

```sh
# from the zeropg repo root (test resolves screenshot paths there):
node examples/privatebin-on-zeropg/test/verify.mjs
```

The test: types a unique secret into PrivateBin's real UI, clicks Send, captures the paste URL, opens it in a **fresh page**, asserts the decrypted text matches, then connects to `zeropg-db` on `127.0.0.1:5464` with a `pg` client and shows the stored (encrypted) row and that the paste count grew.

## Verified result

```
paste rows before: 0
paste URL: http://localhost:3104/?2e3b15ffc932fd8e#Gs3xTLGQ2i7ztXrwkWsVJ6eZWvBHcQiiMfA6c21JBErB
round-trip decrypted contains secret: true
5xx (create): none
5xx (read): none

zeropg public tables: privatebin_comment, privatebin_config, privatebin_paste
paste rows after: 1 (delta 1)
newest stored paste row: {"dataid":"2e3b15ffc932fd8e","data_head":"{\"adata\":[[\"zin5vZ1kg...\",\"aes\",\"gcm\"","data_len":768,"expiredate":1782823740}

RESULT: PASS — paste round-tripped through zeropg
```

PrivateBin created its schema, encrypted the paste client-side (AES-GCM — the stored `data` is opaque ciphertext, as designed), persisted it through `pdo_pgsql` → `pglite-socket` → PGlite, and read it back. No app source was touched.

## Notes / caveats

- **Single-session PGlite:** concurrent requests serialize through one writer. Fine for self-host / small instances; graduating to a managed Postgres is a `dsn` change in `conf.php`.
- The `zeropg-db` image installs `@zeropg/client` from a packed tarball (`prepare.sh`) so the example builds without the package being published to npm.
- PrivateBin's encryption is entirely client-side, so zeropg only ever sees ciphertext — exactly the property you want for the storage layer.
```
