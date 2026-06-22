import { connect, serveWire } from '@zeropg/client'
import pg from 'pg'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const N = 5000
const now = () => Number(process.hrtime.bigint())

// --- in-process (our Client wrapper directly over PGlite, no socket) ---
const d1 = await mkdtemp(join(tmpdir(), 'bench-ip-'))
const ip = await connect('file://' + join(d1, 'db'), { noHmrPin: true })
await ip.exec('create table t(id int primary key, v text)')
await ip.query("insert into t values (1,'hello world')")
for (let i = 0; i < 300; i++) await ip.query('select v from t where id = 1') // warmup
let t = now()
for (let i = 0; i < N; i++) await ip.query('select v from t where id = 1')
const ipUs = (now() - t) / 1e3 / N
await ip.end()

// --- loopback wire (pg client over TCP to serveWire in THIS process) ---
const d2 = await mkdtemp(join(tmpdir(), 'bench-wire-'))
const wire = await serveWire({ dataDir: join(d2, 'db') })
const cl = new pg.Client({ connectionString: wire.url })
await cl.connect()
await cl.query('create table t(id int primary key, v text)')
await cl.query("insert into t values (1,'hello world')")
for (let i = 0; i < 300; i++) await cl.query('select v from t where id = 1') // warmup
t = now()
for (let i = 0; i < N; i++) await cl.query('select v from t where id = 1')
const wireUs = (now() - t) / 1e3 / N
await cl.end()
await wire.stop()

console.log(`wire url picked: ${wire.url}`)
console.log(`in-process:     ${ipUs.toFixed(1)} µs/query`)
console.log(`loopback wire:  ${wireUs.toFixed(1)} µs/query`)
console.log(`overhead:       +${(wireUs - ipUs).toFixed(1)} µs/query  (${(wireUs / ipUs).toFixed(2)}x)`)
