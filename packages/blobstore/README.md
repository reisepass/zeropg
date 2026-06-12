# @zeropg/blobstore

Object-store transports for zeropg. The entire design rests on ONE strong
primitive: **atomic conditional PUT** (create-if-absent and compare-and-swap).
Everything else is plain GET/PUT/LIST/DELETE.

```ts
import { GcsBlobStore } from '@zeropg/blobstore'
const store = new GcsBlobStore({ bucket: 'my-bucket', prefix: 'apps/mine' })
await store.put('manifest.json', bytes, { ifMatch: etag }) // CAS — throws PreconditionFailedError
```

`GcsBlobStore` speaks the GCS JSON API directly (no SDK): `ifGenerationMatch`
preconditions, parallel-ranged streaming GET (pinned to one object
generation), chunked streaming PUT, server-side `copy` (rewrite), and
jittered retry on clean 429/5xx rejections — never on ambiguous network
failures, which could turn our own landed CAS into a false fence.

Each transport carries a **`CostModel`** (prices + limits, pinned with a
review date). The one that shapes everything: GCS allows ~1 sustained
mutation/second per object name (measured live: 2.4/s with 52% rejections),
which is why zeropg group-commits.

S3 and R2 transports are welcome — implement the `BlobStore` interface and
run the repo's E0/E1 conformance suites against the real service (R2 has
shipped real conditional-write bugs; test the primitive, not the docs).
