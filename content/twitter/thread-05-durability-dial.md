# Thread 5: durability is a dial (pairs with posts/05-durability-is-a-dial.md)

1/
Ask an engineer if a database should lose acknowledged writes: one-word answer.

Ask again when durability costs a 100-200ms object-storage round-trip on EVERY insert, on an app with four users:

the right answer becomes "it depends on the write."

Durability is a dial, not a property. 🧵

2/
Our Postgres-in-a-bucket has three positions (measured on the live 50MB demo):

strict: ~0.2s per write, ack means it's in the bucket. Loss window: zero
interval: ~0.15s ack from memory. Window: the flush interval
sleep: ~0.15s ack from memory. One flush when the platform puts the instance to sleep

3/
`sleep` is the serverless-native mode: writes run at memory speed while traffic flows, one flush on SIGTERM before scale-to-zero, an idle-timer backstop behind it.

The bargain: die UNCLEANLY before a flush and unflushed writes are gone. Bounded, documented, explicit.

4/
This is precisely the Litestream bargain, and every object-storage-backed database makes it.

The only difference between systems is whether the loss window is explicit in the docs or buried in the marketing copy.

5/
Why not just make everything strict? The bucket itself pushes back.

GCS rate-caps writes to a single object name at ~1/s. We measured it: sequential manifest CAS achieved 2.43/s with 52% of requests rejected.

Every commit CASes the same manifest.json, so back-to-back strict commits MUST group-commit. We watched 10 concurrent writes fold into 1 manifest swap. Group commit is 40 years old and still undefeated.

6/
And the first write after a cold start is special: a freshly woken instance can't safely splice onto a dead writer's WAL position (it can sit one record-header past the last replayable byte).

So the first commit of each life re-baselines: ~350ms and ~3MB on our 500MB demo, vs ~18s for a naive full snapshot.

7/
That re-baseline is exactly the write that would otherwise land on the first user click after a wake, the moment the app already spent its latency budget on the cold start.

The dial keeps it off the request path: in sleep/interval mode the user's write acks from memory and the re-baseline rides a background flush.

8/
The design position: durability-per-write is a WORKLOAD property.

An autosave, a page-view counter, a cart line item, and a payment confirmation do not deserve the same loss window. Pretending they do just means the whole app pays for the payment confirmation.

9/
What a database owes you isn't "maximum durability always." It's:

(a) an explicit, bounded, MEASURED window per mode
(b) a flush-on-sleep contract aligned with how serverless platforms actually stop instances
(c) whatever is in the bucket is consistent no matter when you crashed. The dial moves the window's size, never its integrity

10/
You can feel the dial live: this demo reports per-step timing on every write (SQL exec, lease check, WAL scan, upload, manifest CAS) and has a "durable now" checkbox that switches between acking from memory and acking from the bucket.

https://zeropg-demo-50mb-71428757273.europe-west1.run.app
