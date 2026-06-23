// Capture a screenshot of the board page for each ORM. Run: tsx test/shot.mjs
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
    proc.stdout.on('data', (d) => {
      buf += d.toString()
      const m = /on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf)
      if (m) resolve({ proc, url: m[1] })
    })
    proc.on('exit', (c) => reject(new Error(`server exited (${c})`)))
  })
}

for (const orm of ['drizzle', 'prisma']) {
  const dir = await mkdtemp(join(tmpdir(), `shot-${orm}-`))
  const { proc, url } = await startServer(orm, `file:${join(dir, 'pgdata')}`)
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 900, height: 560 } })
  await page.goto(url)
  await page.getByTestId('board-name').fill(`Launch (${orm})`)
  await page.getByTestId('create-board').click()
  await page.waitForLoadState('load')
  for (const t of ['design schema', 'write tests', 'ship it']) {
    await page.getByTestId('task-title').fill(t)
    await page.getByTestId('add-task').click()
    await page.waitForLoadState('load')
  }
  await page.getByTestId('cycle').first().click() // one into doing
  await page.waitForLoadState('load')
  const out = join(here, '..', `screenshot-${orm}.png`)
  await page.screenshot({ path: out })
  console.log(`wrote ${out}`)
  await browser.close()
  proc.kill('SIGINT')
  await new Promise((r) => proc.on('exit', r))
}
