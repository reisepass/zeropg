// Context config: ~/.zeropg/contexts.json (override dir with
// $ZEROPG_CONFIG_DIR, used by tests). ~/.zeropg is the single zeropg home dir
// (contexts + open-breadcrumbs); the pre-2026-07-04 location
// ~/.config/zeropg/contexts.json is still read as a fallback so existing
// setups keep working. This file is deliberately NOT a registry of databases -
// it only names provider+project+region tuples to scan.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FleetConfig, FleetContext } from './types.js'

export function configDir(): string {
  return process.env.ZEROPG_CONFIG_DIR || join(homedir(), '.zeropg')
}

function configPath(): string {
  return join(configDir(), 'contexts.json')
}

/** Old location, read-only fallback. */
function legacyConfigPath(): string {
  return join(homedir(), '.config', 'zeropg', 'contexts.json')
}

function readConfigFile(path: string): FleetConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as FleetConfig
    return Array.isArray(parsed.contexts) ? parsed : null
  } catch {
    return null
  }
}

export function loadConfig(): FleetConfig {
  const cfg = readConfigFile(configPath())
  if (cfg) return cfg
  if (!process.env.ZEROPG_CONFIG_DIR) {
    const legacy = readConfigFile(legacyConfigPath())
    if (legacy) return legacy
  }
  return { contexts: [] }
}

export function saveConfig(cfg: FleetConfig): void {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n')
}

/** Reject paste/typo artifacts (trailing dots, spaces, uppercase) at add time
 *  instead of letting them surface later as a Cloud Run 400 on every scan. */
export function validateContext(ctx: FleetContext): FleetContext {
  const name = ctx.name.trim()
  const project = ctx.project.trim()
  const region = ctx.region.trim()
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error(`invalid context name "${ctx.name}" (use lowercase letters, digits, - or _)`)
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error(`"${ctx.project}" does not look like a GCP project id (lowercase letters, digits, hyphens; 6-30 chars)`)
  if (!/^[a-z]+-[a-z]+\d$/.test(region)) throw new Error(`"${ctx.region}" does not look like a Cloud Run region (e.g. europe-west1, us-central1)`)
  return { ...ctx, name, project, region }
}

export function addContext(rawCtx: FleetContext): void {
  const ctx = validateContext(rawCtx)
  const cfg = loadConfig()
  if (cfg.contexts.some((c) => c.name === ctx.name)) {
    throw new Error(`context "${ctx.name}" already exists (remove it first: zeropg fleet context rm ${ctx.name})`)
  }
  cfg.contexts.push(ctx)
  saveConfig(cfg)
}

export function removeContext(name: string): boolean {
  const cfg = loadConfig()
  const before = cfg.contexts.length
  cfg.contexts = cfg.contexts.filter((c) => c.name !== name)
  saveConfig(cfg)
  return cfg.contexts.length < before
}

/**
 * Resolve which contexts a command should scan:
 *  - explicit --project/--region form an ad-hoc context (no config needed),
 *  - --context <name> selects one saved context,
 *  - otherwise all saved contexts.
 */
export function resolveContexts(flags: Record<string, string | boolean>): FleetContext[] {
  const s = (k: string): string | undefined => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)
  const project = s('project')
  const region = s('region')
  if (project || region) {
    if (!project || !region) throw new Error('--project and --region must be given together')
    const adhoc = validateContext({ name: 'adhoc', provider: 'gcloud', project, region })
    return [{ ...adhoc, name: `${adhoc.project}/${adhoc.region}` }]
  }
  const cfg = loadConfig()
  const wanted = s('context')
  if (wanted) {
    const ctx = cfg.contexts.find((c) => c.name === wanted)
    if (!ctx) throw new Error(`unknown context "${wanted}" (saved: ${cfg.contexts.map((c) => c.name).join(', ') || 'none'})`)
    return [ctx]
  }
  if (cfg.contexts.length === 0) {
    throw new Error(
      'no contexts configured. Add one:\n' +
        '  zeropg fleet context add <name> --project <gcp-project> --region <region>\n' +
        'or pass --project/--region directly.',
    )
  }
  return cfg.contexts
}
