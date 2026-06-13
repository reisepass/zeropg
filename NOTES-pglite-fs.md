# NOTES: PGlite Emscripten FS extension surface (Spike Step 1, source recon)

Verdict up front: **YES - individual block reads on relation segment files ARE
interceptable from a user package, with no fork or patch of pglite or Postgres.**
The public, supported extension point is subclassing `BaseFilesystem` and
overriding its `read(fd, buffer, offset, length, position)` method. That method
is the synchronous `pread` that Postgres's storage manager ultimately drives.

This is a green light for the design's load-bearing assumption (V2 doc Sections 5
and 8 step 1). The kill-criterion ("`stream_ops.read` not interceptable without
forking pglite") does **not** fire.

---

## Provenance of the code cited below

pglite is published minified, but the npm tarball ships sourcemaps with the
original TypeScript embedded in `sourcesContent`. All line numbers below are from
the **original `src/fs/base.ts`** reconstructed from
`node_modules/@electric-sql/pglite/dist/fs/base.cjs.map` (package version
**0.5.2**, installed in the main repo at
`/Users/user/workspace/blob-pglite/node_modules/@electric-sql/pglite/`).

Reconstructed copies used for this recon (read-only, under /tmp, not committed):
- `/tmp/pglite-src/src__fs__base.ts`     (from `dist/fs/base.cjs.map`)
- `/tmp/pglite-src/src__fs__opfs-ahp.ts` (from `dist/fs/opfs-ahp.cjs.map`)
- `/tmp/pglite-src/src__fs__nodefs.ts`   (from `dist/fs/nodefs.cjs.map`)

The shipped `.d.ts` (`dist/fs/base.d.ts`, `dist/fs/opfs-ahp.d.ts`) corroborate
the public surface (the `BaseFilesystem.read(fd, buffer, offset, length,
position): number` signature is exported).

---

## 1. There are TWO base classes, and only one of them is interceptable

`src/fs/base.ts` defines the `Filesystem` interface plus two base classes:

### a) `EmscriptenBuiltinFilesystem` (NOT useful for us)

`src/fs/base.ts:49-71`. This is what **`NodeFS` extends**. Its `init` just
returns the emscripten options unchanged (lines 57-60); the subclass mounts a
*built-in* emscripten FS (NODEFS/IDBFS/MEMFS) inside its own `preRun`. Confirmed
in `src/fs/nodefs.ts`:

```js
preRun:[ ... r => { let c = r.FS.filesystems.NODEFS; r.FS.mkdir(PGDATA);
                    r.FS.mount(c, {root:this.rootDir}, PGDATA) } ]
```

With this path the read path lives inside the C/emscripten NODEFS implementation
and is **not reachable from JS**. So we must NOT build on `NodeFS` /
`EmscriptenBuiltinFilesystem`.

### b) `BaseFilesystem` (THIS is the interception surface)

`src/fs/base.ts:77-152`. This is what **`OpfsAhpFS` extends**
(`src/fs/opfs-ahp.ts`, `class OpfsAhpFS extends BaseFilesystem`). It declares an
abstract, NodeJS-FS-like API that the subclass must implement, including:

```ts
abstract read(
  fd: number,
  buffer: Uint8Array, // buffer to read INTO
  offset: number,     // offset in buffer to start writing to
  length: number,     // number of bytes to read
  position: number,   // position in FILE to read from
): number             // returns bytes actually read
```
(`src/fs/base.ts:125-131`)

Our custom FS is a **sibling to `opfs-ahp.ts`**, exactly as the V2 doc Section 5
predicts: a class `extends BaseFilesystem` living in our own package.

---

## 2. How `BaseFilesystem` wires itself into the Emscripten module

`BaseFilesystem.init(pg, emscriptenOptions)` (`src/fs/base.ts:97-111`):

```ts
async init(pg, emscriptenOptions) {
  this.pg = pg
  const options = {
    ...emscriptenOptions,
    preRun: [
      ...(emscriptenOptions.preRun || []),
      (mod) => {
        const EMFS = createEmscriptenFS(mod, this)   // line 104
        mod.FS.mkdir(PGDATA)                          // line 105
        mod.FS.mount(EMFS, {}, PGDATA)               // line 106
      },
    ],
  }
  return { emscriptenOpts: options }
}
```

Key facts:
- `init` is handed the live emscripten `mod` (and thus `mod.FS`) inside a
  `preRun` hook. This is exactly the "`init` exposes the Emscripten `FS`" hook
  the V2 doc asks about. We get `mod.FS` here, before Postgres runs.
- It builds a **JS object** `EMFS` (an `Emscripten.FileSystemType`) and mounts it
  at `PGDATA`. Everything Postgres does under the data dir goes through this JS
  object. No native code, no fork.

## 3. `createEmscriptenFS` - the actual read interception path

`createEmscriptenFS(Module, baseFS)` at `src/fs/base.ts:242-540` builds the
`EMFS` object. The relevant wiring:

- Every node created gets our `node_ops`/`stream_ops`:
  `createNode` sets `node.node_ops = EMFS.node_ops` and
  `node.stream_ops = EMFS.stream_ops` (`src/fs/base.ts:274-277`).

- `stream_ops.open` opens a backing fd via `baseFS.open(path)` and stores it on
  the stream as `stream.nfd` (`src/fs/base.ts:396-405`).

- **`stream_ops.read` (the one we care about), `src/fs/base.ts:422-447`:**

```ts
read(stream, buffer, offset, length, position): number {
  if (length === 0) return 0
  const ret = EMFS.tryFSOperation(() =>
    baseFS.read(stream.nfd!, buffer, offset, length, position),  // line 438
  )
  return ret
}
```

So the emscripten `stream_ops.read` is a thin pass-through to **our**
`baseFS.read(fd, buffer, offset, length, position)`. Overriding `read` in our
`BaseFilesystem` subclass intercepts every block read, with the file offset
(`position`) and byte count (`length`) handed to us directly. We write the bytes
into `buffer` at `offset` and return the count. This is a textbook `pread` hook.

- `stream_ops.mmap` (`src/fs/base.ts:490-519`) also routes through
  `EMFS.stream_ops.read`, i.e. through our `baseFS.read`. So mmap-backed reads
  fault through the same hook - good, nothing escapes us.

- Confirming the contract with a real implementation: `OpfsAhpFS.read`
  (`src/fs/opfs-ahp.ts:432-448`) does exactly:
  `sh.read(new Uint8Array(buffer.buffer, offset, length), { at: position })` and
  returns the byte count. Our faulting implementation mirrors this shape.

## 4. Answering the V2 doc's precise sub-questions

- "Confirm whether `read` is reachable per-stream or whether we must shim at
  `FS.createNode`/`mount`." -> **Reachable per-stream, cleanly.** We do not need
  to touch `createNode`/`mount` ourselves; `BaseFilesystem.init` already mounts
  the JS FS for us, and the per-stream `stream_ops.read` calls our `baseFS.read`
  with `(fd, buffer, offset, length, position)`. We only implement the abstract
  `BaseFilesystem` methods.

- "How does `init(pg, emscriptenOptions)` expose the Emscripten `FS`?" -> via a
  `preRun` callback that receives `mod` (full emscripten Module incl. `mod.FS`);
  see `src/fs/base.ts:103-107`.

- "Can we intercept individual block reads on relation segment files WITHOUT
  forking pglite/postgres?" -> **Yes.** Subclass `BaseFilesystem`, override
  `read`. The relation segment path (`base/<dboid>/<relfilenode>[.segN]`) lands
  in `read` as a normal path-resolved fd; we discriminate by the path we
  recorded at `open` time (`stream_ops.open` -> `baseFS.open(path)`), so we can
  decide per-file whether to serve locally or fault remotely.

## 5. Caveats / things to watch (not blockers, but real)

1. **The read path is synchronous, by construction.** `stream_ops.read` returns
   a `number` synchronously; there is no place to `await`. This is exactly the
   sync-over-async wall in V2 Section 4. Interceptability is confirmed, but the
   hook MUST be satisfied synchronously -> Atomics + SharedArrayBuffer + worker
   bridge (Spike Step 2). Interceptable does not mean "can do async I/O inline";
   it means "we own the synchronous function that must produce the bytes."

2. **`open` is where we learn the path; `read` only gives us `fd`.** We must map
   `fd -> path` ourselves (OpfsAhpFS keeps `#getPathFromFd`). Straightforward,
   but the faulting FS has to maintain that table to know which file/relfilenode
   a read targets.

3. **We must implement the FULL abstract surface** (chmod/close/fstat/lstat/
   mkdir/open/readdir/read/rename/rmdir/truncate/unlink/utimes/writeFile/write),
   not just `read`. The pragmatic approach for the spike is to back everything
   with a real local FS (a `/tmp` datadir) for correctness and only special-case
   `read` (and `open`/`fstat` for size) on the lazy files. A from-scratch
   in-memory tree (like OpfsAhpFS) is the heavier alternative.

4. **`mmap` reads the whole `length` eagerly** through our `read`
   (`src/fs/base.ts:511-517`). If Postgres mmaps a large segment, that becomes
   one big fault. Worth noting for the page-group sizing in V2 Section 6;
   probably fine because Postgres heap access is `pread`-based, but verify mmap
   isn't used on relation segments in the pglite build during Step 3.

5. **Version pin.** This surface is from 0.5.2 and is NOT documented in the
   public docs ("consult the source", per V2 Section 5). `BaseFilesystem` and
   `createEmscriptenFS` are an internal contract that can change between pglite
   minor versions. Our package must pin the pglite version and re-verify on bump.
   It is interceptable-without-fork, but it is interceptable against an
   *undocumented internal*, so treat upgrades as breaking until re-checked.

## 6. Bottom line

The most valuable finding the kill-criterion was hunting for is a **non-finding**:
there is no wall here. `stream_ops.read -> baseFS.read` is a clean, synchronous,
per-stream JS hook reachable by subclassing `BaseFilesystem`, no fork. The real
hard problem moves entirely to Step 2 (satisfying that synchronous read with a
remote fetch via Atomics/SAB) and Step 4 (does lazy actually beat eager on TTFQ).
