// Live fleet discovery shared by both console trust modes (local console and
// `--inspector`). One implementation of "what instances exist right now":
// scan every configured context with listInstances and merge. No caching, no
// stored registry - discovery is the truth (docs/FLEET.md).

import { loadConfig } from '../fleet/contexts.js'
import { listInstances } from '../fleet/gcloud.js'
import type { FleetContext, Instance } from '../fleet/types.js'

export interface DiscoveryResult {
  instances: Instance[]
  errors: Array<{ context: string; error: string }>
  contextCount: number
}

/** Contexts to scan: the saved config file when present, else an ad-hoc
 *  context from ZEROPG_FLEET_PROJECT/ZEROPG_FLEET_REGION. The env pair is how
 *  the containerized inspector names its home project - Cloud Run has no
 *  ~/.zeropg, and ADC comes from the runtime service account. */
export function discoveryContexts(): FleetContext[] {
  const cfg = loadConfig()
  if (cfg.contexts.length > 0) return cfg.contexts
  const project = process.env.ZEROPG_FLEET_PROJECT
  const region = process.env.ZEROPG_FLEET_REGION
  if (project && region) return [{ name: `${project}/${region}`, provider: 'gcloud', project, region }]
  return []
}

export async function discover(): Promise<DiscoveryResult> {
  const contexts = discoveryContexts()
  const instances: Instance[] = []
  const errors: Array<{ context: string; error: string }> = []
  const results = await Promise.allSettled(contexts.map((c) => listInstances(c)))
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') instances.push(...r.value)
    else errors.push({ context: contexts[i].name, error: r.reason instanceof Error ? r.reason.message : String(r.reason) })
  })
  return { instances, errors, contextCount: contexts.length }
}

export async function findByName(service: string, context: string | null): Promise<Instance | null> {
  const { instances } = await discover()
  return instances.find((i) => i.name === service && (!context || i.context === context)) ?? null
}
