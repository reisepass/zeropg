# zeropg fleet inspector (cloud)

The console's one-click editor links, moved to the cloud: a single scale-to-zero
Cloud Run service whose URL lets you open **any fleet database in Adminer,
already logged in**, from any browser. Live-verified end to end (Playwright:
landing -> open -> data grid -> SQL query).

```
browser ──token link──► node ingress (:8080)                    adminer sidecar (:8081)
                        - token gate (403 without)              - auto-login index.php
                        - landing: fleet target list              (password supplied
                        - /open/<name>: ZeroPGReplica of that      server-side, form
                          target's bucket prefix -> loopback      auto-submitted)
                          wire :6001+ ──────────────────────────►
                        - /db/* reverse-proxy ─────────────────►
```

## Security model - read this first

- **The token is the only door.** `INSPECTOR_TOKEN` (Secret Manager) gates every
  request; the link `https://<service>/?t=<token>` IS a credential - it exposes
  read access to every listed database snapshot (including live `auth.users`
  emails). Treat it like a password; rotate by adding a new secret version and
  rolling the service.
- **Everything you open is a detached snapshot** (`ZeroPGReplica`, no lease, no
  fencing): the live services are untouched, writes land in a throwaway copy,
  re-open to refresh. Blast radius of a leaked token = data READ exposure, not
  data destruction.
- At most `INSPECTOR_MAX_OPEN` (default 3) replicas stay in memory; LRU-closed.

## Deploy / update

```bash
bash examples/cloudrun/inspector/deploy.sh
```

Builds both images (Cloud Build), mints `inspector-token` once (reuses after),
refreshes `inspector-targets` from live fleet discovery (`zeropg fleet ls`),
rolls the service, prints the ready-to-click token link. The service account
needs `roles/secretmanager.secretAccessor` on both secrets (granted once).

Get the link again later:

```bash
echo "$(gcloud run services describe zeropg-inspector --project blob-pglite --region europe-west1 --format='value(status.url)')/?t=$(gcloud secrets versions access latest --secret inspector-token --project blob-pglite)"
```

## Pieces

| path | what |
|---|---|
| `server.mjs` | ingress: token gate, landing, lazy replica-wire per target, Adminer reverse proxy |
| `Dockerfile` | node ingress image (published @zeropg npm packages - no vendoring) |
| `adminer/` | `adminer:5` + the auto-login `index.php` from `examples/editors/adminer-autologin` |
| `service.yaml` | the 2-container scale-to-zero service |
| `deploy.sh` | build + secrets + roll + print link |

## Relation to the local console

`zeropg console` gives the same one-click experience on your machine (plus
pgweb, plus read-write wires for local datadirs). The inspector is the
share-a-link/from-anywhere variant, and only ever serves snapshots.
