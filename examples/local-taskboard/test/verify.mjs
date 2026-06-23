// Drives the real task-board app end-to-end in a browser, for BOTH ORMs, against
// fresh local zeropg datadirs. Run: pnpm verify
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SERVER = join(here, '..', 'src', 'server.ts')

function startServer(orm, databaseUrl) {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', SERVER], {
      env: { ...process.env, DB_ORM: orm, PORT: '0', DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let buf = ''
    const t = setTimeout(() => reject(new Error(`[${orm}] server start timeout`)), 25000)
    proc.stdout.on('data', (d) => {
      buf += d.toString()
      const m = /on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf)
      if (m) { clearTimeout(t); resolve({ proc, url: m[1] }) }
    })
    proc.on('exit', (c) => reject(new Error(`[${orm}] server exited early (code ${c})`)))
  })
}

async function drive(orm, url) {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  let pass = 0
  const ok = (c, m) => {
    if (!c) throw new Error(`[${orm}] FAIL: ${m}`)
    console.log(`  ok  [${orm}] ${m}`)
    pass++
  }

  await page.goto(url)
  ok((await page.getByTestId('orm').textContent()) === orm, `index reports ORM = ${orm}`)
  ok(await page.getByTestId('empty').isVisible(), 'starts with no boards')

  const boardName = `Launch (${orm})`
  await page.getByTestId('board-name').fill(boardName)
  await page.getByTestId('create-board').click()
  await page.waitForLoadState('load')
  ok((await page.getByTestId('board-title').textContent()) === boardName, 'create board -> own URL /boards/:id')
  ok(/\/boards\/\d+$/.test(new URL(page.url()).pathname), `board has its own URL (${new URL(page.url()).pathname})`)

  for (const title of ['design schema', 'write tests']) {
    await page.getByTestId('task-title').fill(title)
    await page.getByTestId('add-task').click()
    await page.waitForLoadState('load')
  }
  ok((await page.getByTestId('task').count()) === 2, 'added two tasks')
  ok((await page.getByTestId('col-todo').textContent()).includes('(2)'), 'both tasks start in todo')

  await page.getByTestId('cycle').first().click()
  await page.waitForLoadState('load')
  ok((await page.getByTestId('col-doing').textContent()).includes('(1)'), 'cycle moved a task todo -> doing')

  await page.getByTestId('delete').first().click()
  await page.waitForLoadState('load')
  ok((await page.getByTestId('task').count()) === 1, 'delete removed a task (1 left)')

  // Durability: reload the board URL directly; the surviving task is still there.
  await page.reload()
  ok((await page.getByTestId('task').count()) === 1, 'task persisted across reload')

  await page.goto(url + '/')
  ok((await page.getByTestId('board-link').count()) >= 1, 'board appears on the index')

  await browser.close()
  return pass
}

let total = 0
for (const orm of ['drizzle', 'prisma']) {
  console.log(`\n### ${orm} ###`)
  const dir = await mkdtemp(join(tmpdir(), `tb-${orm}-`))
  const databaseUrl = `file:${join(dir, 'pgdata')}`
  const { proc, url } = await startServer(orm, databaseUrl)
  try {
    total += await drive(orm, url)
  } finally {
    proc.kill('SIGINT')
    await new Promise((r) => proc.on('exit', r))
  }
}
console.log(`\nPASS — ${total} assertions across drizzle + prisma, driven in a real browser`)
