// Live health probing of a zeropg instance's HTTP control face.
// IMPORTANT: any request to a scale-to-zero Cloud Run service wakes it (that
// is the platform model). `fleet ls` therefore never probes; `fleet status`
// and `fleet wake` do, and the CLI says so.

import type { Instance, InstanceStatus } from './types.js'
import { isPublicInvoker } from './gcloud.js'

interface UpBody {
  ok?: boolean
  phase?: string
}
interface MetricsBody {
  phase?: string
  dbBytes?: string
  totalRssMB?: number
  requestsServed?: number
  fencingToken?: number | string | null
  postgrest?: boolean
  durability?: string | null
}

/** Fetch a URL and JSON-parse only if it is actually JSON. Returns the parsed
 *  body (or null for non-JSON, e.g. an app's HTML) plus the HTTP status, so a
 *  caller can tell "answered but not the zeropg control face" from "down". */
async function tryJson<T>(url: string, timeoutMs: number): Promise<{ status: number; body: T | null }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  const looksJson = /^[\s﻿]*[[{]/.test(text)
  let body: T | null = null
  if (looksJson) {
    try {
      body = JSON.parse(text) as T
    } catch {
      body = null
    }
  }
  return { status: res.status, body }
}

export async function probeStatus(inst: Instance, opts: { timeoutMs?: number } = {}): Promise<InstanceStatus> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const t0 = performance.now()
  const status: InstanceStatus = {
    instance: inst,
    reachable: false,
    hasControlFace: false,
    httpStatus: null,
    phase: null,
    ready: false,
    dbBytes: null,
    totalRssMB: null,
    requestsServed: null,
    fencingToken: null,
    postgrest: null,
    publicInvoker: null,
    probeMs: 0,
    error: null,
  }
  const [posture] = await Promise.allSettled([isPublicInvoker(inst)])
  if (posture.status === 'fulfilled') status.publicInvoker = posture.value

  if (!inst.url) {
    status.error = 'service has no URL'
    status.probeMs = Math.round(performance.now() - t0)
    return status
  }
  try {
    const { status: httpStatus, body: up } = await tryJson<UpBody>(`${inst.url}/up`, timeoutMs)
    // Any HTTP answer means the container is up (the request just woke it).
    status.reachable = true
    status.httpStatus = httpStatus
    if (up && (typeof up.phase === 'string' || typeof up.ok === 'boolean')) {
      // Bare zeropg standalone server: it has the JSON control face.
      status.hasControlFace = true
      status.phase = up.phase ?? null
      status.ready = up.ok === true
      if (status.ready) {
        try {
          const { body: m } = await tryJson<MetricsBody>(`${inst.url}/metrics`, timeoutMs)
          if (m) {
            status.dbBytes = m.dbBytes !== undefined ? Number(m.dbBytes) : null
            status.totalRssMB = m.totalRssMB ?? null
            status.requestsServed = m.requestsServed ?? null
            status.fencingToken = m.fencingToken ?? null
            status.postgrest = m.postgrest ?? null
          }
        } catch {
          /* metrics are best-effort; /up already told us it is ready */
        }
      }
    } else {
      // App service (PrivateBin, NocoDB, ...) fronting zeropg: no control face.
      // It answered HTTP, so the container is up; treat <500 as serving.
      status.hasControlFace = false
      status.ready = httpStatus < 500
    }
  } catch (e) {
    // Only a network/timeout failure reaches here now - genuinely unreachable.
    const msg = e instanceof Error ? e.message : String(e)
    status.error = /timeout|aborted|timed out/i.test(msg)
      ? `no response within ${Math.round(timeoutMs / 1000)}s (cold start may take longer; try wake)`
      : msg
  }
  status.probeMs = Math.round(performance.now() - t0)
  return status
}

/** GET /wake then poll until the instance is serving. A bare zeropg server
 *  reports readiness as JSON on /ready or /up; an app service (PrivateBin,
 *  NocoDB, ...) has no control face, so any HTTP answer below 500 means its
 *  container is up. Handles both, and non-JSON bodies, without crashing. */
export async function wakeAndWait(
  inst: Instance,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ ready: boolean; waitedMs: number; phase: string | null; appService: boolean }> {
  if (!inst.url) throw new Error(`${inst.name}: service has no URL`)
  const timeoutMs = opts.timeoutMs ?? 120_000
  const pollMs = opts.pollMs ?? 1_500
  const t0 = performance.now()
  await fetch(`${inst.url}/wake`, { signal: AbortSignal.timeout(30_000) }).catch(() => {
    /* the request itself is the wake; readiness comes from polling below */
  })
  let phase: string | null = null
  const done = (ready: boolean, appService: boolean) => ({
    ready,
    appService,
    waitedMs: Math.round(performance.now() - t0),
    phase,
  })
  while (performance.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${inst.url}/up`, { signal: AbortSignal.timeout(30_000) })
      const text = await res.text()
      const body = /^[\s﻿]*[[{]/.test(text) ? (JSON.parse(text) as { ready?: boolean; ok?: boolean; phase?: string }) : null
      if (body && (typeof body.ok === 'boolean' || typeof body.phase === 'string')) {
        // zeropg control face
        phase = body.phase ?? null
        if (res.status === 200 && body.ok !== false) return done(true, false)
      } else if (res.status < 500) {
        // app service (or any non-control-face 2xx/3xx/4xx): container is up
        return done(true, true)
      }
    } catch {
      /* instance still coming up */
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return done(false, false)
}
