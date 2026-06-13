# D: Secondary cold-storage backups — design (NOT YET IMPLEMENTED)

Status: **DESIGN ONLY** (2026-06-13). Implementation spec for TODO Track D.
This is the user-facing "give me daily backups to a second, colder place, and
keep only the last N / drop anything older than X days" feature that mature
production databases ship as standard. It is deliberately designed to live
*off* the hot commit path and to reuse the restore/tar/replica/GC machinery
that already exists, not to invent a second durability mechanism.

## Why (and why it is not already done)

zeropg's bucket **is** the live backup: every commit is immutable data
(snapshot + WAL segments) plus an atomically-swapped manifest pointer, so the
primary store already gives crash-consistent durability and one-back recovery
(`previousSnapshot`). What it does **not** give:

- **A second blast radius.** Bucket deleted, project billing killed, region
  gone, credentials leaked-and-purged, an operator `gc` bug — all of it takes
  the only copy. A backup that shares the failure domain of the primary is not
  a backup.
- **Retention / point-in-the-past.** GC keeps the *current* commit plus a
  one-compaction-old fallback; it is a cleaner, not an archive. There is no
  "the database as it was 9 days ago".
- **A colder, cheaper tier.** Live data sits in standard storage for fast cold
  start. Archived copies should sit in Archive/Glacier/Infrequent-Access at a
  fraction of the price, because they are read approximately never.

This is the standard daily-backup story (`pg_dump` to S3 on a cron, `wal-g`
backup-push), expressed natively in zeropg's object model.

## Shape of a backup: self-contained snapshots, not an incremental mirror

The decision that drives everything else.

**Rejected — incremental object mirror.** "Copy whatever new immutable objects
appeared in the primary since the last run (snapshots + WAL segments +, post-A2,
numbered manifests) into the cold store." Cheapest on bytes, but it reproduces
the generation/WAL-chain coupling in the cold store, so retention can no longer
"just delete one old backup" — you must reason about which WAL a kept snapshot
still needs. Restore needs a snapshot + its full WAL chain. Wrong tool for an
archive whose whole value is independence. (This is the *right* tool for PITR;
see D5.)

**Chosen — self-contained snapshots.** Each backup run produces **one
independent, fully-restorable full-snapshot object** as of a single committed
point, plus an index entry. Properties:

- **Crash-/transaction-consistent for free.** The backup is taken *from a
  committed manifest*, i.e. a post-`CHECKPOINT` snapshot with its WAL replayed
  and then folded back into a clean snapshot. It is exactly a state Postgres
  itself produced, never a torn file copy.
- **Trivial retention.** Backups have no dependencies on each other. Keep any
  subset; delete any one freely. `keepLast` / `maxAgeDays` / GFS all reduce to
  "compute the keep-set over independent items".
- **Trivial restore.** One object → one datadir. No chain to walk.

This is the classic `pg_dump`-per-day model; its independence is the point.

## Where the bytes come from: an out-of-process archiver

The backup must not add latency or failure modes to the writer's commit path
(DESIGN's separation of concerns; cf. A3 which is *only* about the hot path).
So the archiver **consumes the bucket exactly as `ZeroPGReplica` does** —
leaseless, read-only, no contention with the writer — and writes to a second
`BlobStore`.

`backupOnce()` algorithm:

1. `GET` the current manifest from the **primary** store (post-A2:
   `findLatestManifest`). This pins the committed point and its `commitSeq` /
   `fencingToken` / `generation`.
2. Restore that manifest into a temp datadir: `restoreSnapshotInto` +
   `applyWalSegments` (the exact existing restore path, reused verbatim).
3. `CHECKPOINT` and re-tar the datadir into a **clean, WAL-folded full
   snapshot** via `createTarStream` + the existing adaptive gzip codec (probe
   the largest heap file, skip gzip if incompressible).
4. `putStream` it to the **secondary** store at
   `backups/<zeroPaddedCommitSeq>-<committedAt>.tar[.gz]`, `ifNoneMatch: true`
   (create-if-absent — backup keys are immutable and never reused).
5. Append an entry to the backup index (next section).
6. Run the retention sweep (separate, independently invokable — see Retention).

Because it is just "a reader of the bucket + a writer to another bucket", it
runs anywhere: a tiny cron container, the orchestrator VM, a scheduled cloud
job, or piggy-backed on the writer's idle/SIGTERM hook. **zeropg ships the
mechanism (`backupOnce` + retention), not the scheduler** — cadence is the
operator's cron line.

> Cheaper variant, deferred: at compaction the *writer* already tars a full
> snapshot. We could tee that stream to the secondary store and skip steps 1-3.
> It reuses an artifact but couples backup cadence to compaction cadence and
> re-introduces hot-path coupling, so it is a later optimization (D-opt), not
> the v1 design. The out-of-process archiver stays the reference path.

## The backup index

A single small JSON object in the **secondary** store, `backups/index.json`,
listing every backup. It is to the cold store what the manifest is to the
primary: the source of truth for what exists and the input to retention.

```jsonc
{
  "version": 1,
  "backups": [
    {
      "key": "backups/00000000000000000412-2026-06-13T02-00-05Z.tar.gz",
      "commitSeq": 412,
      "committedAt": "2026-06-13T02:00:05.123Z",   // from the source manifest
      "createdAt":   "2026-06-13T02:01:12.456Z",   // when the backup was written
      "sizeBytes": 5_242_880,
      "codec": "gzip",                              // or "none"
      "sourceGeneration": "g_8f2c…",
      "fencingToken": 7
    }
    // …newest last
  ]
}
```

- Written with CAS (`ifMatch` on the primary's strong stores; create-if-absent
  re-read on weaker ones) so two concurrent archiver runs can't clobber the
  index — same discipline as the manifest. A backup run that loses the index
  race re-reads and retries; the snapshot object it already wrote (immutable,
  unique key) is either adopted or GC'd as an orphan, exactly like a fenced
  commit's snapshot.
- `committedAt` is the *data* age (drives `maxAgeDays` and GFS bucketing).
  `createdAt` is operational metadata.
- Restore reads only the index + the one referenced snapshot object.

## Retention

A pure function over the index plus a policy: `keep = retain(backups, policy)`,
then delete `backups \ keep` from the cold store and rewrite the index. Mirrors
`gc.ts`'s safety discipline (compute the keep-set first, never delete outside
it) but runs against the backup index, not the live manifest.

```ts
interface RetentionPolicy {
  keepLast?: number          // keep the N most-recent backups
  maxAgeDays?: number        // delete backups whose committedAt is older than X days
  gfs?: {                    // grandfather-father-son
    daily?: number           // e.g. 7
    weekly?: number          // e.g. 4
    monthly?: number         // e.g. 12
  }
  respectMinStorageDuration?: boolean   // default true; see cold-tier note
}
```

**Composition rule: the keep-set is the UNION of every policy's keep-set.** A
backup survives if *any* configured policy wants it. (Union, not intersection:
"keep last 5 AND keep 12 monthly" must keep both the 5 freshest and one per
month, not only their overlap.) GFS bucketing: sort by `committedAt`, assign
each backup to its day/ISO-week/month bucket, keep the newest in each of the
most-recent `daily`/`weekly`/`monthly` buckets.

**Invariant, always: never delete the most-recent backup**, regardless of
policy — the cold store must never go empty while the feature is "on". This is
the GC-grace-rule analog: an archive with zero members is a silent
total-loss-of-secondary.

All three policies (`keepLast`, `maxAgeDays`, GFS) ship in the first cut.

### Cold-tier minimum-storage-duration guard

Archive/Glacier/Infrequent-Access classes bill a **minimum storage duration**
(GCS Archive 365d, Coldline 90d; S3 Glacier 90-180d; deleting earlier still
charges the remainder). A naive `maxAgeDays: 7` against an Archive-class bucket
would pay the full 365-day price for every 7-day-old object — the opposite of
the savings the cold tier is for.

So the retention engine knows the destination tier's minimum (a new
`minStorageDurationDays` field on `CostModel`, alongside the existing
per-provider numbers) and, when `respectMinStorageDuration` is set (default):
**refuses to delete an object younger than the tier minimum, and warns when a
configured policy would routinely churn under it** ("`maxAgeDays: 7` on a tier
with a 90-day minimum will incur early-deletion fees on every backup; raise
maxAgeDays ≥ 90 or use a Standard/IA-class bucket"). Same place prices live, so
it stays a measured-and-pinned number, not a hardcode.

## Restore

`restoreFromBackup(seq?)`:

1. `GET backups/index.json` from the secondary store.
2. Pick the entry: `seq` if given, else the newest.
3. `getStream` the snapshot object → gunzip (if `.tar.gz`) → `extractTarStream`
   into a target datadir (the exact existing restore mechanics, minus the WAL
   overlay — a backup is already a clean WAL-folded snapshot).
4. Either boot a `ZeroPG` on it directly, or seed a **fresh primary bucket**
   from it (write the initial manifest) for true disaster recovery into a new
   home.

Shipped as `scripts/restore-backup.ts`, with a round-trip test as the gate
(D3): backup → wipe → restore → query asserts byte/row equality.

## Proposed code shape

```
packages/objectstore-fs/src/archive.ts
  ColdArchiver(primary: BlobStore, secondary: BlobStore, opts)
    backupOnce(): Promise<BackupEntry>
    restoreFromBackup(seq?: number, into?: TargetDatadir): Promise<…>
    applyRetention(policy: RetentionPolicy, opts?: {dryRun?}): RetentionResult
  BackupIndex codec (mirrors manifest.ts: encode/decode + INDEX_KEY)
  retain(backups, policy): BackupEntry[]            // pure, unit-tested in isolation
scripts/backup.ts          // backupOnce + applyRetention; the cron target
scripts/restore-backup.ts  // disaster-recovery entry point
```

Cold-tier storage class is a `BlobStore` construction concern, not an archiver
concern: `GcsBlobStore` / `R2BlobStore` gain an optional `storageClass`
(Archive/Coldline · Glacier/Deep-Archive/IA) applied on PUT, and a
`minStorageDurationDays` on their `CostModel` (D4). The archiver just writes to
whichever store it's handed.

## Relationship to other tracks

- **Reuses, doesn't fork:** `restore.ts`, `tar.ts`, the replica's leaseless
  bucket-reading pattern, and `gc.ts`'s keep-set-first discipline. No new
  durability primitive; the only strong primitive remains conditional PUT.
- **A2 (numbered manifests) enables an *optional* PITR mode (D5).** Once every
  commit is an immutable numbered manifest, the cold store can additionally
  mirror the manifest timeline + referenced WAL for restore-as-of-any-commit —
  the incremental model rejected above, offered as a *second* mode layered on
  top of the self-contained snapshot archive (which stays the default). Until
  A2, self-contained snapshots are the whole feature and are fully
  provider-agnostic.
- **Track B/C providers compose for free.** "Primary GCS → cold Coldline",
  "primary R2 → cold B2", "primary COS → cold S3 Glacier" are all just two
  `BlobStore`s handed to one `ColdArchiver`.

## Phasing (see TODO Track D)

- **D1** `ColdArchiver.backupOnce()` + backup index; secondary = any existing
  `BlobStore`. Consistency from the committed manifest.
- **D2** Retention engine: `keepLast` + `maxAgeDays` first, GFS next; union
  keep-set; never-delete-newest invariant; min-storage-duration guard.
- **D3** `restoreFromBackup` + `scripts/restore-backup.ts` + the round-trip
  test (backup → wipe → restore → assert).
- **D4** Storage-class support on `GcsBlobStore` / `R2BlobStore` +
  `CostModel.minStorageDurationDays`; cost rows for the cold tiers.
- **D5** *(after A2)* optional incremental/PITR mode: mirror numbered manifests
  + WAL for point-in-time restore, layered over the snapshot archive.

## Risks / watch-items

- **Restore-shaped read load on the primary.** `backupOnce` does a full restore
  read each run. It's leaseless and off-peak by cron, but on a large DB it's a
  real egress/read-op cost — bill it in the cost model, and prefer running the
  archiver same-cloud as the primary (free egress) where possible.
- **Index as a single object** has the same per-name write-rate ceiling the
  manifest does (A2's motivation), but backups run on a cron (hourly at most),
  far under any cap — no numbered-index needed.
- **Empty/partial first run:** `backupOnce` on a bucket with no manifest is a
  no-op that logs, never an error (cf. `gc.ts` returning empty on no manifest).
- **Clock for `maxAgeDays`/GFS:** inject the clock (as `gc.ts` does) so
  retention is deterministically testable.
- **Cross-account credentials:** the archiver holds creds for *two* stores;
  document least-privilege (read-only on primary, write+delete on secondary).
