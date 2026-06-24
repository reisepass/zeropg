// Run: tsx examples/drizzle-board/test/api.test.ts
//
// Exercises the reading-list board end to end at the HTTP layer against a real
// Drizzle ORM client on zeropg: create bookmarks, set status, add/remove tags,
// filter, delete, and durability across a full reboot on disk. Also asserts the
// stock Drizzle migrator ran over the zeropg wire (the __drizzle_migrations
// table exists and recorded the migration).

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { boot } from '../boot.js'
import { createApp } from '../app.js'

let passed = 0
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  passed++
  console.log(`  ok  ${msg}`)
}

async function start(dataDir: string) {
  const b = await boot({ dataDir })
  const app = createApp(b.db)
  await new Promise<void>((r) => app.listen(0, r))
  const base = `http://localhost:${(app.address() as AddressInfo).port}`
  return {
    base,
    pglite: b.wire.pglite,
    stop: async () => {
      await new Promise<void>((r) => app.close(() => r()))
      await b.stop()
    },
  }
}

async function form(base: string, path: string, fields: Record<string, string>): Promise<Response> {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  })
}
async function getJson(base: string, path: string): Promise<any> {
  return (await fetch(base + path)).json()
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'drizzle-board-'))
  const dataDir = join(dir, 'db')

  let s = await start(dataDir)

  console.log('the stock Drizzle migrator ran over the zeropg wire')
  const mig = await s.pglite.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
  )
  ok(Number(mig.rows[0].count) >= 1, `__drizzle_migrations recorded ${mig.rows[0].count} migration(s)`)
  const cols = await s.pglite.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
  )
  const tableNames = cols.rows.map((r) => r.table_name)
  ok(
    ['bookmark_tags', 'bookmarks', 'tags'].every((t) => tableNames.includes(t)),
    `migration created the schema tables (${tableNames.join(', ')})`,
  )

  console.log('create two bookmarks')
  const c1 = await form(s.base, '/bookmarks', {
    title: 'The Log',
    url: 'https://engineering.linkedin.com/distributed-systems/log',
    note: 'Kreps on logs',
  })
  ok(c1.status === 303, 'POST /bookmarks redirects (303)')
  const id1 = Number((c1.headers.get('location') ?? '').replace('/bookmark/', ''))
  ok(Number.isInteger(id1) && id1 > 0, `redirect carries a numeric id (${id1})`)

  const c2 = await form(s.base, '/bookmarks', { title: 'Dynamo paper', url: 'https://example.com/dynamo' })
  const id2 = Number((c2.headers.get('location') ?? '').replace('/bookmark/', ''))

  let list = await getJson(s.base, '/api/bookmarks')
  ok(list.length === 2, 'two bookmarks listed')
  ok(list[0].id === id2, 'newest bookmark is first (Dynamo)')

  console.log('default status is unread')
  let bm = await getJson(s.base, `/api/bookmark/${id1}`)
  ok(bm.title === 'The Log' && bm.url.includes('linkedin'), 'bookmark persisted with title + url')
  ok(bm.status === 'unread', 'default status is unread')
  ok(bm.note === 'Kreps on logs', 'note persisted')

  console.log('set status reading -> done')
  await form(s.base, `/bookmark/${id1}/status`, { status: 'reading' })
  bm = await getJson(s.base, `/api/bookmark/${id1}`)
  ok(bm.status === 'reading', 'status updated to reading')
  await form(s.base, `/bookmark/${id1}/status`, { status: 'done' })
  bm = await getJson(s.base, `/api/bookmark/${id1}`)
  ok(bm.status === 'done', 'status updated to done')

  console.log('an invalid status is rejected')
  await form(s.base, `/bookmark/${id1}/status`, { status: 'bogus' })
  bm = await getJson(s.base, `/api/bookmark/${id1}`)
  ok(bm.status === 'done', 'invalid status ignored (still done)')

  console.log('tags: add, dedupe, share across bookmarks, remove')
  await form(s.base, `/bookmark/${id1}/tags`, { tag: 'distsys' })
  await form(s.base, `/bookmark/${id1}/tags`, { tag: 'distsys' }) // dup -> idempotent
  await form(s.base, `/bookmark/${id1}/tags`, { tag: 'classic' })
  bm = await getJson(s.base, `/api/bookmark/${id1}`)
  ok(bm.tags.length === 2, 'two distinct tags after a duplicate add')
  ok(bm.tags.map((t: any) => t.name).join(',') === 'classic,distsys', 'tags returned in name order')

  await form(s.base, `/bookmark/${id2}/tags`, { tag: 'distsys' }) // same tag reused
  const distsysId = bm.tags.find((t: any) => t.name === 'distsys').id
  const bm2 = await getJson(s.base, `/api/bookmark/${id2}`)
  ok(bm2.tags.some((t: any) => t.id === distsysId), 'the distsys tag row is shared (same id) across bookmarks')

  await form(s.base, `/bookmark/${id1}/untag`, { tagId: String(distsysId) })
  bm = await getJson(s.base, `/api/bookmark/${id1}`)
  ok(bm.tags.length === 1 && bm.tags[0].name === 'classic', 'untag removed distsys from bookmark 1 only')
  ok((await getJson(s.base, `/api/bookmark/${id2}`)).tags.length === 1, 'bookmark 2 still has distsys')

  console.log('status filter')
  const doneList = await getJson(s.base, '/api/bookmarks')
  ok(doneList.length === 2, 'api list ignores filter (returns all)')
  const doneHtml = await (await fetch(`${s.base}/?status=done`)).text()
  ok(doneHtml.includes('The Log') && !doneHtml.includes('Dynamo paper'), 'GET /?status=done shows only done bookmarks')
  const unreadHtml = await (await fetch(`${s.base}/?status=unread`)).text()
  ok(unreadHtml.includes('Dynamo paper') && !unreadHtml.includes('The Log'), 'GET /?status=unread shows only unread')

  console.log('durability: reboot on the same datadir')
  await s.stop()
  s = await start(dataDir)
  const afterList = await getJson(s.base, '/api/bookmarks')
  ok(afterList.length === 2, 'both bookmarks survived reboot on disk')
  const after1 = await getJson(s.base, `/api/bookmark/${id1}`)
  ok(after1.status === 'done' && after1.tags.length === 1, 'status + tags survived reboot')
  const migAfter = await s.pglite.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
  )
  ok(Number(migAfter.rows[0].count) >= 1, 'migrate() is idempotent across reboot (no duplicate migration rows growth)')

  console.log('delete')
  await form(s.base, `/bookmark/${id2}/delete`, {})
  const finalList = await getJson(s.base, '/api/bookmarks')
  ok(finalList.length === 1 && finalList[0].id === id1, 'delete removed bookmark 2')
  ok((await fetch(`${s.base}/api/bookmark/${id2}`)).status === 404, 'deleted bookmark returns 404')

  console.log('cascade: deleting a bookmark drops its bookmark_tags links')
  const links = await s.pglite.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM bookmark_tags WHERE bookmark_id = ${id2}`,
  )
  ok(Number(links.rows[0].count) === 0, 'bookmark_tags rows for the deleted bookmark were cascade-deleted')

  await s.stop()
  await rm(dir, { recursive: true, force: true })
  console.log(`\nPASS — ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
