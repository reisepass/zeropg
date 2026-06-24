// NIP-01 round-trip verifier for the nostream-on-zeropg Cloud Run service.
//
// Connects to the relay over wss, waits for the AUTH challenge (nostream sends
// one and drops a racing first frame otherwise), publishes a signed EVENT,
// asserts OK true, then opens a REQ subscription with an id filter and asserts
// the just-published event streams back followed by EOSE.
//
// Run with the nostr-tools + ws from znostr-relay/node_modules:
//   RELAY_URL=wss://host/ node --experimental-vm-modules \
//     -r ... examples/cloudrun/nostr/local/roundtrip.mjs
// (the run script below sets NODE_PATH to znostr-relay/node_modules)
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import WebSocket from 'ws'

const RELAY_URL = process.env.RELAY_URL
if (!RELAY_URL) { console.error('RELAY_URL required'); process.exit(2) }
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 30000)

function log(...a) { console.log(`[roundtrip ${(Date.now()-t0)}ms]`, ...a) }
const t0 = Date.now()

const sk = generateSecretKey()
const pk = getPublicKey(sk)
const marker = `zeropg-dragonfly-${Date.now()}-${Math.random().toString(16).slice(2)}`
const unsigned = {
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['t', 'zeropgtest']],
  content: marker,
}
const ev = finalizeEvent(unsigned, sk)
log('signed event id', ev.id, 'pubkey', pk)

const ws = new WebSocket(RELAY_URL, { handshakeTimeout: 15000 })
let okSeen = false
let eventSeen = false
let eoseSeen = false
let sawAuth = false
let published = false

const timer = setTimeout(() => {
  console.error('TIMEOUT: ok=%s event=%s eose=%s auth=%s', okSeen, eventSeen, eoseSeen, sawAuth)
  process.exit(1)
}, TIMEOUT_MS)

function publish() {
  if (published) return
  published = true
  log('publishing EVENT')
  ws.send(JSON.stringify(['EVENT', ev]))
}

ws.on('open', () => {
  log('ws open')
  // Give the relay a brief moment to send AUTH; if none arrives, publish anyway.
  setTimeout(() => { if (!sawAuth) { log('no AUTH challenge, publishing'); publish() } }, 1500)
})

ws.on('message', (raw) => {
  let msg
  try { msg = JSON.parse(raw.toString()) } catch { return }
  const type = msg[0]
  if (type === 'AUTH') {
    sawAuth = true
    log('AUTH challenge received; publishing after challenge')
    publish()
  } else if (type === 'OK') {
    const [, id, accepted, reason] = msg
    log('OK', id, accepted, reason || '')
    if (id === ev.id && accepted) {
      okSeen = true
      log('opening REQ subscription')
      ws.send(JSON.stringify(['REQ', 'sub1', { ids: [ev.id] }]))
    } else if (id === ev.id && !accepted) {
      console.error('EVENT rejected:', reason)
      process.exit(1)
    }
  } else if (type === 'EVENT') {
    const [, subId, got] = msg
    if (subId === 'sub1' && got && got.id === ev.id) {
      eventSeen = true
      log('REQ returned our event, content matches:', got.content === marker)
    }
  } else if (type === 'EOSE') {
    eoseSeen = true
    log('EOSE for', msg[1])
    if (okSeen && eventSeen) {
      clearTimeout(timer)
      log('ROUND-TRIP PASS')
      console.log(JSON.stringify({ pass: true, eventId: ev.id, pubkey: pk, marker }))
      ws.close()
      process.exit(0)
    }
  } else if (type === 'NOTICE') {
    log('NOTICE', msg[1])
  }
})

ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1) })
ws.on('close', () => { if (!(okSeen && eventSeen && eoseSeen)) { /* handled by timeout */ } })
