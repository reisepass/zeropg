// Run: tsx examples/poll/test/api.test.ts
// (setup once: npx prisma generate --schema examples/poll/prisma/schema.prisma)
//
// Exercises the poll app end to end at the HTTP layer against a real Prisma
// client on zeropg: create a poll, two participants vote, tally + best option,
// and durability across a full reboot on disk.

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
  const app = createApp(b.prisma)
  await new Promise<void>((r) => app.listen(0, r))
  const base = `http://localhost:${(app.address() as AddressInfo).port}`
  return { base, stop: async () => { await new Promise<void>((r) => app.close(() => r())); await b.stop() } }
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
  const dir = await mkdtemp(join(tmpdir(), 'poll-'))
  const dataDir = join(dir, 'db')

  let s = await start(dataDir)
  console.log('create a poll with 3 options')
  const created = await form(s.base, '/polls', { title: 'Team lunch', options: 'Mon 12:00\nTue 12:00\nWed 12:00' })
  ok(created.status === 303, 'POST /polls redirects (303)')
  const loc = created.headers.get('location') ?? ''
  const pollId = loc.replace('/poll/', '')
  ok(/^[a-z0-9]+$/.test(pollId), `redirect carries a poll id (${pollId})`)

  let poll = await getJson(s.base, `/api/poll/${pollId}`)
  ok(poll.title === 'Team lunch', 'poll persisted with title')
  ok(poll.options.length === 3, 'poll has 3 options')
  const [mon, tue, wed] = poll.options as { id: string; label: string }[]

  console.log('two participants vote')
  await form(s.base, `/poll/${pollId}/vote`, { name: 'Ada', [`opt_${mon.id}`]: 'yes', [`opt_${tue.id}`]: 'no', [`opt_${wed.id}`]: 'ifneedbe' })
  await form(s.base, `/poll/${pollId}/vote`, { name: 'Linus', [`opt_${mon.id}`]: 'yes', [`opt_${tue.id}`]: 'ifneedbe', [`opt_${wed.id}`]: 'no' })

  poll = await getJson(s.base, `/api/poll/${pollId}`)
  ok(poll.participants.length === 2, 'two participants recorded')
  const votes = poll.participants.flatMap((p: any) => p.votes)
  ok(votes.length === 6, 'six votes recorded (2 participants x 3 options)')
  const ada = poll.participants.find((p: any) => p.name === 'Ada')
  ok(ada.votes.find((v: any) => v.optionId === mon.id).value === 'yes', "Ada's Monday vote is yes")

  console.log('best option = Monday (2 yes)')
  const monYes = poll.participants.filter((p: any) => p.votes.some((v: any) => v.optionId === mon.id && v.value === 'yes')).length
  ok(monYes === 2, 'Monday has 2 yes votes')
  const pollPage = await (await fetch(`${s.base}/poll/${pollId}`)).text()
  ok(pollPage.includes('Best so far: <b>Mon 12:00</b>'), 'poll page shows Monday as best')

  console.log('durability: reboot on the same datadir')
  await s.stop()
  s = await start(dataDir)
  const after = await getJson(s.base, `/api/poll/${pollId}`)
  ok(after.participants.length === 2 && after.options.length === 3, 'poll + votes survived reboot on disk')
  await s.stop()

  await rm(dir, { recursive: true, force: true })
  console.log(`\nPASS — ${passed} assertions`)
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
