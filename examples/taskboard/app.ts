// The task-board app. Pure HTTP + the unified Client; knows nothing about which
// engine is underneath. The HTML UI uses plain <form> POSTs + redirects (works
// with JS disabled, and is trivially driveable end-to-end), and there is a JSON
// REST API alongside it that the engine-parity test hammers.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Client } from '@zeropg/client'

export interface Task {
  id: number
  title: string
  status: 'todo' | 'done'
  priority: number
  notes: string
  created_at: string
  done_at: string | null
}

const PRIORITY_LABEL: Record<number, string> = { 1: 'high', 2: 'normal', 3: 'low' }

export function createApp(db: Client): Server {
  return createServer((req, res) => {
    handle(db, req, res).catch((e) => {
      send(res, 500, 'application/json', JSON.stringify({ error: String(e?.message ?? e) }))
    })
  })
}

async function handle(db: Client, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const method = req.method ?? 'GET'

  // ---- health ----
  if (method === 'GET' && path === '/healthz') {
    return send(res, 200, 'application/json', JSON.stringify({ ok: true, engine: db.engine }))
  }

  // ---- JSON API ----
  if (path === '/api/tasks' && method === 'GET') {
    const status = url.searchParams.get('status')
    return send(res, 200, 'application/json', JSON.stringify(await listTasks(db, status)))
  }
  if (path === '/api/tasks' && method === 'POST') {
    const body = await readJson(req)
    const task = await createTask(db, String(body.title ?? ''), Number(body.priority ?? 2), String(body.notes ?? ''))
    if (!task) return send(res, 400, 'application/json', JSON.stringify({ error: 'title required' }))
    return send(res, 201, 'application/json', JSON.stringify(task))
  }
  const apiId = matchId(path, /^\/api\/tasks\/(\d+)$/)
  if (apiId !== null && method === 'GET') {
    const task = await getTask(db, apiId)
    return task
      ? send(res, 200, 'application/json', JSON.stringify(task))
      : send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }))
  }
  if (apiId !== null && method === 'DELETE') {
    const n = await deleteTask(db, apiId)
    return send(res, n ? 204 : 404, 'application/json', '')
  }
  const apiToggle = matchId(path, /^\/api\/tasks\/(\d+)\/toggle$/)
  if (apiToggle !== null && method === 'POST') {
    const task = await toggleTask(db, apiToggle)
    return task
      ? send(res, 200, 'application/json', JSON.stringify(task))
      : send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }))
  }

  // ---- HTML form actions (no-JS friendly: POST then redirect) ----
  if (path === '/tasks' && method === 'POST') {
    const f = await readForm(req)
    await createTask(db, f.get('title') ?? '', Number(f.get('priority') ?? 2), f.get('notes') ?? '')
    return redirect(res, '/')
  }
  const formToggle = matchId(path, /^\/tasks\/(\d+)\/toggle$/)
  if (formToggle !== null && method === 'POST') {
    await toggleTask(db, formToggle)
    return redirect(res, (await readForm(req)).get('return') ?? '/')
  }
  const formDelete = matchId(path, /^\/tasks\/(\d+)\/delete$/)
  if (formDelete !== null && method === 'POST') {
    await deleteTask(db, formDelete)
    return redirect(res, '/')
  }
  const formNotes = matchId(path, /^\/tasks\/(\d+)\/notes$/)
  if (formNotes !== null && method === 'POST') {
    const f = await readForm(req)
    await setNotes(db, formNotes, f.get('notes') ?? '')
    return redirect(res, `/task/${formNotes}`)
  }

  // ---- HTML pages (each view its own GET URL) ----
  if (path === '/' && method === 'GET') {
    return send(res, 200, 'text/html; charset=utf-8', renderBoard(db.engine, await listTasks(db, null)))
  }
  const pageId = matchId(path, /^\/task\/(\d+)$/)
  if (pageId !== null && method === 'GET') {
    const task = await getTask(db, pageId)
    return task
      ? send(res, 200, 'text/html; charset=utf-8', renderTask(task))
      : send(res, 404, 'text/html; charset=utf-8', '<h1>404 — no such task</h1><a href=/>back</a>')
  }

  send(res, 404, 'application/json', JSON.stringify({ error: 'not found', path }))
}

// ---- data access (engine-agnostic SQL via the unified Client) ----

async function listTasks(db: Client, status: string | null): Promise<Task[]> {
  if (status === 'todo' || status === 'done') {
    return (await db.query<Task>(
      'SELECT * FROM tasks WHERE status = $1 ORDER BY priority, id',
      [status],
    )).rows
  }
  return (await db.query<Task>('SELECT * FROM tasks ORDER BY status, priority, id')).rows
}

async function getTask(db: Client, id: number): Promise<Task | null> {
  return (await db.query<Task>('SELECT * FROM tasks WHERE id = $1', [id])).rows[0] ?? null
}

async function createTask(db: Client, title: string, priority: number, notes: string): Promise<Task | null> {
  const t = title.trim().slice(0, 200)
  if (!t) return null
  const p = [1, 2, 3].includes(priority) ? priority : 2
  const { rows } = await db.query<Task>(
    'INSERT INTO tasks (title, priority, notes) VALUES ($1, $2, $3) RETURNING *',
    [t, p, notes.slice(0, 2000)],
  )
  return rows[0]
}

/** Flip status in a transaction, stamping/clearing done_at atomically with it. */
async function toggleTask(db: Client, id: number): Promise<Task | null> {
  return db.transaction(async (tx) => {
    const cur = (await tx.query<Task>('SELECT * FROM tasks WHERE id = $1', [id])).rows[0]
    if (!cur) return null
    const next = cur.status === 'done' ? 'todo' : 'done'
    const { rows } = await tx.query<Task>(
      'UPDATE tasks SET status = $1, done_at = CASE WHEN $1 = \'done\' THEN now() ELSE NULL END WHERE id = $2 RETURNING *',
      [next, id],
    )
    return rows[0]
  })
}

async function setNotes(db: Client, id: number, notes: string): Promise<void> {
  await db.query('UPDATE tasks SET notes = $1 WHERE id = $2', [notes.slice(0, 2000), id])
}

async function deleteTask(db: Client, id: number): Promise<number> {
  return (await db.query('DELETE FROM tasks WHERE id = $1', [id])).rowCount
}

// ---- HTTP helpers ----

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
async function readBody(req: IncomingMessage): Promise<string> {
  let b = ''
  for await (const c of req) b += c
  return b
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(req))
}

// ---- views ----

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
 h1{margin-bottom:.2rem} .sub{color:#666;margin-top:0}
 .task{display:flex;align-items:center;gap:.6rem;padding:.5rem .7rem;border:1px solid #e2e2e2;border-radius:8px;margin:.4rem 0}
 .task.done .title{text-decoration:line-through;color:#999}
 .title{flex:1} a{color:#1a56c1}
 .pri{font-size:.75rem;padding:.1rem .4rem;border-radius:4px;background:#eee;color:#555}
 .pri.high{background:#fde2e1;color:#b3261e} .pri.low{background:#e8f0fe;color:#1a56c1}
 form.inline{display:inline;margin:0} button{cursor:pointer;font:inherit;padding:.25rem .6rem;border:1px solid #ccc;border-radius:6px;background:#fff}
 input,textarea{font:inherit;padding:.4rem;border:1px solid #ccc;border-radius:6px}
 .add{display:flex;gap:.4rem;margin:1rem 0;flex-wrap:wrap}
</style></head><body>${body}</body></html>`
}

function taskRow(t: Task): string {
  return `<div class="task ${t.status}" data-testid="task-${t.id}" data-status="${t.status}">
   <form class=inline method=post action="/tasks/${t.id}/toggle"><button data-testid="toggle-${t.id}" title="toggle">${t.status === 'done' ? '↺' : '✓'}</button></form>
   <span class=title><a href="/task/${t.id}">${esc(t.title)}</a></span>
   <span class="pri ${PRIORITY_LABEL[t.priority]}">${PRIORITY_LABEL[t.priority]}</span>
   <form class=inline method=post action="/tasks/${t.id}/delete"><button data-testid="delete-${t.id}" title="delete">🗑</button></form>
  </div>`
}

function renderBoard(engine: string, tasks: Task[]): string {
  const open = tasks.filter((t) => t.status === 'todo')
  const done = tasks.filter((t) => t.status === 'done')
  const list = (ts: Task[]): string => (ts.length ? ts.map(taskRow).join('') : '<p class=sub>nothing here</p>')
  return page(
    'Task Board — zeropg',
    `<h1>Task Board</h1>
     <p class=sub>One app, one codebase. Engine: <b data-testid=engine>${esc(engine)}</b> — set <code>DATABASE_URL</code> to move from laptop to bucket to RDS with zero code change.</p>
     <form class=add method=post action="/tasks">
       <input name=title placeholder="what needs doing?" data-testid=new-title required style="flex:1;min-width:12rem">
       <select name=priority data-testid=new-priority><option value=1>high</option><option value=2 selected>normal</option><option value=3>low</option></select>
       <button data-testid=add>Add</button>
     </form>
     <h2>To do <span class=sub>(${open.length})</span></h2>
     <div data-testid=todo-list>${list(open)}</div>
     <h2>Done <span class=sub>(${done.length})</span></h2>
     <div data-testid=done-list>${list(done)}</div>`,
  )
}

function renderTask(t: Task): string {
  return page(
    `${t.title} — zeropg`,
    `<p><a href="/">← board</a></p>
     <h1 data-testid=task-title>${esc(t.title)}</h1>
     <p class=sub>status <b data-testid=task-status>${t.status}</b> · priority ${PRIORITY_LABEL[t.priority]} · created ${esc(t.created_at)}${t.done_at ? ` · done ${esc(t.done_at)}` : ''}</p>
     <form class=inline method=post action="/tasks/${t.id}/toggle"><input type=hidden name=return value="/task/${t.id}"><button data-testid=toggle>${t.status === 'done' ? 'Reopen' : 'Mark done'}</button></form>
     <h2>Notes</h2>
     <form method=post action="/tasks/${t.id}/notes">
       <textarea name=notes rows=5 style="width:100%" data-testid=notes>${esc(t.notes)}</textarea>
       <p><button data-testid=save-notes>Save notes</button></p>
     </form>`,
  )
}
