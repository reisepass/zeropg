import { spawn } from 'node:child_process'
const t0 = Date.now()
const p = spawn('node', ['examples/cloudrun/httpbin/app/server.mjs'], {
  env: { ...process.env, PORT: '8077', PGHOST: '127.0.0.1', PGPORT: '5610' },
  stdio: 'ignore',
})
let ok = false
while (!ok && Date.now() - t0 < 10000) {
  try {
    const r = await fetch('http://127.0.0.1:8077/healthz')
    if (r.ok) ok = true
  } catch { await new Promise(r => setTimeout(r, 20)) }
}
console.log('app boot -> /healthz 200 in', Date.now() - t0, 'ms (local, app process only)')
// also time first stateless echo and first DB capture
let s = Date.now()
await fetch('http://127.0.0.1:8077/get')
console.log('first /get (stateless):', Date.now() - s, 'ms')
s = Date.now()
const cap = await fetch('http://127.0.0.1:8077/b/boottest', { method:'POST', body:'x' })
console.log('first /b capture (DB, lazy schema ensure):', Date.now() - s, 'ms, status', cap.status)
p.kill()
