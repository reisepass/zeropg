# 14 bugs my crash harness caught before a user could

*War stories from building a Postgres whose durable home is an object-storage bucket.*

[zeropg](https://github.com/reisepass/zeropg) was built experiment-first: before
trusting any component, we wrote a harness that SIGKILLs it at every fault point, then
diffs the reopened database byte-for-byte. The harness caught 14 real bugs (each one now
a regression probe). Here are the five that taught me the most. If you are building
anything that ships database state to object storage, these are free lessons.

## 1. Postgres ships its garage

Our 500MB database was producing **969MB snapshots**. Not a leak: Postgres keeps
recycled WAL segments in the datadir, up to `max_wal_size`, which defaults to **1GB**.
For a normal server that's a sensible warm pool of preallocated files. For anything that
tars up the datadir and ships it, it silently doubles your bill and your restore time.
Fix: pin `max_wal_size`, `wal_recycle=off`, and persist those GUCs inside the snapshot
itself (via ALTER SYSTEM) so every future boot inherits them.

## 2. You cannot detect WAL growth by watching files

The obvious incremental-shipping design ("diff WAL file sizes, upload what grew") is
impossible on Postgres. WAL segment files are **preallocated at their full 16MB and
filled by overwrite**, so their size never changes as records are written. The only
sound source of truth is the LSN (`pg_current_wal_flush_lsn()`), i.e. ship byte ranges
of the logical WAL stream, never files. This is exactly how Litestream ended up
LSN-based on SQLite's WAL too; apparently everyone has to rediscover it once.

## 3. The silent-data-loss one (the bug that justifies the whole harness)

The worst class of bug a durability system can have: **acknowledged-durable writes
disappearing with no error.** We had it, live, and only byte-level forensics found the
root cause.

Symptom: after a cold start, the restored cluster's WAL position sat *behind* what the
bucket manifest claimed was shipped. Every subsequent write computed a negative delta,
was swallowed as a no-op, and the server kept answering success.

Root cause, two layers down: Postgres reads WAL in 8KB pages, and **a short read at end
of file means "end of WAL"**. Our restore recreated WAL files only as long as the bytes
we had shipped, so a file could end mid-page. Replay would stop silently at the previous
page boundary, losing up to 5KB of committed tail, including commit records. On a
normal server this can't happen (files are always full 16MB, courtesy of the
preallocation from lesson 2, which masks it). Fix: the restore sparse-extends every
touched WAL file to full segment size. Plus a belt-and-suspenders invariant: if the
booted cluster's position ever sits behind the manifest's resume point, force a full
fresh snapshot instead of trusting the chain. Worst case is now one extra compaction,
never silent loss.

Related discovery from the same forensics: a dead writer's final flush LSN can overshoot
its last *replayable* record by exactly 24 bytes (one record header). So WAL ranges
never span writer lives; each instance life re-baselines once. Litestream's
"generation per restart" design is the same conclusion wearing different clothes.

## 4. The backup that existed but could never be restored

The cold-backup system writes the backup object first, then appends it to a CAS'd index.
Crash between the two and the object exists but nothing references it. The retry then
computes the same key, gets "already exists" from the create-if-absent, consults the
index, finds nothing, and gives up. Result: a perfectly good backup that is permanently
un-adoptable, i.e. **backups that lie**. The fix distinguishes "already indexed" from
"orphan the index never named" and reconstructs the orphan's index entry from the
manifest plus a HEAD request. Found by, of course, killing the process between the two
writes, twenty times.

## 5. The write that survived everything except a deploy

In sleep-durability mode, writes ack from memory and flush when the platform stops the
instance. Our E4 lifecycle probe found a deploy race: during a revision switch the
*successor* instance fence-stamped the manifest **before** the old instance's SIGTERM
flush landed, so the old instance's final flush was correctly rejected by fencing, and
its pending write died with it. Every component behaved "correctly"; the composition
lost data. Fix: an idle-flush backstop (25s) strictly shorter than the lease TTL (60s),
so pending writes are always in the bucket before any successor can take over.

## The meta-lesson

None of these were found by code review, and all of them would have looked like
impossibly rare flukes in production. They were found by a dumb loop: kill the process
at a randomly chosen fault point, reopen, compare checksums, repeat. The full ledger
(14 bugs, each with its regression probe) is in
[STATUS.md](https://github.com/reisepass/zeropg/blob/main/STATUS.md).

If your storage system doesn't have a crash harness, it doesn't have zero of these bugs.
It has an unknown number of them.
