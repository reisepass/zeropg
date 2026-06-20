// Run: tsx examples/taskboard/test/api-parity.test.ts
//
// The showcase thesis, tested: the EXACT same app + the EXACT same HTTP sequence
// must produce identical observable results no matter which engine DATABASE_URL
// selected. We boot the app on memory:// and on a temp file:// and run one
// scripted scenario against each, asserting the two transcripts match. Then a
// file://-only durability check: close the process, reopen, data is still there.

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

/** Strip fields that legitimately vary run-to-run (ids are stable here because
 * each engine starts empty; timestamps are not, so blank them for comparison). */
function stable(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v), (k, val) =>
    k === 'created_at' || k === 'done_at' ? (val ? '<ts>' : val) : val,
  )
}

/** One scripted run; returns a transcript of (label -> {status, body}). */
async function scenario(base: string): Promise<Record<string, unknown>> {
  const t: Record<string, unknown> = {}
  t.empty = await j('GET', base, '/api/tasks')
  t.create1 = await j('POST', base, '/api/tasks', { title: 'write the readme', priority: 1 })
  t.create2 = await j('POST', base, '/api/tasks', { title: 'record a demo', priority: 3, notes: 'asciinema' })
  t.create3 = await j('POST', base, '/api/tasks', { title: 'ignored', priority: 9, notes: '' }) // priority clamps to 2
  t.badCreate = await j('POST', base, '/api/tasks', { title: '   ' }) // 400
  t.listAll = await j('GET', base, '/api/tasks')
  t.toggle1 = await j('POST', base, '/api/tasks/1/toggle')
  t.todoOnly = await j('GET', base, '/api/tasks?status=todo')
  t.doneOnly = await j('GET', base, '/api/tasks?status=done')
  t.getOne = await j('GET', base, '/api/tasks/2')
  t.getMissing = await j('GET', base, '/api/tasks/999')
  t.del = await j('DELETE', base, '/api/tasks/3')
  t.delMissing = await j('DELETE', base, '/api/tasks/999')
  t.final = await j('GET', base, '/api/tasks')
  return stable(t) as Record<string, unknown>
}

async function main(): Promise<void> {
  console.log('engine parity: memory:// vs file:// run the identical scenario')
  const dir = await mkdtemp(join(tmpdir(), 'taskboard-'))
  const fileUrl = `file://${join(dir, 'tb.db')}`

  const mem = await boot('memory://')
  const memT = await scenario(mem.base)
  eq((memT.empty as { body: unknown }).body, [], 'memory starts empty')
  eq((memT.badCreate as { status: number }).status, 400, 'blank title -> 400')
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
  // the scenario already left tasks 1 (done) and 2 (todo) in this datadir.
  const before = await j('GET', d1.base, '/api/tasks')
  await d1.stop() // closes PGlite, releases the lock
  const d2 = await boot(fileUrl)
  const after = await j('GET', d2.base, '/api/tasks')
  await d2.stop()
  eq(stable(after.body), stable(before.body), 'tasks persisted across a process-style reopen')
  ok((after.body as unknown[]).length === 2, 'exactly the two surviving tasks came back')

  await rm(dir, { recursive: true, force: true })
  console.log(`\nPASS — ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
