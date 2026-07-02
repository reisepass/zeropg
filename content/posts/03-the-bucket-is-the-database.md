# The whole commit protocol is one conditional PUT

*How zeropg makes an object-storage bucket the durable home of a Postgres database,
without a consensus service, a clock, or a coordination server.*

Object storage gives you almost nothing to build a database on. No fsync, no append, no
rename, no locks. GETs and PUTs of whole immutable objects, eventually cheap, always
durable. But modern buckets (GCS, S3, R2, IBM COS, all of them now) give you exactly one
strong primitive: the **conditional write**. "Create this object only if it doesn't
exist." "Replace this object only if its current generation is X."

It turns out one strong primitive is enough for a single-writer database. That's the
entire trick behind [zeropg](https://github.com/reisepass/zeropg), and it fits in a
diagram:

```
   ┌──────────── scale-to-zero instance ────────────┐
   │  app ── SQL ──> Postgres (PGlite, in-process)  │
   │                     │ datadir on /tmp          │
   └─────────────────────┼─────────────────────────-┘
        boot: restore    │    commit: WAL bytes up
   ┌─────────────────────▼──────────────────────────┐
   │  bucket                                        │
   │    manifest.json   ← conditional PUT = commit  │
   │    lease.json      ← fencing tokens            │
   │    segments/…      ← immutable WAL + snapshots │
   └────────────────────────────────────────────────┘
```

## The commit

Every state the database can be in is described by one small JSON object, the manifest:
which snapshot, which WAL segments after it. Data uploads (WAL segments, snapshots) go
to write-once keys; they are invisible until referenced. Then the commit is a single
compare-and-swap of `manifest.json` against the generation we last read.

That CAS **is** the commit. Crash before it: the old manifest still describes a complete,
consistent database, and the orphaned uploads are garbage to collect someday. Crash
after it: the new state is durable. There is no window where a reader can observe half a
commit, because nobody ever observes anything except through the manifest. We SIGKILLed
the process at every fault point in the commit path, twenty times each, and reopened
byte-identical every time. Torn states are not "handled"; they are unrepresentable.

If this shape looks familiar: it is the Delta Lake / SlateDB commit-log idea, applied to
a running Postgres.

## The lease (or: why you cannot trust the platform)

A single-writer database needs there to actually be a single writer. Scale-to-zero
platforms cheerfully violate this: during every deploy, the old and new instance run
simultaneously; crashed instances get replaced while their predecessor is mid-write;
"max instances = 1" is a scheduling hint, not a promise.

So the guarantee lives in the bucket too. `lease.json` is created with if-absent
semantics and renewed by CAS, and it carries a **fencing token**, a number that only
goes up. A new writer taking over after a lease expiry does two things: bumps the token,
and immediately stamps it into the manifest. From that instant, the previous writer (a
"zombie": alive, but no longer the owner) physically cannot commit: its manifest CAS is
against a generation that no longer exists. It doesn't matter how confused it is, how
long its GC pause was, or what its clock says. Correctness needs zero clock trust; time
only affects liveness (how fast a takeover happens).

We didn't take this on faith. We deployed a second, rival Cloud Run service against the
same bucket prefix and watched the fight live: the rival takes the lease, stamps the
manifest, and the original's next commit bounces with a fencing error. One bug did fall
out of that live test (the zombie's already-in-flight segment upload could overwrite the
winner's same-named object before the CAS failed), and the fix is instructive: object
keys now embed the fencing token, so two writer generations cannot collide on a key even
in principle. Write-once keys everywhere, CAS in exactly one place.

## Why bother

Because everything else falls out for free. Read replicas are just processes that poll
the manifest and download what it references (no lease needed, they never write).
Branching a 500MB database is a server-side copy of objects plus a new manifest: 340ms,
measured. Backups are copying immutable objects to a second bucket. Point-in-time
history is "keep the old manifests."

One primitive, one owner for every piece of state, and the entire distributed-systems
surface of a database collapses into: *can your bucket do a conditional PUT?* Every
provider we tested (GCS, R2, Tigris, IBM COS) can, and the same code runs on all four
with only credentials changing.

Design doc with the full protocol, prior art, and the bug ledger:
[DESIGN.md](https://github.com/reisepass/zeropg/blob/main/DESIGN.md).
