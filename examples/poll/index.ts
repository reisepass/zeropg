// Boot the poll app. Default datadir is examples/poll/data/poll (file://, durable,
// lock-guarded). Setup once: `npx prisma generate --schema examples/poll/prisma/schema.prisma`.
import { boot } from './boot.js'
import { createApp } from './app.js'

const port = Number(process.env.PORT ?? 8083)
const { prisma, applied, stop } = await boot({ dataDir: process.env.POLL_DATADIR })
const app = createApp(prisma)

app.listen(port, () => {
  const addr = app.address()
  const bound = typeof addr === 'object' && addr ? addr.port : port
  console.log(`poll READY on http://localhost:${bound}${applied ? `  migrated=${applied}` : ''}`)
})

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    app.close()
    void stop().finally(() => process.exit(0))
  })
}
