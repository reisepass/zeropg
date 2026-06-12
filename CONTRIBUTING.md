# Contributing to zeropg

Thanks for your interest! zeropg is young and moving fast; this guide keeps
contributions effective.

## Ground rules

- **Correctness claims need experiments.** Every durability/consistency
  behavior in this repo is backed by a harness in `experiments/` and raw data
  in `results/`. If your change touches the commit path, the lease, or
  restore, extend or add a harness and include the run output in your PR.
  The bar: would your change have survived E2b (crash matrix), E2c
  (incremental round-trip), and e4b (handover races)?
- **The bucket layout is an API.** `manifest.json` shape, key naming
  (`generations/<gen>/...`, fencing token embedded), and the conditional-PUT
  semantics are compatibility surfaces. Old buckets must keep opening.
- **One strong primitive.** Transports may only rely on atomic conditional
  PUT (create-if-absent + compare-and-swap). If your feature needs more from
  the store, it belongs behind a `CostModel`/capability flag, not in core.

## Dev setup

```bash
npm install
npx tsc --noEmit          # typecheck everything
```

The experiment harnesses run against a real GCS bucket (they are the test
suite — this project does not mock the object store):

```bash
export ZEROPG_BUCKET=<your-bucket>   # needs conditional-write permission
npx tsx experiments/e2-roundtrip.ts
npx tsx experiments/e2b-crash.ts
npx tsx experiments/e2c-incremental.ts
npx tsx experiments/e4b-handover.ts
```

CI runs typecheck + store-less unit checks; the GCS suites run pre-release.

## Project layout

| path | what |
|---|---|
| `packages/blobstore` | object-store transports (GCS today; S3/R2 welcome) |
| `packages/lease` | the writer lease + fencing tokens |
| `packages/objectstore-fs` | ZeroPG: restore/commit pipelines, durability modes, GC |
| `experiments/` | E0–E5 harnesses (the real test suite) |
| `scripts/` | deploy / branch / gc CLI tools |
| `docs/` | launch post, research notes |

Design docs: [DESIGN.md](DESIGN.md) (architecture), [V1-WAL-SHIPPING.md](V1-WAL-SHIPPING.md)
(incremental commits + hard-won corrections), [COST-MODEL.md](COST-MODEL.md)
(provider cost/limit policy), [STATUS.md](STATUS.md) (experiment scoreboard).

## Adding a transport (S3/R2)

Implement `BlobStore` from `@zeropg/blobstore` (get/put/list/delete/head +
getStream/putStream/copy) with honest conditional-PUT semantics, attach a
`CostModel`, and run E0 + E1 against the real service. ~200 lines if the
provider supports preconditions natively.

## Commit style

Imperative subject, body explains WHY (the repo history is a design log —
several commits document bugs found by live experiments; keep that standard).
