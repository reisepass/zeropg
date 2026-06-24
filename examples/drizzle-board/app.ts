// The reading-list board: HTTP + server-rendered UI, all data access through
// Drizzle. Plain <form> POSTs + redirects (works with JS off, trivially
// driveable end-to-end). Each view has its own GET URL:
//   /                       list + "add bookmark" form (optionally ?status= filter)
//   /bookmark/:id           detail: set status, add/remove tags, delete
//   /api/bookmark/:id       JSON view of one bookmark (for the api test)
//   /api/bookmarks          JSON list (for the api test)

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { DB } from './boot.js'
import { bookmarks, bookmarkTags, STATUSES, tags, type Status } from './schema.js'

const STATUS_LABEL: Record<Status, string> = { unread: 'unread', reading: 'reading', done: 'done' }

export function createApp(db: DB): Server {
  return createServer((req, res) => {
    handle(db, req, res).catch((e) => {
      send(res, 500, 'application/json', JSON.stringify({ error: String(e?.message ?? e) }))
    })
  })
}

async function handle(db: DB, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (method === 'GET' && path === '/healthz') {
    return send(res, 200, 'application/json', JSON.stringify({ ok: true }))
  }

  if (method === 'GET' && path === '/') {
    const filter = url.searchParams.get('status')
    const status = (STATUSES as readonly string[]).includes(filter ?? '') ? (filter as Status) : null
    return send(res, 200, html, renderHome(await listBookmarks(db, status), status))
  }

  if (method === 'POST' && path === '/bookmarks') {
    const f = await readForm(req)
    const title = (f.get('title') ?? '').trim().slice(0, 200)
    const rawUrl = (f.get('url') ?? '').trim().slice(0, 500)
    const note = (f.get('note') ?? '').trim().slice(0, 1000)
    if (!title || !rawUrl) return redirect(res, '/')
    const [row] = await db.insert(bookmarks).values({ title, url: rawUrl, note }).returning({ id: bookmarks.id })
    return redirect(res, `/bookmark/${row.id}`)
  }

  if (method === 'GET' && path === '/api/bookmarks') {
    return send(res, 200, 'application/json', JSON.stringify(await listBookmarks(db, null)))
  }

  const apiId = matchId(path, /^\/api\/bookmark\/(\d+)$/)
  if (apiId !== null && method === 'GET') {
    const bm = await loadBookmark(db, apiId)
    return bm
      ? send(res, 200, 'application/json', JSON.stringify(bm))
      : send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }))
  }

  const statusId = matchId(path, /^\/bookmark\/(\d+)\/status$/)
  if (statusId !== null && method === 'POST') {
    const f = await readForm(req)
    const next = f.get('status') ?? ''
    if ((STATUSES as readonly string[]).includes(next)) {
      await db.update(bookmarks).set({ status: next }).where(eq(bookmarks.id, statusId))
    }
    return redirect(res, `/bookmark/${statusId}`)
  }

  const tagId = matchId(path, /^\/bookmark\/(\d+)\/tags$/)
  if (tagId !== null && method === 'POST') {
    const f = await readForm(req)
    const name = (f.get('tag') ?? '').trim().toLowerCase().slice(0, 40)
    if (name) await addTag(db, tagId, name)
    return redirect(res, `/bookmark/${tagId}`)
  }

  const untagId = matchId(path, /^\/bookmark\/(\d+)\/untag$/)
  if (untagId !== null && method === 'POST') {
    const f = await readForm(req)
    const tid = Number(f.get('tagId'))
    if (Number.isInteger(tid)) {
      await db.delete(bookmarkTags).where(and(eq(bookmarkTags.bookmarkId, untagId), eq(bookmarkTags.tagId, tid)))
    }
    return redirect(res, `/bookmark/${untagId}`)
  }

  const delId = matchId(path, /^\/bookmark\/(\d+)\/delete$/)
  if (delId !== null && method === 'POST') {
    await db.delete(bookmarks).where(eq(bookmarks.id, delId))
    return redirect(res, '/')
  }

  const pageId = matchId(path, /^\/bookmark\/(\d+)$/)
  if (pageId !== null && method === 'GET') {
    const bm = await loadBookmark(db, pageId)
    return bm
      ? send(res, 200, html, renderBookmark(bm))
      : send(res, 404, html, '<h1>404 — no such bookmark</h1><a href=/>home</a>')
  }

  send(res, 404, 'application/json', JSON.stringify({ error: 'not found', path }))
}

// ---- data (Drizzle) ----

interface BookmarkView {
  id: number
  title: string
  url: string
  note: string
  status: Status
  createdAt: string
  tags: { id: number; name: string }[]
}

/** List bookmarks (newest first), each with its tags, optionally filtered by
 * status. Two queries + an in-memory join keeps it simple and ordering-stable. */
async function listBookmarks(db: DB, status: Status | null): Promise<BookmarkView[]> {
  const rows = await db
    .select()
    .from(bookmarks)
    .where(status ? eq(bookmarks.status, status) : undefined)
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
  if (rows.length === 0) return []
  const tagRows = await db
    .select({ bookmarkId: bookmarkTags.bookmarkId, id: tags.id, name: tags.name })
    .from(bookmarkTags)
    .innerJoin(tags, eq(bookmarkTags.tagId, tags.id))
    .where(inArray(bookmarkTags.bookmarkId, rows.map((r) => r.id)))
    .orderBy(asc(tags.name))
  return rows.map((r) => ({
    ...r,
    status: r.status as Status,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    tags: tagRows.filter((t) => t.bookmarkId === r.id).map((t) => ({ id: t.id, name: t.name })),
  }))
}

async function loadBookmark(db: DB, id: number): Promise<BookmarkView | null> {
  const [row] = await db.select().from(bookmarks).where(eq(bookmarks.id, id))
  if (!row) return null
  const tagRows = await db
    .select({ id: tags.id, name: tags.name })
    .from(bookmarkTags)
    .innerJoin(tags, eq(bookmarkTags.tagId, tags.id))
    .where(eq(bookmarkTags.bookmarkId, id))
    .orderBy(asc(tags.name))
  return {
    ...row,
    status: row.status as Status,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    tags: tagRows,
  }
}

/** Upsert the tag by name, then link it to the bookmark (idempotent). */
async function addTag(db: DB, bookmarkId: number, name: string): Promise<void> {
  await db.insert(tags).values({ name }).onConflictDoNothing({ target: tags.name })
  const [tag] = await db.select({ id: tags.id }).from(tags).where(eq(tags.name, name))
  if (!tag) return
  await db.insert(bookmarkTags).values({ bookmarkId, tagId: tag.id }).onConflictDoNothing()
}

// ---- http helpers ----

const html = 'text/html; charset=utf-8'
function matchId(path: string, re: RegExp): number | null {
  const m = re.exec(path)
  return m ? Number(m[1]) : null
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
 input[type=text],textarea{width:100%} textarea{min-height:3rem}
 button{cursor:pointer;background:#1a56c1;color:#fff;border-color:#1a56c1;padding:.5rem 1rem}
 button.ghost{background:#f5f5f5;color:#1a1a1a;border-color:#ccc;padding:.25rem .6rem}
 ul.list{list-style:none;padding:0} li.item{border:1px solid #e2e2e2;border-radius:8px;padding:.6rem .8rem;margin:.5rem 0}
 a{color:#1a56c1;text-decoration:none} a:hover{text-decoration:underline}
 .row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
 .tag{display:inline-block;background:#eef2fb;color:#1a56c1;border-radius:999px;padding:.05rem .55rem;font-size:.85rem;margin-right:.3rem}
 .pill{display:inline-block;border-radius:999px;padding:.05rem .55rem;font-size:.8rem;font-weight:700}
 .unread{background:#fff2e0;color:#9a6700} .reading{background:#e0ecff;color:#1a56c1} .done{background:#e7f6ec;color:#127a2e}
 .filters a{margin-right:.6rem} .filters a.on{font-weight:700;text-decoration:underline}
 .share{background:#f5f5f5;padding:.5rem;border-radius:6px;word-break:break-all}
 form.inline{display:inline}
</style></head><body>${body}</body></html>`
}

function statusPill(s: Status): string {
  return `<span class="pill ${s}">${STATUS_LABEL[s]}</span>`
}

function renderHome(items: BookmarkView[], filter: Status | null): string {
  const filters =
    `<p class=filters data-testid=filters>` +
    `<a href="/" class="${filter === null ? 'on' : ''}" data-testid=filter-all>all</a>` +
    STATUSES.map(
      (s) => `<a href="/?status=${s}" class="${filter === s ? 'on' : ''}" data-testid="filter-${s}">${s}</a>`,
    ).join('') +
    `</p>`

  const list = items.length
    ? `<ul class=list data-testid=list>${items
        .map(
          (b) => `<li class=item data-testid="item-${b.id}">
            <div class=row>
              <a href="/bookmark/${b.id}" data-testid="title-${b.id}"><b>${esc(b.title)}</b></a>
              ${statusPill(b.status)}
            </div>
            <div class=sub data-testid="url-${b.id}">${esc(b.url)}</div>
            <div data-testid="tags-${b.id}">${b.tags.map((t) => `<span class=tag>#${esc(t.name)}</span>`).join('')}</div>
          </li>`,
        )
        .join('')}</ul>`
    : `<p data-testid=empty>Nothing here yet${filter ? ` with status "${esc(filter)}"` : ''}.</p>`

  return page(
    'Reading list — zeropg + Drizzle',
    `<h1>Reading list</h1>
     <p class=sub>A tiny bookmarks board — a real Drizzle ORM app on zeropg.</p>
     ${filters}
     ${list}
     <h2>Add a bookmark</h2>
     <form method=post action="/bookmarks">
       <p><input type=text name=title placeholder="Title" data-testid=title required></p>
       <p><input type=text name=url placeholder="https://…" data-testid=url required></p>
       <p><textarea name=note placeholder="note (optional)" data-testid=note></textarea></p>
       <button data-testid=create>Add bookmark</button>
     </form>`,
  )
}

function renderBookmark(b: BookmarkView): string {
  const statusForm = STATUSES.map(
    (s) =>
      `<form method=post action="/bookmark/${b.id}/status" class=inline>
         <input type=hidden name=status value="${s}">
         <button class="ghost" data-testid="set-${s}"${b.status === s ? ' disabled' : ''}>${s}</button>
       </form>`,
  ).join(' ')

  const tagList = b.tags.length
    ? b.tags
        .map(
          (t) =>
            `<span class=tag data-testid="tag-${esc(t.name)}">#${esc(t.name)}
               <form method=post action="/bookmark/${b.id}/untag" class=inline>
                 <input type=hidden name=tagId value="${t.id}">
                 <button class=ghost data-testid="untag-${esc(t.name)}">×</button>
               </form>
             </span>`,
        )
        .join(' ')
    : '<span class=sub data-testid=no-tags>no tags yet</span>'

  return page(
    `${b.title} — zeropg + Drizzle`,
    `<p><a href="/">← reading list</a></p>
     <h1 data-testid=bm-title>${esc(b.title)}</h1>
     <p class=sub>Status: <span data-testid=bm-status>${statusPill(b.status)}</span></p>
     <p class=share data-testid=bm-url>${esc(b.url)}</p>
     ${b.note ? `<p data-testid=bm-note>${esc(b.note)}</p>` : ''}

     <h2>Set status</h2>
     <div class=row data-testid=status-controls>${statusForm}</div>

     <h2>Tags</h2>
     <div class=row data-testid=tag-list>${tagList}</div>
     <form method=post action="/bookmark/${b.id}/tags" class=row>
       <input type=text name=tag placeholder="add a tag" data-testid=tag-input style="width:auto;flex:1">
       <button data-testid=add-tag>Add tag</button>
     </form>

     <h2>Danger</h2>
     <form method=post action="/bookmark/${b.id}/delete">
       <button data-testid=delete style="background:#b91c1c;border-color:#b91c1c">Delete bookmark</button>
     </form>`,
  )
}
