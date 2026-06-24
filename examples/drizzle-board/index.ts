// Boot the reading-list board. Default datadir is examples/drizzle-board/data/board
// (file://, durable, lock-guarded). Migrations are applied at boot by Drizzle's
// own migrate() over the zeropg wire — no setup step needed.
import { boot } from './boot.js'
import { createApp } from './app.js'

const port = Number(process.env.PORT ?? 8085)
const { db, stop } = await boot({ dataDir: process.env.BOARD_DATADIR })
const app = createApp(db)

app.listen(port, () => {
  const addr = app.address()
  const bound = typeof addr === 'object' && addr ? addr.port : port
  console.log(`drizzle-board READY on http://localhost:${bound}`)
})

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    app.close()
    void stop().finally(() => process.exit(0))
  })
}
