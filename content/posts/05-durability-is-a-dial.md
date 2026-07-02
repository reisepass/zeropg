# Durability is a dial, not a property

*Why "every write durable before ack" is the wrong default for an app that sleeps 95%
of the day, and how to make the loss window an explicit choice.*

Ask an engineer whether a database should lose acknowledged writes and you get a
one-word answer. Ask them again when durability costs a 100-200ms object-storage
round-trip on every single INSERT, on an app with four users, and the right answer
becomes: **it depends on the write.**

In [zeropg](https://github.com/reisepass/zeropg) (real Postgres, durable home = an
object-storage bucket, compute scales to zero) durability is a per-workload dial with
three positions:

| mode | write latency (measured, 50MB DB) | loss window on crash |
|---|---|---|
| `strict` | ~0.2s | zero: ack means it's in the bucket |
| `interval` | ~0.15s from memory | up to the flush interval |
| `sleep` | ~0.15s from memory | since the last flush |

`strict` ships the WAL bytes of the commit (a few hundred bytes for a one-row insert)
plus one conditional PUT of the manifest, on the request path. That's the mode for
"this write is money."

`sleep` is the serverless-native mode and the interesting one. Writes run at memory
speed while traffic flows. One flush happens when the platform tells the instance to
sleep (SIGTERM before scale-to-zero), with an idle-timer backstop. In exchange you
accept a bounded, documented window: if the instance dies *uncleanly* (SIGKILL, hardware
loss) before a flush, unflushed writes are gone. This is precisely the Litestream
bargain, and every object-storage-backed database makes it; the difference is whether
it's explicit or buried in marketing copy.

## Why not just make everything strict?

Two provider realities gang up on the strict path:

**1. The bucket rate-caps a single object name.** GCS caps sustained writes to one
object name at ~1 per second. We measured it: pushing sequential manifest CAS updates
achieved 2.43/s with **52% of requests rejected**. Since every commit CASes the same
`manifest.json`, back-to-back strict commits must **group-commit**: concurrent writes
coalesce into one manifest swap (we measured 10 concurrent writes folding into 1 CAS),
and sustained writers pace themselves at the cap. Group commit is 40 years old and
still undefeated.

**2. The first write after a cold start is special.** A freshly woken instance inherits
a WAL position from whatever instance ran last, and that handoff cannot be spliced
safely (the dead writer's recorded position can sit one record-header past the last
replayable byte; details in the repo's V1-WAL-SHIPPING.md). So the first commit of each
instance life re-baselines the WAL since the last snapshot. Bounded and cheap (~350ms
and ~3MB on our 500MB demo, versus ~18s for a naive full re-snapshot), but it is still
the most expensive write of the life, and it is exactly the write that would otherwise
land on the first user click after a wake, the moment your app already spent its
latency budget on the cold start.

The dial is what keeps that cost off the request path: in `sleep` or `interval` mode
the user's write acks from memory in microseconds and the re-baseline rides a
background flush. Only `strict` puts durability on the critical path, and then it's
because you asked for exactly that.

## The design position

Durability-per-write is a workload property, not a database property. A note-taking
app's autosave, a page-view counter, a shopping-cart line item, and a payment
confirmation do not deserve the same loss window, and pretending they do just means the
whole app pays for the payment confirmation.

What a database owes you is not "maximum durability always"; it is (a) an **explicit,
bounded, measured** window per mode, (b) a **flush-on-sleep contract** aligned with how
serverless platforms actually stop instances, and (c) the guarantee that whatever is in
the bucket is **consistent** regardless of when you crashed (in zeropg the commit is a
single manifest CAS, so a torn state is unrepresentable; the dial only ever moves the
window's *size*, never its *integrity*).

The demo pages at
[zeropg-demo-50mb](https://zeropg-demo-50mb-71428757273.europe-west1.run.app) show the
dial live: every write reports its per-step timing (SQL exec, lease check, WAL scan,
upload, manifest CAS), and a "durable now" checkbox lets you feel the difference
between acking from memory and acking from the bucket, one write at a time.
