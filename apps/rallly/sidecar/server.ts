// zeropg-sidecar entry point: a standalone PGlite + wire server (no demo UI).
// Exposes:
//   :5432  — Postgres wire protocol (loopback only, consumed by the app sidecar)
//   :8080  — HTTP control face: /ready (200 when up, 503 while restoring),
//             /up, /metrics, POST /sql — used by Cloud Run startup probe.
//
// Env:
//   ZEROPG_BUCKET   — GCS bucket name (required)
//   ZEROPG_PREFIX   — object prefix, e.g. demo/rallly (default demo/default)
//   ZEROPG_DURABILITY — sleep|interval|strict (default sleep)

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { GcsBlobStore } from '@zeropg/blobstore'
import type { Durability } from '@zeropg/objectstore-fs'
import { ZeroPGServer } from '@zeropg/server'

const __dirname = dirname(fileURLToPath(import.meta.url))

const DURABILITY: Durability = (['strict', 'interval', 'sleep'].includes(
  process.env.ZEROPG_DURABILITY ?? '',
)
  ? process.env.ZEROPG_DURABILITY
  : 'sleep') as Durability

function loadSeed(): Uint8Array | undefined {
  const p = join(__dirname, 'seed.tar.gz')
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined
}

const server = await ZeroPGServer.start({
  store: new GcsBlobStore({
    bucket: process.env.ZEROPG_BUCKET ?? 'zeropg-experiments-euw1',
    prefix: process.env.ZEROPG_PREFIX ?? 'demo/default',
  }),
  holder: `${process.env.K_REVISION ?? 'local'}-${process.pid}`,
  durability: DURABILITY,
  seedSnapshot: loadSeed(),
  postgrest: false,
  label: 'zeropg-sidecar',
})
server.installSignalHandlers()
