// Run: tsx examples/shortlink/test/api-parity.test.ts
//
// The showcase thesis, tested: the EXACT same app + the EXACT same HTTP sequence
// must produce identical observable results no matter which engine DATABASE_URL
// selected. We boot the app on memory:// and on a temp file:// and run one scripted
// scenario against each, asserting the two transcripts match. Then a file://-only
// durability check: close the process, reopen, links + click counts survive.
//
// Codes are supplied explicitly to the JSON API so the transcript is deterministic
// (the auto-generator is random); timestamps are blanked before comparison.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { openDb } from '../db.js'
import { createApp } from '../app.js'
import type { Client } from '@zeropg/client'

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}
function eq(a: unknown, b: unknown, msg: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) {
    passed++
    console.log(`  ok  ${msg}`)
  } else {
    throw new Error(`FAIL: ${msg}\n     a=${JSON.stringify(a)}\n     b=${JSON.stringify(b)}`)
  }
}

interface Booted {
  base: string
  db: Client
  stop: () => Promise<void>
}

async function boot(url: string): Promise<Booted> {
  const { db } = await openDb(url)
  const app = createApp(db)
  await new Promise<void>((r) => app.listen(0, r))
  const port = (app.address() as AddressInfo).port
  return {
    base: `http://localhost:${port}`,
    db,
    stop: async () => {
      await new Promise<void>((r) => app.close(() => r()))
      await db.end()
    },
  }
}

async function j(method: string, base: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

/** Follow a short code WITHOUT auto-following the redirect, so we observe the 302
 * and its Location (the host:port differs per boot, so we record only the path). */
async function hit(base: string, code: string): Promise<{ status: number; locationPath: string | null }> {
  const res = await fetch(`${base}/${code}`, { redirect: 'manual' })
  await res.text()
  const loc = res.headers.get('location')
  return { status: res.status, locationPath: loc }
}

/** Strip fields that legitimately vary run-to-run. ids are stable (each engine
 * starts empty and we insert in the same order); timestamps are not. */
function stable(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v), (k, val) =>
    k === 'created_at' || k === 'last_clicked_at' ? (val ? '<ts>' : val) : val,
  )
}

/** One scripted run; returns a transcript of (label -> result). */
async function scenario(base: string): Promise<Record<string, unknown>> {
  const t: Record<string, unknown> = {}
  t.empty = await j('GET', base, '/api/links')
  t.create1 = await j('POST', base, '/api/links', { url: 'https://example.com/very/long/path', code: 'alpha' })
  t.create2 = await j('POST', base, '/api/links', { url: 'docs.zeropg.dev/guide', code: 'beta' }) // bare host -> https
  t.dupCode = await j('POST', base, '/api/links', { url: 'https://example.org', code: 'alpha' }) // 409
  t.badUrl = await j('POST', base, '/api/links', { url: 'not a url', code: 'gamma' }) // 400
  t.badCode = await j('POST', base, '/api/links', { url: 'https://example.com', code: 'api' }) // reserved -> 400
  t.listAfterCreate = await j('GET', base, '/api/links')
  // follow: 302 with the absolute target as Location, and the click counter bumps.
  t.hit1 = await hit(base, 'alpha')
  t.hit2 = await hit(base, 'alpha')
  t.hit3 = await hit(base, 'beta')
  t.hitMissing = await hit(base, 'nope')
  t.getAlpha = await j('GET', base, '/api/links/alpha')
  t.getMissing = await j('GET', base, '/api/links/zzz')
  t.final = await j('GET', base, '/api/links')
  return stable(t) as Record<string, unknown>
}

async function main(): Promise<void> {
  console.log('engine parity: memory:// vs file:// run the identical scenario')
  const dir = await mkdtemp(join(tmpdir(), 'shortlink-'))
  const fileUrl = `file://${join(dir, 'sl.db')}`

  const mem = await boot('memory://')
  const memT = await scenario(mem.base)
  eq((memT.empty as { body: unknown }).body, [], 'memory starts empty')
  eq((memT.create1 as { status: number }).status, 201, 'create -> 201')
  eq((memT.dupCode as { status: number }).status, 409, 'duplicate code -> 409')
  eq((memT.badUrl as { status: number }).status, 400, 'invalid url -> 400')
  eq((memT.badCode as { status: number }).status, 400, 'reserved code -> 400')
  eq((memT.hit1 as { status: number }).status, 302, 'follow -> 302 redirect')
  eq(
    (memT.hit1 as { locationPath: string }).locationPath,
    'https://example.com/very/long/path',
    'redirect Location is the absolute target',
  )
  eq((memT.getAlpha as { body: { clicks: number } }).body.clicks, 2, 'two hits counted on alpha')
  await mem.stop()

  const file = await boot(fileUrl)
  const fileT = await scenario(file.base)
  await file.stop()

  eq(fileT, memT, 'file:// transcript is byte-identical to memory:// transcript')

  // engine badge differs by engine, but behavior does not.
  const mem2 = await boot('memory://')
  const health = (await (await fetch(mem2.base + '/healthz')).json()) as { engine: string }
  eq(health.engine, 'memory', 'healthz reports the active engine')
  await mem2.stop()

  console.log('durability: file:// survives a full close + reopen')
  const d1 = await boot(fileUrl)
  // the scenario already left alpha (clicks=2) and beta (clicks=1) in this datadir.
  const before = await j('GET', d1.base, '/api/links')
  await d1.stop() // closes PGlite, releases the lock
  const d2 = await boot(fileUrl)
  const after = await j('GET', d2.base, '/api/links')
  // one more hit AFTER reopen, to prove the counter keeps climbing from the durable value.
  await hit(d2.base, 'alpha')
  const afterHit = await j('GET', d2.base, '/api/links/alpha')
  await d2.stop()

  eq(stable(after.body), stable(before.body), 'links + click counts persisted across a reopen')
  ok((after.body as unknown[]).length === 2, 'exactly the two created links came back')
  eq((afterHit.body as { clicks: number }).clicks, 3, 'click counter resumed from the durable value (2 -> 3)')

  await rm(dir, { recursive: true, force: true })
  console.log(`\nPASS — ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
