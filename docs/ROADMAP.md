# Roadmap

What's next, in order, with the reasoning. Background and citations live in
[RESEARCH-NOTES.md](RESEARCH-NOTES.md) (a survey of Litestream/LTX, LiteFS,
SlateDB, Neon, Cloudflare D1, wal-g/pgBackRest, and 2024–26 object-store
primitives). Status of what's already built: [../STATUS.md](../STATUS.md).

## Shipped in v1 (battle-tested)

Incremental WAL shipping (LSN ranges, ~134ms strict commits), snapshots as
compaction + rolling backup, durability modes (`strict`/`interval`/`sleep`),
group-commit pacing + 429 retry from a per-provider cost model, fence-stamped
lease takeovers, fencing-token object keys, generation-per-writer-life,
full-segment-size restore padding, read replicas (`ZeroPGReplica`), branching,
GC. Eleven-plus live-fire bugs found and regression-tested (STATUS.md).

## v2 — robustness + cost, no architecture change

1. **Numbered immutable manifests** (`manifest/00000000000042.json`,
   create-if-absent) replacing the single CAS-swapped `manifest.json`.
   Motivation is hard: GCS caps mutations per object NAME at ~1/s (measured:
   52% rejections beyond it), so one manifest name caps commit rate. Numbered
   manifests turn every commit into a create-if-absent on a fresh name —
   no per-name cap, free commit history, and point-in-time restore falls out.
   A small `current.json` hint (or list-last) locates the head. This is the
   SlateDB/Delta-Lake commit-log shape.
2. **Writer-epoch in object names + halt-on-first-fence** (SlateDB's formally
   verified recipe — we have 90% of it via fencing tokens; make a fenced
   writer permanently halt rather than serve 423s until restart).
3. **LTX-style checksum chain**: each segment records `preChecksum` /
   `postChecksum` of the database state; `post[i] == pre[i+1]` proves the
   chain end-to-end. Litestream v0.5 dropped generations for exactly this —
   it would let us re-promote cross-life chaining (the full-segment padding
   fix likely already made it sound; needs E4-grade proof).
4. **GCS `compose` segment folding** (32:1 server-side, one Class A op, zero
   instance CPU) + **restore-budget-driven compaction** replacing fixed
   thresholds. Constants are measured (E0/E2c/E3).
5. **Deferred deletion window** (keep superseded snapshots/segments N days):
   30-day PITR + zero-copy branches via manifest pinning — D1 "Time Travel"
   for the price of storage.
6. **S3 + R2 transports** with a CAS conformance suite (R2 has shipped real
   conditional-write bugs; test the primitive, not the docs).

## v3 — latency + scale levers

7. **Output gates** (Cloudflare DO trick): commit locally, keep executing,
   hold client responses until the bucket confirms — hides the ~100-200ms
   commit behind concurrency with zero durability loss. Pairs with
   `await_durable: false` per-query opt-out.
8. **Appendable WAL-tail tier**: GCS Rapid Storage (zonal, sub-ms appends) or
   S3 Express One Zone append for sub-10ms strict commits, with the regional
   manifest staying the commit point. Driver variant behind `CostModel`.
9. **Lazy page-faulting restore** (Neon GetPage / turbopuffer style): cold
   start O(working set) instead of O(database size) via a real PGlite VFS
   that faults pages from the bucket. The biggest cold-start lever for
   multi-GB databases; a research project, not a feature ticket.
10. **Replica WAL tailing**: replicas currently re-materialize on refresh;
    teach them to apply new segments by restarting recovery on the existing
    scratch dir (cheap for small deltas) before reaching for the VFS.

## Non-goals (still)

Multi-writer, cross-region active-active, databases larger than instance
memory (until #9), running your checkout path on this.
