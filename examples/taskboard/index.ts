// Boot the task board. The only environment knob that matters is DATABASE_URL.
//
//   npx tsx examples/taskboard/index.ts                       # file://./data/taskboard.db
//   DATABASE_URL=memory:// npx tsx examples/taskboard/index.ts # ephemeral
//   DATABASE_URL=https://my-zeropg.run.app npx tsx examples/taskboard/index.ts
//
// The same binary, the same SQL, the same UI — only the durable home changes.

import { openDb } from './db.js'
import { createApp } from './app.js'

const port = Number(process.env.PORT ?? 8082)

let opened
try {
  opened = await openDb()
} catch (e) {
  // A contended file:// lock (another process owns the datadir) surfaces here.
  // Exit non-zero with a clear signal rather than corrupting anything.
  console.error(`taskboard boot failed: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
}
const { db, appliedMigrations } = opened
const app = createApp(db)

app.listen(port, () => {
  // The READY line carries the ACTUAL bound port (PORT=0 picks a free one) so a
  // supervisor/test can detect boot and find where to connect.
  const addr = app.address()
  const bound = typeof addr === 'object' && addr ? addr.port : port
  console.log(
    `taskboard READY on http://localhost:${bound}  engine=${db.engine}` +
      (appliedMigrations.length ? `  migrated=[${appliedMigrations.join(',')}]` : ''),
  )
})

// Clean shutdown flushes/releases whatever the engine needs (file:// lock,
// bucket lease + final WAL ship). The unified client's end() handles all four.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    app.close()
    void db.end().finally(() => process.exit(0))
  })
}
