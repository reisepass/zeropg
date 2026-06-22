// Child "B" for 04-crash-handoff.mjs. Tries to open a datadir that another
// process ("A") is currently holding, so it BLOCKS in the lock-acquire loop.
// When A is killed, B should reclaim the dead lock and open. It reports each
// stage on stdout so the parent can sequence the test.
//
//   node handoff-worker.mjs <dataDir>

import { connect } from '@zeropg/client'

const dataDir = process.argv[2]

process.stdout.write('waiting\n') // about to block on A's live lock
const db = await connect(`file://${dataDir}`, { noHmrPin: true, acquireTimeoutMs: 20_000 })

const seen = await db.query('select count(*)::int as c from rows_log')
process.stdout.write(`acquired ${seen.rows[0].c}\n`) // took over; report what A left behind

await db.exec('create table if not exists handoff (who text)')
await db.query("insert into handoff (who) values ('B took over after A was killed')")
process.stdout.write('done\n')
await db.end()
