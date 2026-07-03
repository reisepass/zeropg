// Cloud Run (GCP) provider: live discovery over the Cloud Run Admin API v2,
// authenticated with ambient credentials (gcloud ADC locally, metadata server
// on GCP). No SDK dependency - plain fetch, same pattern as
// scripts/nightly-reset/reset.ts.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { FleetContext, Instance } from './types.js'

const execFileAsync = promisify(execFile)

interface RunEnvVar {
  name: string
  value?: string
}
interface RunContainer {
  image?: string
  env?: RunEnvVar[]
}
interface RunService {
  name: string
  uri?: string
  urls?: string[]
  ingress?: string
  updateTime?: string
  labels?: Record<string, string>
  template?: { containers?: RunContainer[] }
}

let cachedToken: { token: string; expires: number } | null = null

/** Access token: metadata server on GCP, `gcloud auth print-access-token` locally. */
export async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires) return cachedToken.token
  try {
    const r = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) },
    )
    if (r.ok) {
      const j = (await r.json()) as { access_token: string; expires_in: number }
      cachedToken = { token: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 }
      return j.access_token
    }
  } catch {
    /* not on GCP; fall through to gcloud */
  }
  const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token'])
  const token = stdout.trim()
  // gcloud tokens live ~1h; cache briefly so one CLI run reuses it.
  cachedToken = { token, expires: Date.now() + 10 * 60_000 }
  return token
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken()
  const res = await fetch(`https://run.googleapis.com/v2/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Cloud Run API ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

function envOf(svc: RunService, name: string): string | undefined {
  for (const c of svc.template?.containers ?? []) {
    const hit = c.env?.find((e) => e.name === name)
    if (hit?.value !== undefined) return hit.value
  }
  return undefined
}

/** A service counts as a zeropg instance when it carries the zeropg label or
 *  the ZEROPG_BUCKET/ZEROPG_PREFIX env vars any zeropg deploy sets. The env
 *  test also catches services deployed before the label convention existed. */
function toInstance(svc: RunService, ctx: FleetContext): Instance | null {
  const labels = svc.labels ?? {}
  const bucket = envOf(svc, 'ZEROPG_BUCKET')
  const prefix = envOf(svc, 'ZEROPG_PREFIX')
  const matchedBy: Array<'label' | 'env'> = []
  if (labels.zeropg !== undefined) matchedBy.push('label')
  if (bucket !== undefined || prefix !== undefined) matchedBy.push('env')
  if (matchedBy.length === 0) return null

  const shortName = svc.name.split('/').pop() ?? svc.name
  const image = svc.template?.containers?.[0]?.image ?? null
  const extensionsRaw = envOf(svc, 'ZEROPG_EXTENSIONS')
  return {
    name: shortName,
    context: ctx.name,
    project: ctx.project,
    region: ctx.region,
    url: svc.uri ?? svc.urls?.[0] ?? null,
    bucket: bucket ?? null,
    prefix: prefix ?? null,
    appLabel: envOf(svc, 'APP_LABEL') ?? null,
    durability: envOf(svc, 'ZEROPG_DURABILITY') ?? null,
    extensions: extensionsRaw ? extensionsRaw.split(',').map((s) => s.trim()).filter(Boolean) : [],
    image,
    ingress: svc.ingress ?? null,
    updateTime: svc.updateTime ?? null,
    labels,
    matchedBy,
  }
}

/** List all zeropg instances in one context (paginated). */
export async function listInstances(ctx: FleetContext): Promise<Instance[]> {
  const parent = `projects/${ctx.project}/locations/${ctx.region}`
  const out: Instance[] = []
  let pageToken = ''
  do {
    const q = pageToken ? `?pageSize=100&pageToken=${encodeURIComponent(pageToken)}` : '?pageSize=100'
    const page = await api<{ services?: RunService[]; nextPageToken?: string }>(`${parent}/services${q}`)
    for (const svc of page.services ?? []) {
      const inst = toInstance(svc, ctx)
      if (inst) out.push(inst)
    }
    pageToken = page.nextPageToken ?? ''
  } while (pageToken)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Roll a new revision by bumping ZEROPG_RESTART_NONCE (same mechanism as
 *  scripts/nightly-reset): after a local lease takeover (export/migrate) the
 *  still-running cloud instance is a fenced zombie whose writes fail until it
 *  restarts, so we restart it. */
export async function rollService(inst: Instance): Promise<void> {
  const base = `projects/${inst.project}/locations/${inst.region}/services/${inst.name}`
  const svc = await api<{ template: { containers: Array<{ env?: RunEnvVar[] }> } }>(base)
  const nonce = String(Date.now())
  for (const c of svc.template.containers) {
    c.env = c.env ?? []
    const existing = c.env.find((e) => e.name === 'ZEROPG_RESTART_NONCE')
    if (existing) existing.value = nonce
    else c.env.push({ name: 'ZEROPG_RESTART_NONCE', value: nonce })
  }
  await api(`${base}?updateMask=template`, { method: 'PATCH', body: JSON.stringify({ template: svc.template }) })
}

/** True when allUsers holds roles/run.invoker, i.e. the endpoint is public.
 *  zeropg has no auth of its own today, so this is the security posture. */
export async function isPublicInvoker(inst: Instance): Promise<boolean | null> {
  try {
    const policy = await api<{ bindings?: Array<{ role: string; members?: string[] }> }>(
      `projects/${inst.project}/locations/${inst.region}/services/${inst.name}:getIamPolicy`,
    )
    return (policy.bindings ?? []).some(
      (b) => b.role === 'roles/run.invoker' && (b.members ?? []).includes('allUsers'),
    )
  } catch {
    return null
  }
}
