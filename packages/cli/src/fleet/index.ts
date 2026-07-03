// `zeropg fleet <cmd>`: manage every zeropg instance you have, across cloud
// accounts, from one CLI. Everything supports --json so AI agents can drive
// the fleet (that IS the orchestrator: your local agent + your ambient cloud
// credentials; there is no server to run).

import type { FleetContext, Instance, InstanceStatus } from './types.js'
import { addContext, loadConfig, removeContext, resolveContexts } from './contexts.js'
import { listInstances } from './gcloud.js'
import { probeStatus, wakeAndWait } from './probe.js'
import { exportToFile, migrateTo } from './export.js'

type Flags = Record<string, string | boolean>

const FLEET_USAGE = `zeropg fleet - manage your scale-to-zero Postgres instances

Contexts (places to scan, stored in ~/.config/zeropg/contexts.json):
  zeropg fleet context add <name> --project <gcp-project> --region <region>
  zeropg fleet context rm <name>
  zeropg fleet context ls

Fleet (all commands take --json, and --context <name> | --project X --region Y):
  zeropg fleet ls                      discover instances (live; never wakes them)
  zeropg fleet status <service>        probe health + security posture (wakes it)
  zeropg fleet wake <service>          wake and wait until ready
  zeropg fleet url <service>           connection endpoints (HTTP faces)
  zeropg fleet export <service> --out <file.sql>
                                       pg_dump to a file (boots the DB locally
                                       from its bucket; fences the cloud
                                       instance until its next request)
  zeropg fleet migrate <service> --to <postgres-url> --yes
                                       graduation: stream pg_dump | psql into a
                                       managed Postgres you provisioned

Discovery is live from the cloud APIs (no registry, nothing to drift): a Cloud
Run service counts as zeropg when it carries ZEROPG_BUCKET/ZEROPG_PREFIX env
vars or a "zeropg" label.`

function flagStr(flags: Flags, k: string): string | undefined {
  return typeof flags[k] === 'string' ? (flags[k] as string) : undefined
}

async function discoverAll(flags: Flags): Promise<{ instances: Instance[]; errors: Array<{ context: string; error: string }> }> {
  const contexts = resolveContexts(flags)
  const instances: Instance[] = []
  const errors: Array<{ context: string; error: string }> = []
  const results = await Promise.allSettled(contexts.map((c) => listInstances(c)))
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') instances.push(...r.value)
    else errors.push({ context: contexts[i].name, error: r.reason instanceof Error ? r.reason.message : String(r.reason) })
  })
  return { instances, errors }
}

async function findInstance(name: string, flags: Flags): Promise<Instance> {
  const { instances, errors } = await discoverAll(flags)
  const hits = instances.filter((i) => i.name === name)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) {
    throw new Error(
      `"${name}" exists in several contexts (${hits.map((h) => h.context).join(', ')}); disambiguate with --context <name>`,
    )
  }
  const seen = instances.map((i) => i.name).join(', ') || '(none)'
  const scanErrs = errors.length ? `\nscan errors: ${errors.map((e) => `${e.context}: ${e.error}`).join('; ')}` : ''
  throw new Error(`no instance named "${name}" found. Discovered: ${seen}${scanErrs}`)
}

function table(rows: string[][], header: string[]): string {
  const all = [header, ...rows]
  const widths = header.map((_, c) => Math.max(...all.map((r) => (r[c] ?? '').length)))
  const line = (r: string[]) => r.map((cell, c) => (cell ?? '').padEnd(widths[c])).join('  ')
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n')
}

function fmtBytes(n: number | null): string {
  if (n === null) return '?'
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${Math.round(n / 1e3)} kB`
}

/** Endpoints an app or agent can use right now (per review: JSON must contain
 *  directly usable URLs, not just names and regions). */
function endpointsOf(inst: Instance) {
  const base = inst.url
  return {
    base,
    wake: base ? `${base}/wake` : null,
    ready: base ? `${base}/ready` : null,
    sql: base ? `${base}/sql` : null,
    rest: base ? `${base}/rest` : null,
    metrics: base ? `${base}/metrics` : null,
    bucket: inst.bucket && inst.prefix ? `gs://${inst.bucket}/${inst.prefix}` : null,
  }
}

function printStatus(st: InstanceStatus): void {
  const i = st.instance
  console.log(`${i.name}  (context ${i.context}, ${i.project}/${i.region})`)
  console.log(`  url          ${i.url ?? '(none)'}`)
  console.log(`  state        ${st.reachable ? (st.ready ? 'ready' : `booting (${st.phase ?? 'unknown'})`) : `unreachable${st.error ? `: ${st.error}` : ''}`}`)
  if (st.dbBytes !== null) console.log(`  db size      ${fmtBytes(st.dbBytes)}`)
  if (st.totalRssMB !== null) console.log(`  rss          ${st.totalRssMB} MB`)
  if (st.requestsServed !== null) console.log(`  requests     ${st.requestsServed}`)
  console.log(`  durability   ${i.durability ?? 'sleep (default)'}`)
  console.log(`  postgrest    ${st.postgrest === null ? '?' : st.postgrest ? 'on (/rest)' : 'off'}`)
  console.log(`  bucket       ${i.bucket && i.prefix ? `gs://${i.bucket}/${i.prefix}` : '(unknown)'}`)
  console.log(`  image        ${i.image ?? '?'}`)
  console.log(`  deployed     ${i.updateTime ?? '?'}`)
  const posture =
    st.publicInvoker === null
      ? 'unknown (could not read IAM policy)'
      : st.publicInvoker
        ? 'PUBLIC: allUsers can invoke, and zeropg has no built-in auth; anyone with the URL can run SQL'
        : 'restricted (IAM-gated invoker)'
  console.log(`  exposure     ${posture}`)
  console.log(`  probe        ${st.probeMs} ms (probing wakes a sleeping instance)`)
}

export async function runFleet(positionals: string[], flags: Flags): Promise<void> {
  const [cmd, arg] = positionals
  const json = flags.json === true

  switch (cmd) {
    case 'context': {
      const sub = arg
      if (sub === 'add') {
        const name = positionals[2]
        const project = flagStr(flags, 'project')
        const region = flagStr(flags, 'region')
        if (!name || !project || !region) throw new Error('usage: zeropg fleet context add <name> --project <p> --region <r>')
        const ctx: FleetContext = { name, provider: 'gcloud', project, region }
        addContext(ctx)
        console.log(`✓ added context ${name} (${project}/${region})`)
        return
      }
      if (sub === 'rm') {
        const name = positionals[2]
        if (!name) throw new Error('usage: zeropg fleet context rm <name>')
        console.log(removeContext(name) ? `✓ removed context ${name}` : `context ${name} not found`)
        return
      }
      if (sub === 'ls' || sub === undefined) {
        const cfg = loadConfig()
        if (json) return void console.log(JSON.stringify(cfg.contexts, null, 2))
        if (cfg.contexts.length === 0) return void console.log('(no contexts; add one: zeropg fleet context add <name> --project <p> --region <r>)')
        console.log(table(cfg.contexts.map((c) => [c.name, c.provider, c.project, c.region]), ['NAME', 'PROVIDER', 'PROJECT', 'REGION']))
        return
      }
      throw new Error(`unknown context subcommand: ${sub}`)
    }

    case 'ls': {
      const { instances, errors } = await discoverAll(flags)
      if (json) {
        console.log(JSON.stringify({ instances: instances.map((i) => ({ ...i, endpoints: endpointsOf(i) })), errors }, null, 2))
        return
      }
      if (instances.length === 0) console.log('no zeropg instances discovered')
      else
        console.log(
          table(
            instances.map((i) => [
              i.name,
              i.context,
              i.appLabel ?? '',
              i.bucket && i.prefix ? `gs://${i.bucket}/${i.prefix}` : '?',
              i.url ?? '?',
            ]),
            ['SERVICE', 'CONTEXT', 'APP', 'BUCKET', 'URL'],
          ),
        )
      for (const e of errors) console.error(`! context ${e.context}: ${e.error}`)
      if (!json) console.log(`\n${instances.length} instance(s). State not probed (probing wakes them); use: zeropg fleet status <service>`)
      return
    }

    case 'status': {
      if (!arg) throw new Error('usage: zeropg fleet status <service>')
      const inst = await findInstance(arg, flags)
      const st = await probeStatus(inst)
      if (json) console.log(JSON.stringify({ ...st, endpoints: endpointsOf(inst) }, null, 2))
      else printStatus(st)
      return
    }

    case 'wake': {
      if (!arg) throw new Error('usage: zeropg fleet wake <service>')
      const inst = await findInstance(arg, flags)
      if (!json) console.log(`waking ${inst.name} at ${inst.url}`)
      const r = await wakeAndWait(inst)
      if (json) console.log(JSON.stringify({ service: inst.name, ...r, endpoints: endpointsOf(inst) }, null, 2))
      else if (r.ready) console.log(`✓ ready in ${r.waitedMs} ms`)
      else console.log(`still not ready after ${r.waitedMs} ms (phase: ${r.phase ?? 'unknown'})`)
      if (!r.ready) process.exitCode = 1
      return
    }

    case 'url': {
      if (!arg) throw new Error('usage: zeropg fleet url <service>')
      const inst = await findInstance(arg, flags)
      const ep = endpointsOf(inst)
      if (json) {
        console.log(JSON.stringify({ service: inst.name, endpoints: ep }, null, 2))
        return
      }
      console.log(`base     ${ep.base ?? '(none)'}`)
      console.log(`sql      POST ${ep.sql ?? '(none)'}   body: {"sql":"select 1"}`)
      console.log(`rest     ${ep.rest ?? '(none)'}/<table>   (PostgREST, if enabled)`)
      console.log(`wake     GET ${ep.wake ?? '(none)'}  then poll ${ep.ready ?? ''}`)
      console.log(`bucket   ${ep.bucket ?? '(unknown)'}`)
      console.log(`\nThe Postgres wire port is loopback-only on Cloud Run; for psql/pg_dump`)
      console.log(`against this database use: zeropg fleet export ${inst.name} --out dump.sql`)
      return
    }

    case 'export': {
      if (!arg) throw new Error('usage: zeropg fleet export <service> --out <file.sql>')
      const out = flagStr(flags, 'out')
      if (!out) throw new Error('export requires --out <file.sql>')
      const inst = await findInstance(arg, flags)
      if (!json) {
        console.log(`exporting ${inst.name} from gs://${inst.bucket}/${inst.prefix}`)
        console.log(`(takes the writer lease: the cloud instance is fenced until its next boot)`)
      }
      await exportToFile(inst, out)
      if (json) console.log(JSON.stringify({ service: inst.name, out, ok: true }, null, 2))
      else console.log(`✓ dumped to ${out}`)
      return
    }

    case 'migrate': {
      if (!arg) throw new Error('usage: zeropg fleet migrate <service> --to <postgres-url> --yes')
      const to = flagStr(flags, 'to')
      if (!to) throw new Error('migrate requires --to <postgres-url> (provision the target yourself: Cloud SQL, Neon, Supabase, RDS, anything Postgres)')
      if (flags.yes !== true) {
        throw new Error(
          'migrate restores INTO the target database. Re-run with --yes once you are sure the target is the right (empty) database.',
        )
      }
      const inst = await findInstance(arg, flags)
      if (!json) console.log(`migrating ${inst.name}: pg_dump (from gs://${inst.bucket}/${inst.prefix}) | psql -> target`)
      await migrateTo(inst, to)
      if (json) console.log(JSON.stringify({ service: inst.name, migrated: true }, null, 2))
      else {
        console.log(`✓ restored into target. Next: repoint your app's DATABASE_URL, then archive the bucket state.`)
        console.log(`  Full runbook: docs/GRADUATION.md`)
      }
      return
    }

    default:
      console.log(FLEET_USAGE)
      if (cmd !== undefined && cmd !== 'help') process.exitCode = 1
  }
}
