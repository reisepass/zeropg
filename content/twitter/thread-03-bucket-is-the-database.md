# Thread 3: the bucket is the database (pairs with posts/03-the-bucket-is-the-database.md)

1/
Object storage gives you almost nothing to build a database on. No fsync, no append, no rename, no locks.

It gives you exactly ONE strong primitive: the conditional PUT.

Turns out one is enough. Here's the entire commit protocol of a Postgres whose durable home is a bucket.

2/
Every state the database can be in is described by one small JSON object: manifest.json (which snapshot, which WAL segments after it).

WAL bytes and snapshots upload to write-once keys. Invisible until referenced.

Commit = one compare-and-swap of the manifest. That's it. That's the protocol.

3/
Why this is safe: crash BEFORE the CAS, the old manifest still describes a complete consistent database (orphaned uploads are garbage, collect them someday). Crash AFTER, the new state is durable.

Nobody observes anything except through the manifest, so a torn state isn't handled. It's unrepresentable.

4/
We didn't argue this in prose. We SIGKILLed the process at every fault point in the commit path, 20x each, and byte-diffed the reopened database. Clean pre- or post-commit state, every time.

(If the shape looks familiar: it's the Delta Lake / SlateDB commit-log idea, pointed at a running Postgres.)

5/
"But scale-to-zero platforms run 2 instances during every deploy. And keep zombies alive."

Yes. So the single-writer guarantee lives in the bucket too: lease.json, renewed by CAS, carrying a fencing token that only goes up.

A new writer bumps the token and stamps it into the manifest. Done.

6/
From that instant the old writer physically cannot commit. Its CAS is against a generation that no longer exists.

Doesn't matter how confused it is, how long its GC pause was, what its clock says. Zero clock trust for correctness. Time only affects how FAST takeover happens, never whether it's safe.

7/
We tested this the fun way: deployed a rival Cloud Run service against the same bucket prefix and watched the fight live.

It found a real bug: the zombie's in-flight upload could overwrite the winner's same-named object before its CAS bounced. Fix: object keys embed the fencing token. Write-once keys everywhere, CAS in exactly one place.

8/
The payoff for this austerity is everything falls out for free:

- read replicas: poll the manifest, download what it references. No lease, no protocol
- branching a 500MB database: server-side object copy + new manifest. 340ms, measured
- backups: copy immutable objects to a second bucket
- point-in-time: keep old manifests

9/
The entire distributed-systems surface of the database collapses to one question: can your bucket do a conditional PUT?

GCS, S3, R2, Tigris, IBM COS: all yes, all tested, same code, only credentials change.

Full protocol + prior art + bug ledger: https://github.com/reisepass/zeropg/blob/main/DESIGN.md
