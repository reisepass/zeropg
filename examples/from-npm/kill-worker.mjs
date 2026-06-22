// Child worker for 02-kill-9-recovery.mjs. Opens the datadir via @zeropg/client
// (the npm package) and commits rows in a tight loop, printing "committed <n>"
// to stdout after each statement resolves, until the parent SIGKILLs it. It
// NEVER calls end() - it is meant to die mid-flight so we can test recovery.
//
//   node kill-worker.mjs <dataDir> <startN>

import { connect } from '@zeropg/client'

const dataDir = process.argv[2]
const startN = Number(process.argv[3] ?? 1)

const db = await connect(`file://${dataDir}`, { noHmrPin: true })
await db.exec('create table if not exists rows_log (n int primary key, ts text)')

// Tell the parent we are live (lock held, instance open) before it starts
// counting commits / planning the kill.
process.stdout.write('ready\n')

let n = startN
for (;;) {
  // Each insert is its own autocommit statement. When this promise resolves the
  // statement has executed; the parent treats that as "reported committed".
  await db.query('insert into rows_log (n, ts) values ($1, $2)', [n, new Date().toISOString()])
  process.stdout.write(`committed ${n}\n`)
  n++
  await new Promise((r) => setTimeout(r, 10))
}
