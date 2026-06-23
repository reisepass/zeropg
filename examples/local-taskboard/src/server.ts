// A real little web app (task board) that runs on EITHER Drizzle or Prisma over
// a local zeropg Postgres, chosen by DB_ORM. The HTTP layer is ORM-agnostic - it
// only talks to the `Store` interface; the ORM-specific code lives in
// ../drizzle/store.ts and ../prisma/store.ts.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { boardsPage, boardPage } from './render.ts'
import type { Store } from './types.ts'

const ORM = (process.env.DB_ORM ?? 'drizzle').toLowerCase()

async function makeStore(): Promise<Store> {
  if (ORM === 'prisma') return (await import('../prisma/store.ts')).createStore()
  if (ORM === 'drizzle') return (await import('../drizzle/store.ts')).createStore()
  throw new Error(`DB_ORM must be 'drizzle' or 'prisma', got '${ORM}'`)
}

function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => resolve(new URLSearchParams(b)))
  })
}
const html = (res: ServerResponse, body: string, code = 200): void => {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}
const redirect = (res: ServerResponse, to: string): void => {
  res.writeHead(303, { location: to })
  res.end()
}

async function route(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const m = (re: RegExp): RegExpExecArray | null => re.exec(path)

  if (req.method === 'GET' && path === '/') {
    return html(res, boardsPage(await store.listBoards(), ORM))
  }
  let g: RegExpExecArray | null
  if (req.method === 'GET' && (g = m(/^\/boards\/(\d+)$/))) {
    const found = await store.getBoard(Number(g[1]))
    if (!found) return html(res, '<p>board not found</p>', 404)
    return html(res, boardPage(found.board, found.tasks, ORM))
  }
  if (req.method === 'POST' && path === '/boards') {
    const name = (await readBody(req)).get('name')?.trim()
    if (name) {
      const b = await store.createBoard(name)
      return redirect(res, `/boards/${b.id}`)
    }
    return redirect(res, '/')
  }
  if (req.method === 'POST' && (g = m(/^\/boards\/(\d+)\/tasks$/))) {
    const title = (await readBody(req)).get('title')?.trim()
    if (title) await store.addTask(Number(g[1]), title)
    return redirect(res, `/boards/${g[1]}`)
  }
  if (req.method === 'POST' && (g = m(/^\/tasks\/(\d+)\/cycle$/))) {
    await store.cycleTask(Number(g[1]))
    return redirect(res, req.headers.referer ?? '/')
  }
  if (req.method === 'POST' && (g = m(/^\/tasks\/(\d+)\/delete$/))) {
    await store.deleteTask(Number(g[1]))
    return redirect(res, req.headers.referer ?? '/')
  }
  html(res, '<p>not found</p>', 404)
}

export interface RunningApp {
  url: string
  close: () => Promise<void>
}

/** Boot the store + HTTP server. PORT=0 picks a free port (read back from .url). */
export async function start(port = Number(process.env.PORT ?? 0)): Promise<RunningApp> {
  const store = await makeStore()
  await store.init()
  const server: Server = createServer((req, res) => {
    route(store, req, res).catch((e) => {
      console.error(e)
      html(res, '<p>server error</p>', 500)
    })
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  const addr = server.address()
  const realPort = typeof addr === 'object' && addr ? addr.port : port
  return {
    url: `http://127.0.0.1:${realPort}`,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()))
      await store.close()
    },
  }
}

// CLI entry: `tsx src/server.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await start()
  console.log(`task board (${ORM}) on ${app.url}`)
  const bye = (): void => void app.close().finally(() => process.exit(0))
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}
