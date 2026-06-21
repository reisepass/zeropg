#!/usr/bin/env -S npx tsx
// The `zeropg` CLI. In this repo run it via tsx:
//   npx tsx packages/cli/src/zeropg.ts migrate dev --name add_field
//   npx tsx packages/cli/src/zeropg.ts migrate deploy
//
// Commands:
//   zeropg migrate dev --name <name> [--schema p] [--migrations d] [--data d]
//   zeropg migrate deploy            [--migrations d] [--data d]
//   zeropg migrate status            [--migrations d]

import { migrateDev, migrateDeploy, listMigrations, type MigrateContext } from './migrate.js'

interface Parsed {
  positionals: string[]
  flags: Record<string, string | boolean>
}

function parse(argv: string[]): Parsed {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positionals.push(a)
    }
  }
  return { positionals, flags }
}

// The directory the user actually ran the command from. The bin's shebang runs
// it via `npx tsx`, and npx changes process.cwd() to wherever it resolves the
// tsx bin's package.json (here packages/cli), NOT the user's shell directory —
// so relative paths like prisma/migrations would resolve under packages/cli and
// silently miss the project. npm/npx always export INIT_CWD as the invocation
// dir; prefer it, falling back to process.cwd() when unset (e.g. node direct).
function invocationCwd(): string {
  return process.env.INIT_CWD || process.cwd()
}

function ctxFrom(flags: Record<string, string | boolean>): MigrateContext {
  const s = (k: string): string | undefined => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)
  return { cwd: invocationCwd(), schema: s('schema'), migrations: s('migrations'), data: s('data') }
}

const USAGE = `zeropg — Postgres in a bucket, on PGlite

Usage:
  zeropg migrate dev --name <name> [--schema <path>] [--migrations <dir>] [--data <dir>]
      Author the next migration from your edited schema (via a throwaway PGlite
      shadow) and apply it to the dev database. No external Postgres needed.

  zeropg migrate deploy [--migrations <dir>] [--data <dir>]
      Apply all pending committed migrations to the dev database.

  zeropg migrate status [--migrations <dir>]
      List migrations on disk.

Defaults: --schema prisma/schema.prisma  --migrations prisma/migrations  --data .zeropg/dev`

async function main(): Promise<void> {
  const { positionals, flags } = parse(process.argv.slice(2))
  const [group, sub] = positionals

  if (flags.help || group === 'help' || !group) {
    console.log(USAGE)
    return
  }

  if (group !== 'migrate') {
    console.error(`unknown command: ${group}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }

  switch (sub) {
    case 'dev': {
      const name = typeof flags.name === 'string' ? flags.name : ''
      if (!name) throw new Error('migrate dev requires --name <name>')
      const res = await migrateDev(name, ctxFrom(flags))
      console.log(res.created ? `✓ created ${res.created} and applied ${res.applied} migration(s)` : `✓ already in sync (applied ${res.applied} pending)`)
      break
    }
    case 'deploy': {
      const res = await migrateDeploy(ctxFrom(flags))
      console.log(`✓ deploy complete — applied ${res.applied} migration(s)`)
      break
    }
    case 'status': {
      const list = await listMigrations(ctxFrom(flags))
      console.log(list.length ? list.map((m) => `  ${m}`).join('\n') : '  (no migrations)')
      break
    }
    default:
      console.error(`unknown migrate subcommand: ${sub ?? '(none)'}\n\n${USAGE}`)
      process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(`zeropg: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
