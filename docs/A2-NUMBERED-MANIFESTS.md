# A2: Numbered immutable manifests — design (NOT YET IMPLEMENTED)

Status: **DESIGN ONLY** (2026-06-13). This is the implementation spec for
TODO A2 / ROADMAP v2 #2. It is deliberately *not* coded yet: A2 is a change to
the single most dangerous file in the repo (the manifest = the commit point),
and the project rule is to ship A1 housekeeping + FPW solidly rather than leave
a half-merged format change. This doc is the turnkey plan + the three hard
requirements that gate it. Implement it on its own branch, behind the full
battery, with the crash-harness extension below.

## Why (motivation, not cosmetic)

The commit is one conditional PUT of `manifest.json` — a single object **name**.
GCS soft-caps mutations per object name at ~1/s (E5b measured 2.43/s with **52%
429s** beyond it). So one manifest name caps the sustained commit rate, and the
E5 soak will hit that wall. Group-commit pacing hides it for bursts but cannot
raise the ceiling. Replacing the single CAS-swapped object with **create-if-
absent numbered manifests** removes the per-name cap (each commit writes a new
name), and as free side effects gives:

- **commit history / PITR**: every manifest is retained = the full LSN/commit
  timeline is in the bucket; restore-as-of-N is "read manifest ≤ N".
- **simpler crash-ordering proof**: a lexicographic LIST *is* the commit order,
  so the crash harness can assert ordering directly (requirement #2 below).
- **weaker-CAS portability** (R2/S3, Track B): create-if-absent (`If-None-Match:
  *`) is the one precondition every provider implements soundly; numbered
  manifests lean only on it, sidestepping ETag-based CAS ABA concerns.

## Format

```
manifest/00000000000000000042.json     # zero-padded commitSeq, 20 digits
manifest/00000000000000000043.json
...
```

- Key = `manifest/` + `commitSeq` zero-padded to a fixed width (20 digits covers
  a 64-bit counter; lexicographic order then equals numeric order forever).
- Body = the **existing** `Manifest` JSON, unchanged (manifest.ts stays as-is).
  `commitSeq` is already in it and becomes the source of the filename.
- **Highest-numbered manifest that exists wins.** It is the current state.
- Each manifest object is immutable and written with `ifNoneMatch: true`
  (create-if-absent). Two writers racing the same seq: exactly one PUT wins,
  the loser gets `PreconditionFailedError` → it is fenced (someone else
  committed seq N) → `FencedError`, identical semantics to today's failed CAS.

## Open / boot (REQUIREMENT #1: backward compatibility)

Buckets created before A2 hold a single legacy `manifest.json` and no
`manifest/` prefix. Both must open. Algorithm:

1. `latest = await findLatestManifest(store)`:
   - LIST `manifest/` (GCS returns lexicographic order; take the **last** key).
     Reading just the last entry is O(list); to avoid scanning all history,
     LIST is paginated and we keep only the final item. (Optimization later: a
     tiny `manifest/HEAD` pointer or reverse-list; not needed for correctness.)
   - If a numbered manifest exists, that is `latest` (key + etag + decoded body).
   - **Else** fall back to GET `manifest.json` (legacy single object). If
     present, that is `latest`, and the bucket is in *legacy mode*.
   - Else: fresh bucket.
2. Fencing-token floor (REQUIREMENT #3): `tokenFloor = latest?.fencingToken ?? 0`
   — sourced from the **highest-numbered** manifest's `fencingToken`, exactly
   as today it is sourced from `manifest.json`. Monotonicity is preserved
   because `commitSeq` (hence the filename) only ever increases and every
   commit copies `fencingToken` forward (takeover stamps a higher one).
3. Re-read after acquiring the lease (the existing E4-P2 ordering fix): after
   the lease is held, re-run `findLatestManifest` and adopt the newest — a
   predecessor's idle/SIGTERM flush during the acquire-wait now appears as a
   *higher-numbered* manifest, which the re-list picks up. (Today this re-GETs
   `manifest.json`; the numbered version re-LISTs `manifest/`.)

### First-write migration (legacy → numbered), backward-compatible

When a writer in *legacy mode* makes its first commit, it writes
`manifest/<seq>.json` (create-if-absent) **and leaves `manifest.json` in place**.
From then on the bucket has both; `findLatestManifest` prefers the numbered
prefix, so the legacy object is simply ignored (kept as an inert artifact, or
GC'd once a numbered manifest ≥ its seq exists). A pre-A2 binary pointed at a
post-migration bucket would still read the stale `manifest.json` — so migration
is **one-way per deployment**: only roll A2 out once all writers/replicas for a
bucket are on the A2 build. Document this in the release notes. (Replicas:
`ZeroPGReplica` must learn `findLatestManifest` too; it currently polls
`manifest.json`.)

## Commit path

`casManifest(m, token)` changes from "PUT manifest.json with ifMatch=etag" to:

```
key = `manifest/${String(m.commitSeq).padStart(20,'0')}.json`
await store.put(key, encodeManifest(m), { ifNoneMatch: true })   // create-if-absent
// success => this seq is ours, commit durable.
// PreconditionFailedError => someone already wrote this seq => FencedError(token).
```

`m.commitSeq` is already `this.manifest.commitSeq + 1` everywhere a commit is
built, so the seq→filename mapping needs no new state. `manifestEtag` tracking
is dropped (no longer needed — create-if-absent doesn't compare etags), which
also removes the `fenceStamp` etag dance: a takeover writes a new numbered
manifest at `prevSeq+1` with the higher token (still create-if-absent; if the
zombie raced it, one wins and the other is fenced).

**Group-commit still applies** for latency, but the *throughput* cap is gone:
concurrent in-process writes still coalesce into one numbered manifest (one
LSN range), and sustained distinct commits no longer serialize on a single
object name.

## Restore / GC

- **Restore is unchanged**: it operates on a single decoded `Manifest` (snapshot
  + walSegments). It does not care how the manifest was found.
- **GC** (`scripts/gc.ts`, `gc.ts`): today it walks the current manifest +
  `previousSnapshot`. With history retained it must additionally decide manifest
  *retention*: keep all manifests newer than the oldest snapshot still
  referenced (for PITR), prune older ones and their orphaned segments. Minimum
  safe policy for v1 of A2: keep the latest K manifests + everything they
  reference; never delete a manifest whose snapshot/segments a kept manifest
  still points at. (PITR depth = retention policy knob.)

## REQUIREMENT #2: full battery + crash-ordering assertion

Do not merge without:

- The whole battery green on the A2 build: `tsc`, `unit-local`, `e2c`, `e2f`,
  `e2d`, `e4b`, **`e2b` (the SIGKILL matrix)**. The crash matrix is the gate —
  a crash between the segment/snapshot PUT and the numbered-manifest create must
  still leave a clean pre- or post-commit state (it does by construction: the
  new manifest object either exists or it doesn't; there is no torn middle).
- **Extend `e2b-crash.ts`**: after the matrix, assert that
  `LIST manifest/` returned in lexicographic order is exactly the commit order
  (strictly increasing `commitSeq`, contiguous where no compaction gap, each
  manifest's `lsn`/`walFlushLsn` monotonic). This is the new invariant numbered
  manifests buy and must be machine-checked, not assumed.
- Add an E1 extension: zombie writes `manifest/<seq>.json` then loses the race —
  assert the successor's manifest at the same seq won, the zombie's object is
  the orphan (or the zombie was fenced before its PUT), and the fencing-token
  floor read from the newest manifest never regresses.

## Risks / watch-items

- **List cost & latency on boot**: LIST `manifest/` grows with history. Mitigate
  with GC retention (above) and/or a `manifest/HEAD` hint object (best-effort,
  not authoritative — the LIST is the source of truth). Measure boot
  `manifestGetMs` before/after on a deep-history bucket.
- **Eventually-consistent LIST**: GCS object listing is strongly consistent for
  this use, but R2/S3 LIST can lag a just-written key. A freshly-created
  `manifest/<seq>` might not appear in an immediate LIST → a successor could
  pick an older seq and try to create the same seq, losing the create-if-absent
  race → fenced (safe, no data loss, just a retry). Document per-backend; this
  is acceptable because create-if-absent is the backstop.
- **Mixed-version fleet**: see one-way migration note. Gate the rollout.
- **`previousSnapshot` semantics**: with full history, the one-back backup
  pointer is redundant for PITR but keep it — restore still uses only the
  current manifest, and it is cheap insurance.

## Rollout plan

1. Branch off, implement `findLatestManifest` + numbered `casManifest` +
   replica polling + GC retention, behind the existing API (no option needed;
   the format is internal).
2. Backward-compat test: open a bucket seeded with only a legacy `manifest.json`
   (reuse an e2c run's output), assert it opens, commits a numbered manifest,
   and a second open reads the numbered one.
3. Full battery + the two crash/lease assertions above.
4. Measure sustained commit rate vs the ~1/s single-name cap (E5b harness,
   numbered keys) to confirm the cap is actually lifted.
5. Only then make it the default and note the one-way migration in CHANGELOG.
