// The poll app: HTTP + server-rendered UI, all data access through Prisma. Plain
// <form> POSTs + redirects (works with JS off, trivially driveable end-to-end).
// Each view has its own GET URL: / (create), /poll/:id (vote + results).

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'

type VoteValue = 'yes' | 'ifneedbe' | 'no'
const VALUES: VoteValue[] = ['yes', 'ifneedbe', 'no']
const MARK: Record<VoteValue, string> = { yes: '✓', ifneedbe: '~', no: '✗' }

export function createApp(prisma: PrismaClient): Server {
  return createServer((req, res) => {
    handle(prisma, req, res).catch((e) => {
      send(res, 500, 'application/json', JSON.stringify({ error: String(e?.message ?? e) }))
    })
  })
}

async function handle(prisma: PrismaClient, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (method === 'GET' && path === '/healthz') {
    return send(res, 200, 'application/json', JSON.stringify({ ok: true }))
  }

  if (method === 'GET' && path === '/') {
    return send(res, 200, html, renderHome())
  }

  if (method === 'POST' && path === '/polls') {
    const f = await readForm(req)
    const title = (f.get('title') ?? '').trim().slice(0, 200)
    const options = (f.get('options') ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 30)
    if (!title || options.length === 0) return redirect(res, '/')
    const poll = await prisma.poll.create({
      data: { title, options: { create: options.map((label, sort) => ({ label, sort })) } },
    })
    return redirect(res, `/poll/${poll.id}`)
  }

  const apiId = match(path, /^\/api\/poll\/([^/]+)$/)
  if (apiId && method === 'GET') {
    const poll = await loadPoll(prisma, apiId)
    return poll
      ? send(res, 200, 'application/json', JSON.stringify(poll))
      : send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }))
  }

  const voteId = match(path, /^\/poll\/([^/]+)\/vote$/)
  if (voteId && method === 'POST') {
    const f = await readForm(req)
    const name = (f.get('name') ?? '').trim().slice(0, 80)
    const poll = await loadPoll(prisma, voteId)
    if (poll && name) {
      const votes = poll.options.map((o) => {
        const v = f.get(`opt_${o.id}`)
        const value: VoteValue = v === 'yes' || v === 'ifneedbe' ? v : 'no'
        return { optionId: o.id, value }
      })
      await prisma.participant.create({
        data: { pollId: poll.id, name, votes: { create: votes } },
      })
    }
    return redirect(res, `/poll/${voteId}`)
  }

  const pageId = match(path, /^\/poll\/([^/]+)$/)
  if (pageId && method === 'GET') {
    const poll = await loadPoll(prisma, pageId)
    return poll
      ? send(res, 200, html, renderPoll(poll))
      : send(res, 404, html, '<h1>404 — no such poll</h1><a href=/>home</a>')
  }

  send(res, 404, 'application/json', JSON.stringify({ error: 'not found', path }))
}

// ---- data ----

type LoadedPoll = NonNullable<Awaited<ReturnType<typeof loadPoll>>>

async function loadPoll(prisma: PrismaClient, id: string) {
  return prisma.poll.findUnique({
    where: { id },
    include: {
      options: { orderBy: { sort: 'asc' } },
      participants: { include: { votes: true }, orderBy: { createdAt: 'asc' } },
    },
  })
}

/** yes=2, ifneedbe=1, no=0 — the option with the highest score wins (Doodle-ish). */
function tally(poll: LoadedPoll): { byOption: Map<string, { yes: number; score: number }>; bestId: string | null } {
  const byOption = new Map<string, { yes: number; score: number }>()
  for (const o of poll.options) byOption.set(o.id, { yes: 0, score: 0 })
  for (const p of poll.participants) {
    for (const v of p.votes) {
      const agg = byOption.get(v.optionId)
      if (!agg) continue
      if (v.value === 'yes') {
        agg.yes++
        agg.score += 2
      } else if (v.value === 'ifneedbe') {
        agg.score += 1
      }
    }
  }
  let bestId: string | null = null
  let best = -1
  for (const o of poll.options) {
    const s = byOption.get(o.id)!.score
    if (s > best) {
      best = s
      bestId = s > 0 ? o.id : null
    }
  }
  return { byOption, bestId }
}

// ---- http helpers ----

const html = 'text/html; charset=utf-8'
function match(path: string, re: RegExp): string | null {
  const m = re.exec(path)
  return m ? decodeURIComponent(m[1]) : null
}
function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}
function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location })
  res.end()
}
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  let b = ''
  for await (const c of req) b += c
  return new URLSearchParams(b)
}

// ---- views ----

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
 h1{margin-bottom:.1rem} .sub{color:#666;margin-top:0}
 input,textarea,select,button{font:inherit;padding:.45rem;border:1px solid #ccc;border-radius:6px}
 textarea{width:100%} button{cursor:pointer;background:#1a56c1;color:#fff;border-color:#1a56c1;padding:.5rem 1rem}
 table{border-collapse:collapse;margin:1rem 0;width:100%} th,td{border:1px solid #e2e2e2;padding:.4rem .6rem;text-align:center}
 th.name,td.name{text-align:left} .best{background:#e7f6ec}
 .yes{color:#127a2e;font-weight:700} .ifneedbe{color:#9a6700} .no{color:#bbb}
 .opt{font-size:.9rem} .share{background:#f5f5f5;padding:.5rem;border-radius:6px;word-break:break-all}
 a{color:#1a56c1}
</style></head><body>${body}</body></html>`
}

function renderHome(): string {
  return page(
    'New poll — zeropg',
    `<h1>Make a poll</h1>
     <p class=sub>A tiny Doodle/Rallly clone — real Postgres (Prisma) on zeropg.</p>
     <form method=post action="/polls">
       <p><input name=title placeholder="What are we scheduling?" data-testid=title required style="width:100%"></p>
       <p><textarea name=options rows=5 data-testid=options placeholder="One option per line, e.g.
Mon 10:00
Tue 14:00
Wed 09:30"></textarea></p>
       <button data-testid=create>Create poll</button>
     </form>`,
  )
}

function renderPoll(poll: LoadedPoll): string {
  const { byOption, bestId } = tally(poll)
  const voteByPart = (partId: string, optId: string): VoteValue => {
    const p = poll.participants.find((x) => x.id === partId)!
    const v = p.votes.find((x) => x.optionId === optId)
    return (v?.value as VoteValue) ?? 'no'
  }
  const headCells = poll.options
    .map((o) => `<th class="opt${o.id === bestId ? ' best' : ''}" data-testid="col-${o.id}">${esc(o.label)}</th>`)
    .join('')
  const rows = poll.participants
    .map(
      (p) =>
        `<tr data-testid="row-${esc(p.name)}"><td class=name>${esc(p.name)}</td>${poll.options
          .map((o) => {
            const val = voteByPart(p.id, o.id)
            return `<td class="${val}${o.id === bestId ? ' best' : ''}">${MARK[val]}</td>`
          })
          .join('')}</tr>`,
    )
    .join('')
  const totals = poll.options
    .map((o) => `<td class="${o.id === bestId ? 'best' : ''}" data-testid="yes-${o.id}">${byOption.get(o.id)!.yes} ✓</td>`)
    .join('')
  const voteInputs = poll.options
    .map(
      (o) =>
        `<td class="${o.id === bestId ? 'best' : ''}"><select form=voteform name="opt_${o.id}" data-testid="pick-${o.id}" aria-label="${esc(o.label)}">
           <option value=yes>✓ yes</option><option value=ifneedbe>~ if need be</option><option value=no selected>✗ no</option>
         </select></td>`,
    )
    .join('')

  const grid =
    poll.participants.length || poll.options.length
      ? `<table>
          <thead><tr><th class=name>Who</th>${headCells}</tr></thead>
          <tbody>${rows}
            <tr><td class=name><b>✓ total</b></td>${totals}</tr>
            <form method=post action="/poll/${poll.id}/vote" id=voteform></form>
            <tr><td class=name><input form=voteform name=name placeholder="your name" data-testid=name required></td>${voteInputs}</tr>
          </tbody>
        </table>
        <p><button form=voteform data-testid=submit-vote>Submit my availability</button></p>`
      : '<p>no options</p>'

  const bestLabel = bestId ? poll.options.find((o) => o.id === bestId)!.label : null
  return page(
    `${poll.title} — zeropg`,
    `<p><a href="/">← new poll</a></p>
     <h1 data-testid=poll-title>${esc(poll.title)}</h1>
     <p class=sub>Share this link:</p>
     <p class=share data-testid=share>/poll/${poll.id}</p>
     ${bestLabel ? `<p data-testid=best>Best so far: <b>${esc(bestLabel)}</b></p>` : '<p class=sub data-testid=best>No votes yet.</p>'}
     ${grid}`,
  )
}
