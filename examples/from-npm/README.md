# zeropg from-npm examples

Standalone examples that consume **`@zeropg/client` from npm** (not the workspace) to drive real PGlite and work through the failure cases - `kill -9` crash recovery and concurrent-opener lockout.

## Setup (pnpm)

```sh
cd examples/from-npm
pnpm install
```

> Note: if your machine has an npm supply-chain policy (`min-release-age` / `before`) that hides brand-new versions, **pnpm ignores it** and installs `@zeropg/client@0.0.1` straight from the registry. (With npm you'd need `npm install --globalconfig /dev/null`.)

## Run

```sh
pnpm basic            # 01 - CRUD + transaction + durable reopen
pnpm kill-test        # 02 - kill -9 the holder repeatedly, prove no corruption
pnpm concurrent-test  # 03 - second concurrent opener is locked out
pnpm handoff-test     # 04 - holder killed while another waits; waiter takes over
pnpm all              # everything
```

## What each one proves

| Script | Scenario | Assertions |
| --- | --- | --- |
| `01-basic.mjs` | normal use on `file://` | CRUD, a transaction, and data surviving a clean close + reopen |
| `02-kill-9-recovery.mjs` | `kill -9` the writer mid-flight, 4 rounds | reopens without corruption; the dead lock is **reclaimed fast** (~80-95ms, not a 10s wait-out); all cleanly-committed rows intact; datadir writable again |
| `03-concurrent-lockout.mjs` | two openers of one datadir at once | the second is rejected with `LockTimeoutError` - never a co-resident second writer (the thing that corrupts raw PGlite); after release, the next opener sees the data intact |
| `04-crash-handoff.mjs` | the real HMR / dev-server case: holder is `kill -9`'d **while a second process is already blocked waiting** | the waiter reclaims the dead lock, opens a single consistent writer, sees all the dead holder's committed rows, and writes its own - no corruption |

## What this does and does not guarantee (honest scope)

The cross-process lock (a namespaced `<datadir>.zeropg.lock`) prevents the **#1 cause of PGlite corruption: two processes opening the same datadir at once** (HMR reload keeping the old instance alive, two `tsx watch`, nodemon overlap). When a holder dies, its lock is reclaimed by liveness probe (dead PID -> reclaim), not stolen from a live one. That is what these tests assert.

**Observed (not just non-corruption):** on PGlite `0.5.3`, every row the worker reported as committed *also survived* the `kill -9` (e.g. 25/25 each round in `02`, all 57 in `04`). PGlite is real Postgres with WAL crash recovery, so a `kill -9` is a normal crash it recovers from on reopen.

What the wrapper lock does **not** add (these live inside PGlite itself, not above it): WAL/checkpoint durability internals, partial-init detection/backup, etc. For those, run a PGlite build that bakes in its own datadir lock + crash-safety (the `pglite-kill-dash-9` fork) - `@zeropg/client` coexists with it (its lock is in a separate file) and you can set `nativeDatadirLock: true` to skip the now-redundant wrapper lock.
