// Boot the task board. The only environment knob that matters is DATABASE_URL.
//
//   npx tsx examples/taskboard/index.ts                       # file://./data/taskboard.db
//   DATABASE_URL=memory:// npx tsx examples/taskboard/index.ts # ephemeral
//   DATABASE_URL=https://my-zeropg.run.app npx tsx examples/taskboard/index.ts
//
// The same binary, the same SQL, the same UI — only the durable home changes.

import { openDb } from './db.js'
import { createApp } from './app.js'

const { db, appliedMigrations } = await openDb()
const app = createApp(db)
const port = Number(process.env.PORT ?? 8082)

app.listen(port, () => {
  console.log(
    `taskboard on http://localhost:${port}  engine=${db.engine}` +
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
