# zeropg fleet inspector (cloud) = `zeropg console --inspector`

The cloud trust mode of the console: a single scale-to-zero Cloud Run service
whose URL lets you open **any fleet database in Adminer or pgweb, already
logged in**, from any browser. There is no separate inspector app anymore -
this directory only holds the deploy artifacts; the code is the console itself
(`packages/cli/src/console/`), running with `--inspector`.

```
browser ──token link──► zeropg console --inspector (:8080)       adminer sidecar (:8081)
                        - bearer token gate (auth.ts, 403 without)  - auto-login index.php
                        - landing: LIVE fleet discovery               (password supplied
                        - /open/<name>: ZeroPGReplica of that          server-side, form
                          target's bucket prefix -> loopback wire      auto-submitted)
                        - /db/* reverse-proxy ─────────────────────►
                        - /pgweb/open/<name> + /pgweb/* proxy: pgweb
                          (pre-baked binary) pinned to the same wire
                        - /livez (tokenless, startup probe)
```

## One codebase, two trust modes

| | `zeropg console` (default) | `zeropg console --inspector` |
|---|---|---|
| bind | 127.0.0.1, refuses to widen | 0.0.0.0 (behind Cloud Run ingress) |
| auth | none - the machine boundary | bearer token (INSPECTOR_TOKEN required to start) |
| targets | live discovery + local datadirs | live discovery only |
| powers | read-WRITE local wires, studio, wake, export | detached snapshots ONLY |

The pruning is **structural**: `inspector.ts` never imports the console's
serve/localdbs/probe machinery, so the write/wake/export/serve-local/studio
routes do not exist in inspector mode (grep-provable; modes.test.mjs checks
it). This keeps the closing rule of docs/EDITOR-AUTH-SECURITY.md by
construction: never write access behind a shared link.

## Security model - read this first

- **The token is the only door.** `INSPECTOR_TOKEN` (Secret Manager) gates every
  request; the link `https://<service>/?t=<token>` IS a credential - it exposes
  read access to every discovered database snapshot (including live
  `auth.users` emails). Treat it like a password; rotate by adding a new secret
  version and rolling the service.
- **Everything you open is a detached snapshot** (`ZeroPGReplica`, no lease, no
  fencing): the live services are untouched, writes land in a throwaway copy,
  re-open to refresh. Blast radius of a leaked token = data READ exposure, not
  data destruction.
- At most `INSPECTOR_MAX_OPEN` (default 3) replicas stay in memory; LRU-closed.

## Discovery: live, with an env fallback

Targets come from **live fleet discovery** inside the service - the same
`listInstances` scan the CLI uses, authenticated by the runtime service
account's ADC. `ZEROPG_FLEET_PROJECT`/`ZEROPG_FLEET_REGION` (service.yaml)
name where to look. The old `inspector-targets` secret is gone; if discovery
ever fails (API outage, missing IAM), set `INSPECTOR_TARGETS` env JSON
(`[{"name","prefix","bucket"?}]`, bucket defaulting to `ZEROPG_BUCKET`) as a
manual fallback - the landing page says loudly when it is serving the
fallback list.

## Deploy / update

```bash
bash examples/cloudrun/inspector/deploy.sh
```

Stages the monorepo subset (the console code is not published to npm), builds
both images (Cloud Build), mints `inspector-token` once (reuses after), rolls
the service pinned by image digest (`services replace` with `:latest` does NOT
roll a revision), prints the ready-to-click token link. The service account
needs `roles/secretmanager.secretAccessor` on `inspector-token` and
`roles/run.viewer` (list services) for discovery.

Get the link again later:

```bash
echo "$(gcloud run services describe zeropg-inspector --project blob-pglite --region europe-west1 --format='value(status.url)')/?t=$(gcloud secrets versions access latest --secret inspector-token --project blob-pglite)"
```

## Pieces

| path | what |
|---|---|
| `Dockerfile` | the CLI console image: monorepo build + pre-baked pgweb binary, runs `zeropg console --inspector` via tsx |
| `adminer/` | `adminer:5` + the auto-login `index.php` from `examples/editors/adminer-autologin` |
| `service.yaml` | the 2-container scale-to-zero service |
| `deploy.sh` | stage context + build + token secret + digest-pinned roll + print link |
| `test/modes.test.mjs` | structural pruning + token gate + both modes over HTTP |
| `test/replica.test.mjs` | /open path against the real bucket (needs ADC) |
| `test/live-verify.mjs` | Playwright flow against the deployed service |

The code itself lives in `packages/cli/src/console/`: `inspector.ts` (the
mode), `auth.ts` (none/bearer middleware, designed for a future per-link HMAC
mode), `discovery.ts` (shared live discovery), `replica-wire.mjs` (the one
snapshot-wire implementation), `editors.ts` (pgweb launcher, used by both
modes).

## Relation to the local console

`zeropg console` gives the same one-click experience on your machine (plus
read-write wires for local datadirs, studio, wake, export). The inspector is
the share-a-link/from-anywhere variant, and only ever serves snapshots.
