# Thread 4: war stories (pairs with posts/04-bugs-the-crash-harness-caught.md)

1/
I built a Postgres whose durable home is an object-storage bucket. Before trusting it, I built a harness that SIGKILLs the process at every fault point and byte-diffs the reopened database.

It caught 14 real bugs. Five of them taught me things I couldn't have learned any other way. 🧵

2/
Bug: our 500MB database produced 969MB snapshots.

Postgres keeps RECYCLED WAL segments in the datadir, up to max_wal_size. Default: 1GB. Sensible warm pool for a server; silent 2x bill for anything that tars up the datadir.

Postgres ships its garage. Pin the GUCs.

3/
Bug: incremental WAL shipping by watching file sizes is IMPOSSIBLE on Postgres.

WAL files are preallocated at full 16MB and filled by OVERWRITE. Their size never changes.

The only truth is the LSN. Ship logical byte ranges, never files. (Litestream converged on the same thing for SQLite.)

4/
The bad one. Symptom: after a cold start, writes were acknowledged, reported durable... and silently swallowed. No errors anywhere.

Root cause, found by byte-level forensics: Postgres reads WAL in 8KB pages, and a SHORT READ at EOF means "end of WAL."

5/
Our restore recreated WAL files only as long as the bytes we'd shipped, so files could end mid-page. Replay silently stopped at the previous page boundary, dropping up to 5KB of committed tail.

Normal servers never see this: their preallocated 16MB files mask it. Fix: sparse-extend every restored WAL file to full segment size.

6/
Plus an invariant on top, because "we fixed the cause" is not a durability argument: if the booted cluster's WAL position ever sits behind what the bucket claims, force a fresh full snapshot.

Worst case is now one extra compaction. Never silent loss.

7/
Bug: a backup that existed but could never be restored.

Crash between writing the backup object and appending it to the index: the retry recomputes the same key, gets "already exists", checks the index, finds nothing, gives up. Forever.

Backups that lie are worse than no backups. Found by killing the process between the two writes, x20.

8/
Bug: a write that survived everything except a deploy.

During a revision switch, the successor fenced the manifest BEFORE the old instance's shutdown flush landed. Every component behaved correctly. The composition lost data.

Fix: idle-flush backstop (25s) strictly < lease TTL (60s).

9/
The meta-lesson: none of these were findable by code review, and in production each would've looked like an impossibly rare fluke.

They were found by a dumb loop: kill at a random fault point, reopen, compare checksums, repeat.

10/
If your storage system doesn't have a crash harness, it doesn't have zero of these bugs. It has an unknown number of them.

Full 14-bug ledger, each with its regression probe: https://github.com/reisepass/zeropg/blob/main/STATUS.md
