// Measure the standalone server's resident memory with PostgREST on vs off,
// idle and under load, via the /metrics face (which reports the Node writer RSS
// and the PostgREST child RSS read from /proc). Appends one JSONL row per
// (postgrest, scenario) to results/standalone-ram.jsonl.
//
//   node experiments/standalone-service/measure-ram.mjs <baseUrl> <on|off> [label]
//
// Run it once against a deploy with ZEROPG_POSTGREST=on and once with =off.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', '..', 'results', 'standalone-ram.jsonl')
mkdirSync(dirname(OUT), { recursive: true })

const base = (process.argv[2] ?? '').replace(/\/+$/, '')
const postgrest = process.argv[3] ?? 'on'
const label = process.argv[4] ?? 'ibm-code-engine'
if (!base) {
  console.error('usage: measure-ram.mjs <baseUrl> <on|off> [label]')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const metrics = async () => (await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(30_000) })).json()

async function ensureReady() {
  await fetch(`${base}/wake`, { signal: AbortSignal.timeout(60_000) }).catch(() => {})
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(30_000) })
      if (r.status === 200) return
    } catch {}
    await sleep(2000)
  }
  throw new Error('never became ready')
}

// A demo table so both load shapes have something to hit.
async function seed() {
  await fetch(`${base}/sql`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql: 'CREATE TABLE IF NOT EXISTS ram_probe (id serial primary key, v text not null);' }),
    signal: AbortSignal.timeout(30_000),
  })
}

// Load: a burst of concurrent requests. With PostgREST on, half go through the
// REST surface (exercises the Haskell process); the rest are POST /sql writes.
// With PostgREST off, all are POST /sql.
async function load(rounds, concurrency) {
  let peak = { serverRssMB: 0, postgrestRssMB: 0, totalRssMB: 0 }
  for (let r = 0; r < rounds; r++) {
    const batch = []
    for (let c = 0; c < concurrency; c++) {
      if (postgrest === 'on' && c % 2 === 0) {
        batch.push(fetch(`${base}/rest/ram_probe?select=id,v&limit=50`, { signal: AbortSignal.timeout(30_000) }).catch(() => {}))
      } else {
        batch.push(fetch(`${base}/sql`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sql: `INSERT INTO ram_probe (v) VALUES ('load-${r}-${c}') RETURNING id;` }),
          signal: AbortSignal.timeout(30_000),
        }).catch(() => {}))
      }
    }
    await Promise.all(batch)
    const m = await metrics()
    peak = {
      serverRssMB: Math.max(peak.serverRssMB, m.serverRssMB ?? 0),
      postgrestRssMB: Math.max(peak.postgrestRssMB, m.postgrestRssMB ?? 0),
      totalRssMB: Math.max(peak.totalRssMB, m.totalRssMB ?? 0),
    }
  }
  return peak
}

function record(scenario, m) {
  const row = {
    ts: new Date().toISOString(),
    label,
    postgrest,
    scenario,
    serverRssMB: m.serverRssMB,
    postgrestRssMB: m.postgrestRssMB,
    totalRssMB: m.totalRssMB,
    dbBytes: m.dbBytes,
    readyMs: m.readyMs,
  }
  appendFileSync(OUT, JSON.stringify(row) + '\n')
  console.log(JSON.stringify(row))
}

await ensureReady()
await seed()
// let things settle to a true idle baseline
await sleep(3000)
const idle = await metrics()
record('idle', idle)

const peak = await load(8, 16)
record('load', peak)

console.log('DONE', OUT)
process.exit(0)
