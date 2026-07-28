// E10 client half: the per-burst tunnel sweep.
//
//   node burst.mjs <wss://host/wire> <gapSeconds...>
//
// For each gap N in the sweep:
//   1. open a tunnel, time dial -> first byte (the hello frame)
//   2. send one trivial "query", time the round trip
//   3. close the tunnel
//   4. sleep N seconds with NOTHING open
//   5. reopen and repeat, so every gap's cost is measured by the burst that
//      follows it
//
// The reported numbers per gap are:
//   ttfbMs      dial -> hello frame. This is what a router's first query after
//               an idle gap would pay before any database work happens.
//   queryMs     hello -> reply. Round trip on an already-open tunnel.
//   bootSame    did we land on the same instance we left? false = the instance
//               died during the gap and this burst paid a cold start.
//   ticksDelta  server ticks accrued across the gap, vs gapMs/1000 expected.
//               ~= expected means the instance had full CPU while idle (warm
//               and, per E9, billed). ~0 means it was resident but throttled
//               (warm and free). n/a when the instance changed.
//
// Emits one JSON line per event, plus a final summary object.

const url = process.argv[2]
const gaps = process.argv.slice(3).map(Number)
if (!url || gaps.length === 0 || gaps.some(Number.isNaN)) {
  console.error('usage: node burst.mjs <wss://host/wire> <gapSeconds...>')
  process.exit(2)
}

const t0 = Date.now()
const line = (obj) => console.log(JSON.stringify({ t: Date.now() - t0, ...obj }))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * One burst: open, wait for hello, send one query, wait for the reply, close.
 * Returns the timings and the instance identity the burst landed on.
 */
function burst(label, sinceTick = -1) {
  return new Promise((resolve, reject) => {
    const dialAt = Date.now()
    const ws = new WebSocket(url)
    let helloAt = 0
    let hello = null
    let sentAt = 0
    let result = null
    const fail = (why) => (e) => {
      if (!result) reject(new Error(`${why}: ${e?.message || e?.type || e}`))
    }

    ws.onerror = fail('error')

    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data))
      if (msg.type === 'hello') {
        helloAt = Date.now()
        hello = msg
        // Fire the "query" as soon as the tunnel is usable.
        sentAt = Date.now()
        ws.send(JSON.stringify({ q: 'select 1', label, sinceTick }))
        return
      }
      if (msg.type === 'reply') {
        result = {
          label,
          ttfbMs: helloAt - dialAt,
          queryMs: Date.now() - sentAt,
          totalMs: Date.now() - dialAt,
          boot: msg.boot,
          serverTicksAtHello: hello.ticks,
          serverTicksAtReply: msg.ticks,
          serverUptimeMsAtHello: hello.uptimeMs,
          burstsServed: msg.bursts,
          gapSamples: msg.gapSamples || [],
          closedAt: 0,
        }
        ws.close()
      }
    }

    ws.onclose = () => {
      if (result) {
        result.closedAt = Date.now()
        resolve(result)
      } else {
        reject(new Error('closed before reply'))
      }
    }
  })
}

const run = async () => {
  line({ event: 'sweep-start', url, gaps })

  // Priming burst. Whatever state the service was in before the sweep is not
  // part of any gap measurement; this establishes a known-warm instance and a
  // known close time that gap 1 is measured from.
  let prev = await burst('prime')
  line({ event: 'burst', phase: 'prime', ...prev, gapBeforeSec: null })

  const rows = []
  for (const gapSec of gaps) {
    const closedAt = prev.closedAt
    await sleep(gapSec * 1000 - (Date.now() - closedAt) > 0 ? gapSec * 1000 - (Date.now() - closedAt) : 0)
    const gapMs = Date.now() - closedAt
    const cur = await burst(`after-${gapSec}s`, prev.serverTicksAtReply)

    const bootSame = cur.boot === prev.boot
    const ticksDelta = bootSame ? cur.serverTicksAtHello - prev.serverTicksAtReply : null

    // Summarize the CPU-work samples the server took while nothing was
    // connected. A stable workMs means a real core was available throughout;
    // an inflated one means the instance was scheduled but throttled.
    const gapWork = bootSame ? cur.gapSamples.filter((s) => s.at >= closedAt && s.at <= cur.closedAt) : []
    const workMsValues = gapWork.map((s) => s.workMs).sort((a, b) => a - b)
    const workStats = workMsValues.length
      ? {
          n: workMsValues.length,
          minMs: workMsValues[0],
          medMs: workMsValues[Math.floor(workMsValues.length / 2)],
          maxMs: workMsValues[workMsValues.length - 1],
        }
      : null

    const row = {
      gapSec,
      gapMs,
      ttfbMs: cur.ttfbMs,
      queryMs: cur.queryMs,
      totalMs: cur.totalMs,
      bootSame,
      bootBefore: prev.boot,
      bootAfter: cur.boot,
      ticksDelta,
      ticksExpectedIfFullCpu: Math.round(gapMs / 1000),
      gapWorkMs: workStats,
      verdict: !bootSame
        ? 'INSTANCE-DIED (cold start)'
        : ticksDelta >= Math.round(gapMs / 1000) * 0.8
          ? 'WARM-WITH-CPU (billed)'
          : ticksDelta <= Math.round(gapMs / 1000) * 0.2
            ? 'WARM-THROTTLED (free)'
            : 'WARM-PARTIAL-CPU',
    }
    rows.push(row)
    line({ event: 'gap-result', ...row })
    prev = cur
  }

  line({ event: 'sweep-done', rows })
}

run().catch((e) => {
  line({ event: 'fatal', msg: String(e.message || e) })
  process.exit(1)
})
