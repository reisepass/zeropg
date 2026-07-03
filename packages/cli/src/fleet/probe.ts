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

async function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  // /up answers 503 with a JSON body while booting; that is still signal.
  return (await res.json()) as T
}

export async function probeStatus(inst: Instance, opts: { timeoutMs?: number } = {}): Promise<InstanceStatus> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const t0 = performance.now()
  const status: InstanceStatus = {
    instance: inst,
    reachable: false,
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
    const up = await getJson<UpBody>(`${inst.url}/up`, timeoutMs)
    status.reachable = true
    status.phase = up.phase ?? null
    status.ready = up.ok === true
    if (status.ready) {
      try {
        const m = await getJson<MetricsBody>(`${inst.url}/metrics`, timeoutMs)
        status.dbBytes = m.dbBytes !== undefined ? Number(m.dbBytes) : null
        status.totalRssMB = m.totalRssMB ?? null
        status.requestsServed = m.requestsServed ?? null
        status.fencingToken = m.fencingToken ?? null
        status.postgrest = m.postgrest ?? null
      } catch {
        /* metrics are best-effort; /up already told us it is ready */
      }
    }
  } catch (e) {
    status.error = e instanceof Error ? e.message : String(e)
  }
  status.probeMs = Math.round(performance.now() - t0)
  return status
}

/** GET /wake then poll until the instance reports ready. Older deployed images
 *  predate /wake and /ready and only serve /up (the nightly reset smokes /up
 *  for the same reason), so a 404 from /ready falls back to polling /up. */
export async function wakeAndWait(
  inst: Instance,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ ready: boolean; waitedMs: number; phase: string | null }> {
  if (!inst.url) throw new Error(`${inst.name}: service has no URL`)
  const timeoutMs = opts.timeoutMs ?? 120_000
  const pollMs = opts.pollMs ?? 1_500
  const t0 = performance.now()
  await fetch(`${inst.url}/wake`, { signal: AbortSignal.timeout(30_000) }).catch(() => {
    /* the request itself is the wake; readiness comes from polling below */
  })
  let phase: string | null = null
  let path = '/ready'
  while (performance.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${inst.url}${path}`, { signal: AbortSignal.timeout(30_000) })
      const body = (await res.json()) as { ready?: boolean; ok?: boolean; phase?: string; error?: string }
      if (path === '/ready' && res.status === 404 && body.error === 'not found') {
        path = '/up'
        continue
      }
      phase = body.phase ?? null
      const ready = path === '/ready' ? res.status === 200 && body.ready !== false : res.status === 200 && body.ok === true
      if (ready) return { ready: true, waitedMs: Math.round(performance.now() - t0), phase }
    } catch {
      /* instance still coming up */
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return { ready: false, waitedMs: Math.round(performance.now() - t0), phase }
}
