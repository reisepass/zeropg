# Beyond-memory writes + scale-to-zero: the option space

Status: **options inventory, no decision.** The question: how could zeropg support
a **20GB+ database with out-of-memory (lazy) WRITES** while keeping some form of
**scale-to-zero**? Today's flagship mode can't: the datadir lives on tmpfs (RAM)
and the bucket is the only durable home, with no in-place page writes, so the DB
must fit in memory (see [LAZY-PAGEFAULT-RESTORE-from-blob.md](../LAZY-PAGEFAULT-RESTORE-from-blob.md)
and the "why writes are the wall" reasoning: object storage has no `pwrite` to an
offset, and the whole-datadir tarball base does not scale).

The clarifying frame from the SQLite comparison: **SQLite and Postgres both scale
to TBs without holding the DB in memory** - they use a bounded page cache over a
**random-access file on a real disk** with in-place `pwrite`. The ceiling is not
the engine; it is "the durable medium is an object store with no in-place writes,
and there is no persistent disk." Every option below is a different way to restore
a random-access-writable medium under the engine.

---

## Comparison at a glance

| # | Option | OOM writes? | True $0 idle? | 20GB cold start | Effort | Keeps "just Postgres"? |
|---|---|---|---|---|---|---|
| 1 | Persistent disk + suspend (Fly-style) | **yes** | no (small disk fee) | **instant** (disk warm) | **low** | yes |
| 2 | Disk-as-cache over bucket truth (Neon-lite, our primitives) | yes | yes | fast (lazy) | high | mostly (custom VFS) |
| 3 | Native engine hooking Postgres smgr (Rust/C++) | yes | yes | fast (lazy) | very high | yes (it IS Postgres) |
| 4 | Lazy reads + memory-capped writes (hybrid) | **no** (writes ≤ RAM) | yes | fast (lazy reads) | medium | yes |
| 5 | Adopt an existing object-store Postgres (OrioleDB / Neon OSS) | yes | depends | depends | high (integration) | yes-ish |
| 6 | Don't build it - graduate via connection string | n/a | yes (zeropg stays small) | n/a | none (exists) | yes |

---

## 1. Persistent disk + suspend-to-zero (the Fly.io volumes model) — the pragmatic jerry-rig

**Idea.** Stop treating the bucket as the live medium. Put the datadir on a **real
persistent disk** (Fly volume, Hetzner volume, k8s PVC, EBS) and let the engine do
exactly what SQLite/Postgres always do: bounded buffer pool, in-place `pwrite`,
only the working set in RAM. The bucket goes back to being **WAL/backup**, i.e. the
literal Litestream deployment model - which [DESIGN.md §4.7](../DESIGN.md) already
names ("Anything with a real disk: NodeFS as the working dir... the literal
Litestream deployment model").

**Why it gives scale-to-zero anyway.** Fly machines **auto-stop / suspend** while
the **volume persists**. On the next request the machine resumes against a disk
that is already warm - so a 20GB DB resumes in seconds with **no 20GB restore**,
because nothing was torn down but the CPU. This is the one place "disk + scale to
zero" actually composes (Cloud Run / serverless-HTTP can't: no persistent volume).

**Variants.**
- **1a — PGlite on NODEFS** over the volume: keeps the embedded/"same package"
  story; needs verification that PGlite's WASM NODEFS does true random-access I/O
  and doesn't buffer whole relations into WASM memory (open item).
- **1b — real Postgres** on the volume + our WAL-ship-to-bucket for backup/branch.
  Loses the in-process embedding, but it is bulletproof and obvious.

**Cost / tradeoff.** Not truly $0 idle: you pay for the volume while stopped (Fly
~$0.15/GB-mo ⇒ 20GB ≈ $3/mo) + compute only while awake. You are pinned to the
volume's machine/region. In exchange: real OOM writes, instant large cold start,
near-zero engine work.

**Effort: LOW.** The standalone server is already Fly-ready (raw-wire 5432). This
is mostly deployment + a backup/restore story. **This is the most realistic path
to "20GB with writes, still mostly scale-to-zero" in the near term.**

---

## 2. Disk-as-bounded-cache over bucket truth (Neon-lite on our own primitives)

**Idea.** Keep the bucket as the source of truth and truly-$0 idle, but make local
storage a **bounded buffer pool over object storage**: lazy-fault pages in on read
(the spike already does this), and **write dirty pages back** to the bucket as
immutable page-group / layer objects, with the manifest CAS as the commit point.
Compaction merges layers; GC reclaims superseded ones.

**What it buys.** OOM writes with no persistent volume - the holy grail config.

**What it costs.** This is the hard part flagged repeatedly:
- **Write amplification**: object storage has no in-place write, so a one-row
  UPDATE either re-PUTs a whole page-group (huge amplification) or you defer to
  async materialization.
- **Dirty-page durability before eviction**: cannot drop a written-but-unshipped
  page; must pin-until-durable or write back, and bound the dirty set.
- **A page→object index** in the manifest that scales to millions of pages.
- **Crash-consistent, atomic page-versioned commit** + GC.

Done right this is **Neon's pageserver / turbolite's page-group+manifest**, rebuilt
on conditional-PUT. **Effort: HIGH**, and it is a research-grade storage engine, not
a VFS tweak. It is the "become Neon, the simplified way" path.

---

## 3. Reimplement a PGlite-equivalent natively (Rust/C++) hooking the storage manager

**Idea (the user's).** PGlite is WASM with an Emscripten **virtual FS**, which forced
the lazy spike to hook at the `read()` layer and bridge sync-over-async with
SharedArrayBuffer + Atomics - clumsy. A **native** single-process Postgres (or a
Postgres-compatible engine) compiled to native code gives **direct disk syscalls**
and, more importantly, lets you hook at the **right layer: the storage manager
(`smgr`) / buffer manager**, not the filesystem.

**Why the layer matters.** Hooking `smgr`/bufmgr is exactly how **Neon** (custom
smgr → GetPage@LSN over the network) and **OrioleDB** (table access method + S3)
work. At that layer you can implement a proper bucket-backed buffer pool: async page
fetch, real LRU eviction, dirty write-back, GetPage@LSN - none of the WASM
sync-over-async pain. You stop fighting the VFS and implement paging where Postgres
expects it.

**Variants.**
- **3a — build it**: a native single-process Postgres + a custom bucket-backed smgr
  with local cache. This is essentially a Neon compute node, minus the safekeeper
  quorum. **Effort: VERY HIGH** (person-years of engine work; the WASM build burden
  DESIGN §7 warned about, in reverse).
- **3b — adopt instead of build** (see Option 5): use an engine that already did the
  pluggable-storage + object-store work rather than reimplementing.

**What it buys.** The "proper" version of Option 2, in native code: OOM writes,
truly-$0 idle, and full control of paging. **What it costs.** A database-engine
project and its perpetual maintenance - a different company than a 2,500-line VFS.

---

## 4. Lazy reads + memory-capped writes (hybrid promote-on-write) — partial, honest

**Idea.** Reads lazy-fault (any size); on first write, hydrate the working set and
become a normal in-memory writer shipping WAL.

**Why it is only partial.** It does **not** cross the write wall: writes still
require the writable/dirty set to fit memory. It raises the **read** ceiling to
multi-GB read-mostly data, not the **write** ceiling. List it honestly as "the read
half" - good for read-mostly large DBs with a small write set, not a 20GB-writes
answer. Useful and cheap; just not the thing asked for here.

---

## 5. Adopt an existing object-storage Postgres engine

**Idea.** Don't invent the pageserver - integrate one that exists.
- **OrioleDB decoupled storage**: a Postgres extension with experimental **S3-backed
  tables** (DESIGN already cites it). Closest "Postgres with object-store storage"
  off the shelf.
- **Neon OSS** (the full pageserver/safekeeper) - powerful but the heavy ops system
  we already decided is a different business (see the BYOC-Neon discussion).
- Read-side prior art for paging mechanics: **litestream-vfs** (faults SQLite pages
  from object storage; reads only).

**Tradeoff.** Less invention, but you inherit their operational and integration
weight, and you partly leave the PGlite "tiny embedded" story. **Effort: HIGH
(integration), not VERY HIGH (invention).** Worth a spike before ever choosing 3a.

---

## 6. Don't build it — make graduation seamless (the current design)

**Idea.** zeropg stays the small-scale tool; the memory ceiling is the **graduation
trigger**. Crossing it flips `DATABASE_URL` to a persistent-disk deployment
(Option 1) or a managed/always-on Postgres (RDS / Cloud SQL / Neon-cloud) with no
code change. **Effort: none** (it is the existing exit ramp), and it keeps zeropg's
moat (simplicity) intact. The baseline every other option is measured against:
"is OOM-writes-on-object-storage worth becoming a storage-engine project, versus
just handing the user a bigger Postgres?"

---

## Investigation plan (endorsed 2026-06-15): evaluate-before-build

Decision: **do not build Option 3 speculatively.** First stand up the two adoption
candidates **natively** (no WASM, no squeezing into PGlite) behind a shared
benchmark + failure-mode harness, learn where they break against zeropg's
requirements, *then* decide whether to adopt, simplify, or build our own.

This is explicitly a **standalone-engine / big-DB-rung** track. It does not touch
the small embedded PGlite product; it investigates how the >memory rung could work
and feeds the graduation story.

### What "what we want" means (the requirements any candidate is scored against)

1. **Out-of-memory**: a 20GB+ DB runs with *bounded* RAM/local-disk (working set,
   not the whole DB).
2. **Object storage is the durable truth** (so it can idle to zero with nothing but
   a bucket persisting).
3. **No always-on separate component** - the thing that would defeat scale-to-zero
   (Neon's standing pageserver is exactly what we want to remove).
4. **Single-writer-safe** via our existing conditional-PUT lease + fencing (replaces
   Neon's safekeeper quorum), survives the contention harness.
5. **Lazy cold start**: resume by pulling the working set, not the whole DB.
6. **Bounded write amplification** to the bucket (the cost model must hold).

### Track 1 — OrioleDB, standalone and native

Stand up patched-Postgres + **OrioleDB with its decoupled / S3 storage mode** as a
plain native server (it needs Postgres patches + a native build - it is *not* the
PGlite WASM engine, so this is a server, not an embeddable). Questions:

- Does its S3 mode keep local storage as a *cache* (bounded), or stage the whole DB?
- Cold start: does it fault the working set from S3, or warm the whole dataset?
- What is its S3 **write pattern** (amplification per committed row, checkpoint
  cadence, object sizes)?
- Consistency/commit model on S3: does it assume a single writer? Can our lease sit
  in front cleanly, or does it want its own coordination?
- Maturity of the S3 mode (this is the unknown the benchmark exists to expose).

Watch-item: adopting OrioleDB means a **native patched-Postgres server**, giving up
the embedded "same package local and remote" story - so it lands on the
standalone-server topology, the big-DB graduation rung, not the embedded product.

### Track 2 — Neon OSS, can the pageserver be collapsed?

The goal is to keep Neon's proven **layer format + page materialization** (delta +
image layers, GetPage@LSN) but **remove the always-on separate pageserver**: run
materialization *in-process inside the compute* as a library, read layers straight
from the bucket, and replace the safekeeper WAL quorum with our lease/manifest
(DESIGN already frames zeropg as "Neon with the safekeeper quorum replaced by a
conditional-write lease"). Questions:

- Is the pageserver's layer-read/materialize path **separable** from its control
  plane, multi-tenancy, and safekeeper protocol, or is it too coupled to extract?
- Can materialization run **on demand in the compute** (no standing process)? What
  is the cold/first-page latency when layers come from the bucket?
- Does removing safekeepers and substituting our single-writer lease preserve
  correctness?

Kill signal for this track: the materialize path can't be lifted out without
dragging the whole pageserver/control-plane in - then "simplify Neon" ≈ "run Neon,"
and the track collapses into the rejected always-on-pageserver shape.

### Shared harness (reuse the existing rigor)

Score both candidates with the same instrumentation style as E0-E6 + the lazy TTFQ
table + the contention loadtest. Emit JSONL; produce one comparison table.

- **Cold-start TTFQ** on a 20GB DB: point lookup / indexed range / full scan.
- **Resident RAM + local disk** for the 20GB DB (must stay bounded - the whole point).
- **Write latency + amplification** (bytes-to-bucket per committed row) and
  **compaction cost** (must scale with churn, not DB size).
- **Scale-to-zero viability**: idle to zero, resume from bucket alone, measure resume
  cost; confirm no always-on component is required.
- **Failure modes**: port the **E2b crash matrix** (SIGKILL mid-checkpoint / mid-write
  / mid-restore) and the **contention harness** (two writers, zombie, fencing); add
  **S3-stall / 429** injection.

### Kill criteria (abandon a candidate when)

- Requires an always-on separate component that can't be collapsed (req 3).
- Holds the whole DB in RAM/local disk (req 1).
- Write amplification breaks the cost model (req 6).
- Can't be made single-writer-safe with our lease, or corrupts under the contention
  harness (req 4).
- Coupling/maturity so poor that adoption ≈ a rewrite → then choose Option 3
  *deliberately*, with eyes open, not by default.

### Decision gate

After both tracks have a benchmark table + failure-mode map: **adopt** one,
**simplify** one into our compute, or **commit to Option 3** (build our own at the
smgr layer) knowing exactly which failure modes we are signing up to own.

---

## Platform note: where "disk + scale-to-zero" actually exists

- **Fly.io** — volumes persist across machine stop; machines suspend (RAM snapshot)
  → fast resume. **Best fit for Option 1.**
- **k8s** (knative/KEDA) — PVC persists; scale-to-zero via the autoscaler. Works if
  you run k8s.
- **Hetzner / VPS** — cheap volumes, but always-on (no native scale-to-zero).
- **Cloud Run / serverless-HTTP** — **no persistent volume + scale-to-zero
  together**; `/tmp` is RAM; GCS-FUSE is unsafe for a datadir (DESIGN §2). This is
  *why* the flagship mode is bucket-only and memory-capped. Options 2/3 (bucket as
  truth) are what would bring big DBs to Cloud Run; Option 1 needs Fly/k8s.
- **AWS** — Fargate+EFS (network FS, latency) or Lambda+EFS; persistent + scale-to-
  zero is awkward and needs a waker (see BREAK-EVEN.md).

---

## How to think about choosing (when the time comes)

- Want it **soon, low-risk, mostly-scale-to-zero**, accept a few $/mo idle and
  region-pinning → **Option 1 (Fly volume + suspend)**. Likely the right near-term
  answer; verify PGlite-NODEFS random-access first (1a) or fall back to real
  Postgres on the disk (1b).
- Want **truly-$0 idle AND OOM writes on the bucket** → Options 2/3/5, i.e. accept
  building or adopting a pageserver. That is a deliberate move from "library" to
  "storage engine," and should be gated on real demand, not built speculatively.
- Want to **stay a small sharp tool** → Option 6, and make Option 1 the documented
  next rung.

The honest one-liner: **"20GB with writes, still scale-to-zero" is cheap if you
allow a small persistent disk (Option 1) and expensive if you insist the bucket be
the only store (Options 2/3).** Decide which constraint actually matters before
spending the effort.
</content>
