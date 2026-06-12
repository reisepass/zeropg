# Status: experiment results and next steps

Last updated: 2026-06-12. Raw data in `results/*.jsonl`.

## Scoreboard (run 2026-06-11 on the blob-pglite-dev VM, europe-west1)

### Passed

- **E0 - GCS conditional writes**: 100 race rounds x 20-way concurrency, zero double-winners on create-if-absent and CAS. Latency from in-region VM: conditional PUT p50 ~44ms (1KB), ~60ms (1MB), ~230ms (16MB). Strict-durability commit cost is therefore ~50-70ms.
- **E1 - lease/fencing**: zombie scenario 100/100 stale renewals rejected, 100/100 stale manifest commits rejected; 60 jitter rounds, zero two-holder violations.
- **E2 - ObjectStoreFS round-trip**: integrity OK at 1MB/10MB/100MB. Cold start 1.3-3.7s by size. Seeded-snapshot boot 2.2s vs 5.0s fresh initdb - DECIDED: create database = pure bucket write from a prebuilt empty snapshot (DESIGN.md open question 9.5).
- **E2b - crash safety**: kill-before-snapshot / kill-after-snapshot / kill-during-manifest x 20 each; all 60 reopens were a clean pre- or post-commit state. No torn states. Manifest commit is atomic as designed.
- **E3 - partial**: `zeropg-demo-1mb` and `zeropg-demo-50mb` live on Cloud Run (europe-west1). One cold-start datapoint: ~1.9s to ready cold, 33ms warm. 500MB test DB seeded (92s, second attempt).

### Failed / fixed

- **Cloud Build 403** on `gcloud builds submit`: worker SA couldn't read the staging bucket. FIXED at the project level: both `blob-pglite-dev@` and the default compute SA now have `roles/editor` (plus the VM SA's earlier specific roles). Normal `gcloud run deploy --source` works now.
- **500MB seed needed two attempts**; see anomaly below.

### Open anomaly (investigate before more benchmarks)

- A 500MB database produced a **969MB snapshot** - bigger than the data. Compression is off, broken, or the tar includes junk. Fixing this changes every cold-start and storage-cost number, so do it first.

## Next steps, in order

1. **Finish E3**: deploy the 500MB demo service; cold-start distributions for 1MB/50MB/500MB (20 scale-to-zero cycles each); RSS per DB size to find cheapest viable memory tier; re-run E0 latency probe from inside Cloud Run.
2. **Fix the snapshot-size anomaly** (above) and re-measure.
3. **E4 - lifecycle hazards** (the make-or-break experiment, see EXPERIMENTS.md):
   - Heartbeat under CPU throttling: does "no background work, re-validate lease at request start" hold? This decides whether the no-orchestrator pitch survives as-is.
   - SIGTERM grace-period flush with pending relaxed-mode commits.
   - 20 revision-switch cycles: exactly one lease holder during the double-instance window, no manifest interleaving.
   - Live zombie test between two Run services (pause-heartbeat endpoint, takeover, fenced commit attempt).
4. **E5 - 72h soak + real billing numbers**, after E4 fixes the CPU-allocation mode.
5. **v1 WAL shipping** per DESIGN.md roadmap, justified by the E2/E3 timing tables.

## Operational notes

- Git: push to `origin` (github.com/reisepass/zeropg) works from the VM via deploy key (`~/.ssh/zeropg_deploy`, wired in `~/.ssh/config`). Commit and push as you go - the previous session left everything uncommitted and it was nearly lost.
- GCP: project `blob-pglite`, region `europe-west1`. The VM SA has project editor; creating buckets, Run services, Functions, builds all work.
- tmux: work inside the `zeropg` session (`tmux attach -t zeropg`).
