// E5 soak burst driver (EXPERIMENTS.md E5): one execution = one time slot.
// Cloud Scheduler runs this as a Cloud Run job every 20 minutes for 72h+.
// From the slot number it deterministically decides whether this slot has
// traffic (long-tail profile: busier during EU business hours, near-idle at
// night), how many writes the burst carries, and how the instance dies
// afterwards (natural idle / clean /sleep / hard abort). Deterministic seeding
// keeps the whole soak reproducible from the schedule alone.
//
// Integrity is checked at the START of every burst, before new writes:
//   - per-row md5(payload) recomputed server-side must match the stored md5
//     (corruption check, E5 probe 1)
//   - row count must be >= the durable count recorded by the previous burst's
//     post-flush meta commit (acked-durable writes may never disappear)
// The burst ledger (e5_bursts) lives in the database itself, so the soak's
// own history rides the durability machinery it is testing; stdout JSONL is
// the out-of-band copy in Cloud Logging.
//
// Env:
//   TARGET_URL   required, e.g. https://zeropg-e5-soak-....run.app
//   FORCE=1      run a burst regardless of the slot's traffic decision
//   SLOT_SECONDS default 1200 (must match the scheduler cadence)

const TARGET = process.env.TARGET_URL
if (!TARGET) {
  console.error('TARGET_URL required')
  process.exit(2)
}
const SLOT_SECONDS = Number(process.env.SLOT_SECONDS ?? 1200)

// mulberry32: tiny deterministic PRNG, seeded per slot.
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const now = Date.now()
const slot = Math.floor(now / (SLOT_SECONDS * 1000))
const rand = rng(slot * 2654435761)
const utcHour = new Date(now).getUTCHours()

// Long-tail traffic profile. EU business hours (05-20 UTC): 20% of 20-min
// slots carry traffic; night: 3.5%. Expected ~9-10 bursts/day with gaps long
// enough for real scale-to-zero between most of them, and occasional adjacent
// slots that keep the instance warm (that's realistic too).
const pTraffic = utcHour >= 5 && utcHour < 20 ? 0.2 : 0.035
const hasTraffic = process.env.FORCE === '1' || rand() < pTraffic
const out = (obj) => console.log(JSON.stringify({ at: new Date().toISOString(), slot, ...obj }))

if (!hasTraffic) {
  out({ event: 'idle-slot', pTraffic })
  process.exit(0)
}

const sqlEscape = (s) => s.replace(/'/g, "''")

async function http(path, opts = {}, timeoutMs = 30_000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    return await fetch(TARGET + path, { ...opts, signal: ctl.signal })
  } finally {
    clearTimeout(t)
  }
}

async function sql(q, timeoutMs = 30_000) {
  const res = await http('/sql', { method: 'POST', body: JSON.stringify({ sql: q }) }, timeoutMs)
  const body = await res.json()
  if (!res.ok) throw new Error(`sql ${res.status}: ${body.error ?? 'unknown'} :: ${q.slice(0, 120)}`)
  return body
}

async function main() {
  // 1. Wake the instance; poll /up through the cold start.
  const t0 = performance.now()
  let up = false
  for (let i = 0; i < 60; i++) {
    try {
      const r = await http('/up', {}, 10_000)
      if (r.ok) {
        up = true
        break
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 3000))
  }
  if (!up) {
    out({ event: 'FAIL', reason: 'service never came up within 180s' })
    process.exit(1)
  }
  const wakeMs = Math.round(performance.now() - t0)

  const metrics = await (await http('/metrics')).json()

  // 2. Schema (idempotent).
  await sql(`CREATE TABLE IF NOT EXISTS e5_rows (
    id bigserial primary key, slot bigint not null, payload text not null, md5 text not null
  )`)
  await sql(`CREATE TABLE IF NOT EXISTS e5_meta (k text primary key, v jsonb not null)`)
  await sql(`CREATE TABLE IF NOT EXISTS e5_bursts (
    id bigserial primary key, slot bigint not null, at timestamptz default now(), report jsonb not null
  )`)

  // 3. Integrity check BEFORE writing anything (E5 probe 1).
  const check = await sql(
    `SELECT count(*)::text AS n, coalesce(sum((md5(payload) = md5)::int), 0)::text AS ok FROM e5_rows`,
  )
  const nBefore = Number(check.rows[0].n)
  const okBefore = Number(check.rows[0].ok)
  const meta = await sql(`SELECT v FROM e5_meta WHERE k = 'durable'`)
  const durableBefore = meta.rows[0]?.v?.count ?? 0
  const corruption = nBefore !== okBefore
  const lostDurable = nBefore < durableBefore
  if (corruption || lostDurable) {
    out({
      event: 'INTEGRITY-VIOLATION',
      corruption,
      lostDurable,
      rows: nBefore,
      md5Ok: okBefore,
      expectedDurableAtLeast: durableBefore,
    })
    // Record the violation in-band too, then keep the process exit code loud.
    await sql(
      `INSERT INTO e5_bursts (slot, report) VALUES (${slot}, '${sqlEscape(
        JSON.stringify({ event: 'INTEGRITY-VIOLATION', corruption, lostDurable, rows: nBefore, md5Ok: okBefore, durableBefore }),
      )}'::jsonb)`,
    )
    process.exit(1)
  }

  // 4. The burst: 15-120 writes, mostly /sql inserts riding sleep-mode memory
  //    acks, a sprinkle of /notes form posts for realism.
  const k = 15 + Math.floor(rand() * 105)
  const tWrite = performance.now()
  let noteWrites = 0
  for (let i = 0; i < k; i++) {
    const payload = `e5-${slot}-${i}-${Math.floor(rand() * 0xffffffff).toString(16)}`
    if (rand() < 0.1) {
      const r = await http('/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `body=${encodeURIComponent(payload)}`,
        redirect: 'manual',
      })
      if (r.status !== 302) throw new Error(`/notes returned ${r.status}`)
      noteWrites++
    } else {
      await sql(`INSERT INTO e5_rows (slot, payload, md5) VALUES (${slot}, '${payload}', md5('${payload}'))`)
    }
    // Think-time between writes: 50-800ms, like a human clicking around.
    await new Promise((r) => setTimeout(r, 50 + rand() * 750))
  }
  const writeMs = Math.round(performance.now() - tWrite)

  // 5. Make it durable, then record the durable watermark + the burst report
  //    (each is itself made durable by the trailing flush).
  const tFlush = performance.now()
  const flush1 = await (await http('/flush', { method: 'POST' })).json()
  const flushMs = Math.round(performance.now() - tFlush)

  const after = await sql(`SELECT count(*)::text AS n FROM e5_rows`)
  const nAfter = Number(after.rows[0].n)
  await sql(
    `INSERT INTO e5_meta (k, v) VALUES ('durable', jsonb_build_object('count', ${nAfter}, 'slot', ${slot}))
     ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
  )

  // Kill decision: 70% natural idle (the platform reaps it), 20% clean
  // /sleep, 10% hard abort. The abort happens AFTER the watermark flush, so
  // expected durable loss is zero; E4 P2b already proved the bounded-loss
  // behavior for unflushed writes.
  const killRoll = rand()
  const killMode = killRoll < 0.7 ? 'idle' : killRoll < 0.9 ? 'sleep' : 'abort'

  const report = {
    event: 'burst',
    wakeMs,
    coldRequest: metrics.coldRequest,
    readyMs: metrics.readyMs,
    fencingToken: metrics.fencingToken,
    revision: metrics.revision,
    dbBytes: metrics.dbBytes,
    rowsBefore: nBefore,
    durableBefore,
    wrote: k,
    noteWrites,
    rowsAfter: nAfter,
    writeMs,
    flushMs,
    flush1: flush1.commit ?? flush1,
    killMode,
  }
  await sql(`INSERT INTO e5_bursts (slot, report) VALUES (${slot}, '${sqlEscape(JSON.stringify(report))}'::jsonb)`)
  const flush2 = await (await http('/flush', { method: 'POST' })).json()
  out({ ...report, flush2: flush2.commit ?? flush2 })

  if (killMode === 'sleep') {
    // Streams its flush steps; we just drain it.
    const r = await http('/sleep', { method: 'POST' }, 60_000)
    await r.text().catch(() => {})
    out({ event: 'killed', killMode })
  } else if (killMode === 'abort') {
    await http('/_fault/abort', {}, 5_000).catch(() => {}) // connection dies mid-request by design
    out({ event: 'killed', killMode })
  }
}

main().catch((e) => {
  out({ event: 'FAIL', error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) })
  process.exit(1)
})
