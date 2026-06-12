import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// experiments/e3-service/server.ts
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as join3 } from "node:path";

// packages/blobstore/src/types.ts
var PreconditionFailedError = class extends Error {
  key;
  constructor(key, detail) {
    super(`precondition failed for key "${key}"${detail ? `: ${detail}` : ""}`);
    this.name = "PreconditionFailedError";
    this.key = key;
  }
};

// packages/blobstore/src/gcs.ts
import { Readable } from "node:stream";

// packages/blobstore/src/token.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
var cache = null;
var source = null;
async function fetchFromMetadata() {
  try {
    const res = await fetch(METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(2e3)
    });
    if (!res.ok) return null;
    const body = await res.json();
    return {
      token: body.access_token,
      expiresAtMs: Date.now() + body.expires_in * 1e3
    };
  } catch {
    return null;
  }
}
async function fetchFromGcloud() {
  try {
    const { stdout } = await execFileAsync("gcloud", ["auth", "print-access-token"]);
    return {
      token: stdout.trim(),
      // gcloud tokens are ~1h; refresh conservatively.
      expiresAtMs: Date.now() + 50 * 60 * 1e3
    };
  } catch {
    return null;
  }
}
async function getAccessToken() {
  if (cache && Date.now() < cache.expiresAtMs - 6e4) {
    return cache.token;
  }
  const order = source === "gcloud" ? [fetchFromGcloud, fetchFromMetadata] : [fetchFromMetadata, fetchFromGcloud];
  for (const fn of order) {
    const t = await fn();
    if (t) {
      cache = t;
      source = fn === fetchFromGcloud ? "gcloud" : "metadata";
      return t.token;
    }
  }
  throw new Error(
    "could not obtain a GCP access token from the metadata server or gcloud"
  );
}

// packages/blobstore/src/gcs.ts
var GCS_COST = {
  asOf: "2026-06",
  writeOpUsd: 5e-3 / 1e3,
  // Class A
  readOpUsd: 4e-4 / 1e3,
  // Class B
  storageGbMonthUsd: 0.02,
  internetEgressGbUsd: 0.12,
  maxWritesPerObjectPerSec: 1
};
var BASE = "https://storage.googleapis.com";
function joinPrefix(prefix, key) {
  if (!prefix) return key;
  const p = prefix.replace(/\/+$/, "");
  return `${p}/${key}`;
}
var GcsBlobStore = class _GcsBlobStore {
  cost = GCS_COST;
  bucket;
  prefix;
  getToken;
  constructor(opts) {
    this.bucket = opts.bucket;
    this.prefix = opts.prefix;
    this.getToken = opts.tokenProvider ?? getAccessToken;
  }
  async authHeaders() {
    return { Authorization: `Bearer ${await this.getToken()}` };
  }
  fullKey(key) {
    return joinPrefix(this.prefix, key);
  }
  async get(key, opts) {
    const name = encodeURIComponent(this.fullKey(key));
    const url = `${BASE}/storage/v1/b/${this.bucket}/o/${name}?alt=media`;
    const headers = { ...await this.authHeaders() };
    if (opts?.range) {
      const { start, end } = opts.range;
      headers.Range = `bytes=${start}-${end ?? ""}`;
    }
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw await gcsError(res, "get", key);
    const buf = new Uint8Array(await res.arrayBuffer());
    const etag = res.headers.get("x-goog-generation") ?? "";
    return { bytes: buf, etag, size: buf.byteLength };
  }
  /** Tuning for getStream's parallel-range download. */
  static STREAM_CHUNK_BYTES = 32 * 1024 * 1024;
  static STREAM_CONCURRENCY = 4;
  async getStream(key) {
    const meta = await this.head(key);
    if (!meta) return null;
    const name = encodeURIComponent(this.fullKey(key));
    const base = `${BASE}/storage/v1/b/${this.bucket}/o/${name}?alt=media&generation=${meta.etag}`;
    const auth = await this.authHeaders();
    const CHUNK = _GcsBlobStore.STREAM_CHUNK_BYTES;
    const CONC = _GcsBlobStore.STREAM_CONCURRENCY;
    async function fetchRange(start, endIncl) {
      const res = await fetch(base, {
        headers: { ...auth, Range: `bytes=${start}-${endIncl}` }
      });
      if (!(res.status === 206 || res.status === 200)) {
        throw await gcsError(res, "getStream", key);
      }
      return res;
    }
    const size = meta.size;
    async function* ordered() {
      if (size === 0) return;
      const starts = [];
      for (let s = 0; s < size; s += CHUNK) starts.push(s);
      const inflight = [];
      let next = 0;
      const fill = () => {
        while (next < starts.length && inflight.length < CONC) {
          const s = starts[next++];
          inflight.push(fetchRange(s, Math.min(s + CHUNK, size) - 1));
        }
      };
      fill();
      while (inflight.length > 0) {
        const res = inflight.shift();
        const r = await res;
        fill();
        if (!r.body) throw new Error(`GCS getStream "${key}": empty response body`);
        for await (const part of r.body) {
          yield part;
        }
      }
    }
    return { stream: ordered(), etag: meta.etag, size };
  }
  async putStream(key, source2, opts) {
    async function* coalesced() {
      const TARGET = 1024 * 1024;
      let buf = [];
      let n = 0;
      for await (const c of source2) {
        buf.push(c);
        n += c.length;
        if (n >= TARGET) {
          yield Buffer.concat(buf, n);
          buf = [];
          n = 0;
        }
      }
      if (n > 0) yield Buffer.concat(buf, n);
    }
    const name = this.fullKey(key);
    const params = new URLSearchParams({ uploadType: "media", name });
    if (opts?.ifNoneMatch) params.set("ifGenerationMatch", "0");
    else if (opts?.ifMatch !== void 0) params.set("ifGenerationMatch", opts.ifMatch);
    const url = `${BASE}/upload/storage/v1/b/${this.bucket}/o?${params}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...await this.authHeaders(),
        "Content-Type": opts?.contentType ?? "application/octet-stream"
      },
      // Chunked transfer — GCS media upload accepts bodies with no length.
      body: Readable.toWeb(Readable.from(coalesced())),
      // Node fetch requires explicit half-duplex for streamed request bodies.
      ...{ duplex: "half" }
    });
    if (res.status === 412) {
      throw new PreconditionFailedError(key, opts?.ifNoneMatch ? "object exists" : "generation mismatch");
    }
    if (!res.ok) throw await gcsError(res, "putStream", key);
    const meta = await res.json();
    return { etag: meta.generation };
  }
  async put(key, bytes, opts) {
    const name = this.fullKey(key);
    const params = new URLSearchParams({ uploadType: "media", name });
    if (opts?.ifNoneMatch) params.set("ifGenerationMatch", "0");
    else if (opts?.ifMatch !== void 0) params.set("ifGenerationMatch", opts.ifMatch);
    const url = `${BASE}/upload/storage/v1/b/${this.bucket}/o?${params}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          ...await this.authHeaders(),
          "Content-Type": opts?.contentType ?? "application/octet-stream"
        },
        body: bytes
      });
      if (res.status === 412) {
        throw new PreconditionFailedError(key, opts?.ifNoneMatch ? "object exists" : "generation mismatch");
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await res.text().catch(() => {
        });
        const backoff = Math.min(3e3, 200 * 2 ** attempt) * (0.5 + Math.random());
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      if (!res.ok) throw await gcsError(res, "put", key);
      const meta = await res.json();
      return { etag: meta.generation };
    }
  }
  async *list(prefix) {
    const fullPrefix = this.fullKey(prefix);
    let pageToken;
    do {
      const params = new URLSearchParams({ prefix: fullPrefix });
      if (pageToken) params.set("pageToken", pageToken);
      const url = `${BASE}/storage/v1/b/${this.bucket}/o?${params}`;
      const res = await fetch(url, { headers: await this.authHeaders() });
      if (!res.ok) throw await gcsError(res, "list", prefix);
      const body = await res.json();
      for (const item of body.items ?? []) {
        const logical = this.prefix ? item.name.slice(this.prefix.replace(/\/+$/, "").length + 1) : item.name;
        yield { key: logical, etag: item.generation, size: Number(item.size) };
      }
      pageToken = body.nextPageToken;
    } while (pageToken);
  }
  /**
   * Server-side copy within the bucket (GCS rewrite API) — no bytes flow
   * through the client, so copying a 500MB snapshot takes ~a second. Loops on
   * rewriteToken as the API requires for large objects.
   */
  async copy(srcKey, destKey) {
    const src = encodeURIComponent(this.fullKey(srcKey));
    const dst = encodeURIComponent(this.fullKey(destKey));
    let token;
    for (; ; ) {
      const url = `${BASE}/storage/v1/b/${this.bucket}/o/${src}/rewriteTo/b/${this.bucket}/o/${dst}` + (token ? `?rewriteToken=${encodeURIComponent(token)}` : "");
      const res = await fetch(url, {
        method: "POST",
        headers: { ...await this.authHeaders(), "Content-Type": "application/json" },
        body: "{}"
      });
      if (!res.ok) throw await gcsError(res, "copy", srcKey);
      const body = await res.json();
      if (body.done) return { etag: body.resource?.generation ?? "" };
      token = body.rewriteToken;
    }
  }
  async delete(key) {
    const name = encodeURIComponent(this.fullKey(key));
    const url = `${BASE}/storage/v1/b/${this.bucket}/o/${name}`;
    const res = await fetch(url, { method: "DELETE", headers: await this.authHeaders() });
    if (res.status === 404) return;
    if (!res.ok) throw await gcsError(res, "delete", key);
  }
  async head(key) {
    const name = encodeURIComponent(this.fullKey(key));
    const url = `${BASE}/storage/v1/b/${this.bucket}/o/${name}`;
    const res = await fetch(url, { headers: await this.authHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw await gcsError(res, "head", key);
    const meta = await res.json();
    return { etag: meta.generation, size: Number(meta.size) };
  }
};
async function gcsError(res, op, key) {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
  }
  return new Error(`GCS ${op} "${key}" failed: ${res.status} ${res.statusText} ${detail.slice(0, 400)}`);
}

// packages/objectstore-fs/src/zeropg.ts
import { PGlite } from "@electric-sql/pglite";

// packages/lease/src/index.ts
var LockedError = class extends Error {
  holder;
  expiresAt;
  constructor(holder, expiresAt) {
    super(`database is locked by writer "${holder}" until ${expiresAt}`);
    this.name = "LockedError";
    this.holder = holder;
    this.expiresAt = expiresAt;
  }
};
var FencedError = class extends Error {
  fencingToken;
  constructor(fencingToken, detail = "") {
    super(`writer fenced: lease with token ${fencingToken} is no longer ours${detail ? ` (${detail})` : ""}`);
    this.name = "FencedError";
    this.fencingToken = fencingToken;
  }
};
var Lease = class {
  store;
  holder;
  ttlMs;
  now;
  tokenFloor;
  key;
  maxRetries;
  etag = null;
  body = null;
  acquiredByTakeover = false;
  constructor(store, opts) {
    this.store = store;
    this.holder = opts.holder;
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
    this.tokenFloor = opts.tokenFloor ?? 0;
    this.key = opts.key ?? "lease.json";
    this.maxRetries = opts.maxTakeoverRetries ?? 5;
  }
  get fencingToken() {
    if (!this.body) throw new Error("lease not held");
    return this.body.fencingToken;
  }
  get currentEtag() {
    return this.etag;
  }
  get held() {
    return this.body !== null;
  }
  /** Milliseconds until the held lease expires (negative if already past). */
  expiresInMs(now = this.now()) {
    if (!this.body) return -1;
    return Date.parse(this.body.expiresAt) - now;
  }
  /** True if acquire() took over an expired lease (a previous holder may
   * still be running). False for a clean create-if-absent acquisition. */
  get tookOver() {
    return this.acquiredByTakeover;
  }
  encode(body) {
    return new TextEncoder().encode(JSON.stringify(body));
  }
  decode(bytes) {
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  makeBody(fencingToken) {
    const t = this.now();
    return {
      holder: this.holder,
      fencingToken,
      acquiredAt: new Date(t).toISOString(),
      expiresAt: new Date(t + this.ttlMs).toISOString()
    };
  }
  isExpired(body) {
    return this.now() >= Date.parse(body.expiresAt);
  }
  /**
   * Acquire the lease. Throws LockedError if held and unexpired. On success the
   * fencing token is available via `fencingToken`.
   */
  async acquire() {
    const freshToken = this.tokenFloor + 1;
    try {
      const body = this.makeBody(freshToken);
      const { etag } = await this.store.put(this.key, this.encode(body), {
        ifNoneMatch: true,
        contentType: "application/json"
      });
      this.etag = etag;
      this.body = body;
      this.acquiredByTakeover = false;
      return freshToken;
    } catch (e) {
      if (!(e instanceof PreconditionFailedError)) throw e;
    }
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const existing = await this.store.get(this.key);
      if (!existing) {
        try {
          const body2 = this.makeBody(Math.max(freshToken, this.tokenFloor + 1));
          const { etag } = await this.store.put(this.key, this.encode(body2), {
            ifNoneMatch: true,
            contentType: "application/json"
          });
          this.etag = etag;
          this.body = body2;
          this.acquiredByTakeover = false;
          return body2.fencingToken;
        } catch (e) {
          if (e instanceof PreconditionFailedError) continue;
          throw e;
        }
      }
      const current = this.decode(existing.bytes);
      if (!this.isExpired(current)) {
        throw new LockedError(current.holder, current.expiresAt);
      }
      const takeoverToken = Math.max(current.fencingToken, this.tokenFloor) + 1;
      const body = this.makeBody(takeoverToken);
      try {
        const { etag } = await this.store.put(this.key, this.encode(body), {
          ifMatch: existing.etag,
          contentType: "application/json"
        });
        this.etag = etag;
        this.body = body;
        this.acquiredByTakeover = true;
        return takeoverToken;
      } catch (e) {
        if (e instanceof PreconditionFailedError) continue;
        throw e;
      }
    }
    throw new Error(`failed to acquire lease after ${this.maxRetries} takeover attempts (contention)`);
  }
  /**
   * Renew (heartbeat) the lease, extending expiry. CAS on our own version; if
   * it fails we were taken over => FencedError. Becoming a zombie is defined as
   * failing to renew, so this is where a zombie learns the truth.
   */
  async renew() {
    if (!this.body || !this.etag) throw new Error("lease not held; call acquire first");
    const body = this.makeBody(this.body.fencingToken);
    try {
      const { etag } = await this.store.put(this.key, this.encode(body), {
        ifMatch: this.etag,
        contentType: "application/json"
      });
      this.etag = etag;
      this.body = body;
    } catch (e) {
      if (e instanceof PreconditionFailedError) {
        const token = this.body.fencingToken;
        this.body = null;
        this.etag = null;
        throw new FencedError(token, "renew CAS failed");
      }
      throw e;
    }
  }
  /**
   * Release the lease so the next writer can acquire fresh (token = floor+1)
   * without waiting for TTL expiry. CAS-guarded: if we no longer own it, we are
   * already fenced and there is nothing to release.
   */
  async release() {
    if (!this.body || !this.etag) return;
    const current = await this.store.head(this.key);
    if (current && current.etag === this.etag) {
      await this.store.delete(this.key);
    }
    this.body = null;
    this.etag = null;
  }
  /** Re-validate the lease against the store without mutating expiry. Returns
   * true if we still hold it; used on the request path under CPU throttling
   * (DESIGN bet E4.1.b: no background heartbeat needed). */
  async validate() {
    if (!this.body || !this.etag) return false;
    const current = await this.store.head(this.key);
    if (!current || current.etag !== this.etag) {
      const token = this.body.fencingToken;
      this.body = null;
      this.etag = null;
      throw new FencedError(token, "validate: lease changed");
    }
    return !this.isExpired(this.body);
  }
};

// packages/objectstore-fs/src/manifest.ts
var MANIFEST_KEY = "manifest.json";
function encodeManifest(m) {
  return new TextEncoder().encode(JSON.stringify(m, null, 2));
}
function decodeManifest(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

// packages/objectstore-fs/src/tar.ts
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
var BLOCK = 512;
function parseOctal(buf, off, len) {
  const s = Buffer.from(buf.subarray(off, off + len)).toString("ascii").replace(/\0.*$/, "").trim();
  return s ? parseInt(s, 8) : 0;
}
function isZeroBlock(b) {
  for (let i = 0; i < BLOCK; i++) if (b[i] !== 0) return false;
  return true;
}
function sanitizeEntryName(raw) {
  const name = raw.replace(/^\/+/, "").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!name || name === ".") return null;
  const parts = name.split("/");
  if (parts.some((p) => p === ".." || p === "")) {
    throw new Error(`tar entry with unsafe path: ${JSON.stringify(raw)}`);
  }
  return parts.join("/");
}
async function extractTarStream(source2, destDir) {
  await mkdir(destDir, { recursive: true });
  let files = 0;
  let bytes = 0;
  const it = source2[Symbol.asyncIterator]();
  let chunk = null;
  let off = 0;
  async function read(n) {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      if (!chunk || off >= chunk.length) {
        const r = await it.next();
        if (r.done) return filled === 0 ? null : (() => {
          throw new Error("truncated tar stream");
        })();
        chunk = r.value;
        off = 0;
        continue;
      }
      const take = Math.min(n - filled, chunk.length - off);
      out.set(chunk.subarray(off, off + take), filled);
      off += take;
      filled += take;
    }
    return out;
  }
  async function readBody2(n, sink) {
    let remaining = n;
    while (remaining > 0) {
      if (!chunk || off >= chunk.length) {
        const r = await it.next();
        if (r.done) throw new Error("truncated tar entry body");
        chunk = r.value;
        off = 0;
        continue;
      }
      const take = Math.min(remaining, chunk.length - off);
      if (sink) await sink(chunk.subarray(off, off + take));
      off += take;
      remaining -= take;
    }
    const pad = (BLOCK - n % BLOCK) % BLOCK;
    if (pad > 0) await read(pad);
  }
  let pendingLongName = null;
  for (; ; ) {
    const header = await read(BLOCK);
    if (header === null || isZeroBlock(header)) break;
    const rawName = Buffer.from(header.subarray(0, 100)).toString("utf8").replace(/\0.*$/, "");
    const prefix = Buffer.from(header.subarray(345, 500)).toString("utf8").replace(/\0.*$/, "");
    const size = parseOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] === 0 ? 48 : header[156]);
    let name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;
    if (typeflag === "L") {
      const parts = [];
      await readBody2(size, async (b) => void parts.push(Buffer.from(b)));
      pendingLongName = Buffer.concat(parts).toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      await readBody2(size, null);
      continue;
    }
    const safe = sanitizeEntryName(name);
    if (safe === null) {
      await readBody2(size, null);
      continue;
    }
    const dest = join(destDir, safe);
    if (typeflag === "5") {
      await mkdir(dest, { recursive: true });
      await readBody2(size, null);
      continue;
    }
    if (typeflag !== "0") {
      await readBody2(size, null);
      continue;
    }
    await mkdir(join(destDir, posix.dirname(safe)), { recursive: true });
    const ws = createWriteStream(dest, { mode: 384 });
    await readBody2(size, (b) => {
      const copy = Buffer.from(b);
      return new Promise((resolve, reject) => {
        ws.write(copy, (err) => err ? reject(err) : resolve());
      });
    });
    await new Promise((resolve, reject) => ws.end((err) => err ? reject(err) : resolve()));
    files++;
    bytes += size;
  }
  return { files, bytes };
}
function octal(n, len) {
  const b = Buffer.alloc(len, 0);
  b.write(n.toString(8).padStart(len - 1, "0"), 0, "ascii");
  return b;
}
function tarHeader(name, size, type, mtimeSec) {
  const h = Buffer.alloc(BLOCK, 0);
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`tar entry name too long: ${name}`);
  }
  h.write(name, 0, "utf8");
  octal(type === "5" ? 448 : 384, 8).copy(h, 100);
  octal(0, 8).copy(h, 108);
  octal(0, 8).copy(h, 116);
  octal(size, 12).copy(h, 124);
  octal(mtimeSec, 12).copy(h, 136);
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write("ustar", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(h, 148);
  return h;
}
async function* createTarStream(rootDir) {
  const mtimeSec = Math.floor(Date.now() / 1e3);
  async function* walk(rel) {
    const abs = rel ? join(rootDir, rel) : rootDir;
    const entries = (await readdir(abs, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name)
    );
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        yield tarHeader(childRel + "/", 0, "5", mtimeSec);
        yield* walk(childRel);
      } else if (e.isFile()) {
        const st = await stat(join(rootDir, childRel));
        yield tarHeader(childRel, st.size, "0", mtimeSec);
        let written = 0;
        if (st.size <= 4 * 1024 * 1024) {
          const buf = await readFile(join(rootDir, childRel));
          written = buf.length;
          yield buf;
        } else {
          for await (const chunk of createReadStream(join(rootDir, childRel), {
            highWaterMark: 4 * 1024 * 1024
          })) {
            written += chunk.length;
            yield chunk;
          }
        }
        if (written !== st.size) {
          throw new Error(`file ${childRel} changed size during snapshot (${st.size} -> ${written})`);
        }
        const pad = (BLOCK - st.size % BLOCK) % BLOCK;
        if (pad > 0) yield Buffer.alloc(pad, 0);
      }
    }
  }
  yield* walk("");
  yield Buffer.alloc(BLOCK * 2, 0);
}
async function largestFile(rootDir) {
  let best = null;
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "pg_wal") await walk(p);
      } else if (e.isFile()) {
        const st = await stat(p);
        if (!best || st.size > best.size) best = { path: p, size: st.size };
      }
    }
  }
  await walk(rootDir);
  return best;
}

// packages/objectstore-fs/src/zeropg.ts
import { createGunzip, createGzip, gzipSync, crc32 } from "node:zlib";
import { Readable as Readable2 } from "node:stream";
import * as nodeStream from "node:stream";
import { mkdir as mkdir2, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";
var compose2 = nodeStream.compose;
var SQL_WRITE = /^\s*(insert|update|delete|create|alter|drop|truncate|comment|grant|revoke|with[\s\S]*\b(insert|update|delete)\b|copy)/i;
var WAL_GUCS = [
  ["max_wal_size", "'64MB'"],
  ["min_wal_size", "'32MB'"],
  ["wal_recycle", "off"],
  ["wal_init_zero", "off"],
  // Incremental shipping reads committed WAL straight off the filesystem; a
  // commit must have write()n its WAL before it returns or the scan misses it.
  ["synchronous_commit", "on"]
];
var COMPACT_AT_WAL_BYTES = 16 * 1024 * 1024;
var COMPACT_AT_SEGMENTS = 64;
function parseLsn(s) {
  const [hi, lo] = s.split("/");
  return BigInt(parseInt(hi, 16)) << 32n | BigInt(parseInt(lo, 16));
}
function formatLsn(l) {
  return `${(l >> 32n).toString(16).toUpperCase()}/${(l & 0xffffffffn).toString(16).toUpperCase()}`;
}
function walFileName(tli, lsn, segBytes) {
  const segno = lsn / BigInt(segBytes);
  const perId = 0x100000000n / BigInt(segBytes);
  const hex = (n) => n.toString(16).toUpperCase().padStart(8, "0");
  return hex(BigInt(tli)) + hex(segno / perId) + hex(segno % perId);
}
function randomGeneration() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
var ZeroPG = class _ZeroPG {
  store;
  pg;
  lease = null;
  noLease;
  durability;
  leaseTtlMs;
  flushIntervalMs;
  now;
  scratchBase;
  dataDir;
  manifest;
  manifestEtag = null;
  generation;
  dirty = false;
  flushTimer = null;
  closed = false;
  commitInFlight = null;
  // ---- incremental WAL shipping state ----
  /** Everything below this LSN is durable in the bucket (snapshot + shipped
   * ranges). The next incremental commit ships [lastShippedLsn, flushLsn). */
  lastShippedLsn = 0n;
  /** Segment bytes shipped since the last compaction (threshold input). */
  walBytesSinceSnapshot = 0;
  /** WAL segment file size + timeline, validated against the live cluster. */
  walSegBytes = 0;
  walTli = 1;
  /** False when this session can't do LSN-mapped shipping (function missing,
   * or our file-name math disagrees with pg_walfile_name). */
  incrementalCapable = false;
  /** Force the next commit to compact (e.g. the manifest predates v2 and has
   * no walFlushLsn to resume shipping from). */
  forceCompactNext = false;
  constructor(opts) {
    this.store = opts.store;
    this.noLease = opts.noLease ?? false;
    this.durability = opts.durability ?? (opts.relaxedDurability ? "interval" : "strict");
    this.leaseTtlMs = opts.leaseTtlMs ?? 3e4;
    this.flushIntervalMs = opts.flushIntervalMs ?? 1e3;
    const capPerSec = opts.store.cost?.maxWritesPerObjectPerSec;
    this.commitIntervalMs = opts.commitIntervalMs ?? (capPerSec ? Math.ceil(1e3 / capPerSec) : 0);
    this.now = opts.now ?? Date.now;
    this.scratchBase = opts.scratchDir ?? join2(tmpdir(), "zeropg");
  }
  commitIntervalMs;
  lastCasAt = 0;
  /** The underlying PGlite instance (escape hatch / ORM adapters). */
  get raw() {
    return this.pg;
  }
  get fencingToken() {
    return this.lease?.held ? this.lease.fencingToken : null;
  }
  get currentManifest() {
    return this.manifest;
  }
  get durabilityMode() {
    return this.durability;
  }
  /** True when there are committed-in-memory writes not yet in the bucket. */
  get pendingFlush() {
    return this.dirty;
  }
  /** Cold-start phase breakdown (ms), populated during open(). */
  bootTimings = {
    manifestGetMs: 0,
    leaseMs: 0,
    restoreMs: 0,
    snapshotBytes: 0,
    pgliteCreateMs: 0,
    totalMs: 0,
    fresh: false
  };
  static async open(opts) {
    const db2 = new _ZeroPG(opts);
    try {
      await db2.boot(opts);
    } catch (e) {
      await db2.cleanupScratch().catch(() => {
      });
      throw e;
    }
    return db2;
  }
  async boot(opts) {
    const bootStart = performance.now();
    const holder = opts.holder ?? `${process.env.HOSTNAME ?? "host"}:${process.pid}`;
    this.dataDir = join2(this.scratchBase, `data-${process.pid}-${randomGeneration()}`);
    await mkdir2(this.dataDir, { recursive: true, mode: 448 });
    const tMan = performance.now();
    const existing = await this.store.get(MANIFEST_KEY);
    this.bootTimings.manifestGetMs = performance.now() - tMan;
    const tokenFloor = existing ? decodeManifest(existing.bytes).fencingToken : 0;
    if (!this.noLease) {
      this.lease = new Lease(this.store, {
        holder,
        ttlMs: this.leaseTtlMs,
        now: this.now,
        tokenFloor
      });
      const tLease = performance.now();
      const deadline = tLease + (opts.acquireTimeoutMs ?? 0);
      for (; ; ) {
        try {
          await this.lease.acquire();
          break;
        } catch (e) {
          if (!(e instanceof LockedError) || performance.now() >= deadline) throw e;
          await new Promise((r) => setTimeout(r, 2e3));
        }
      }
      this.bootTimings.leaseMs = performance.now() - tLease;
    }
    if (existing) {
      const m = decodeManifest(existing.bytes);
      if (m.movedTo) {
        throw new Error(
          `this database was migrated out to ${m.movedTo}; refusing to boot stale data`
        );
      }
      await this.adoptManifest(m, existing.etag);
      if (this.lease?.held && this.lease.tookOver) {
        await this.fenceStamp();
      }
    } else {
      this.bootTimings.fresh = true;
      this.generation = randomGeneration();
      const tPg = performance.now();
      if (opts.seedSnapshot) {
        await extractTarStream(
          compose2(Readable2.from([Buffer.from(opts.seedSnapshot)]), createGunzip()),
          this.dataDir
        );
      }
      this.pg = await PGlite.create({ dataDir: this.dataDir });
      await this.pg.waitReady;
      this.bootTimings.pgliteCreateMs = performance.now() - tPg;
      await this.ensureWalConfig();
      await this.commitInitial();
    }
    this.bootTimings.totalMs = performance.now() - bootStart;
    if (this.durability === "interval") {
      this.flushTimer = setInterval(() => {
        void this.flush().catch(() => {
        });
      }, this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }
  /** Make `m` our state: restore its snapshot into the scratch dir, overlay
   * its WAL segments, and start PGlite on it (Postgres recovery replays the
   * overlaid WAL). Used at boot and when the manifest moves underneath us. */
  async adoptManifest(m, etag) {
    this.manifest = m;
    this.manifestEtag = etag;
    this.generation = m.generation;
    if (this.pg) {
      await this.pg.close();
      await rm(this.dataDir, { recursive: true, force: true });
      await mkdir2(this.dataDir, { recursive: true, mode: 448 });
    }
    const tRestore = performance.now();
    this.bootTimings.snapshotBytes = await this.restoreInto(this.dataDir, m.snapshot);
    await this.applyWalSegments(this.dataDir, m);
    const resumeAt = m.walSegments.length ? m.walSegments[m.walSegments.length - 1].endLsn : m.walFlushLsn;
    this.lastShippedLsn = resumeAt ? parseLsn(resumeAt) : 0n;
    this.walSegBytes = m.walSegmentBytes ?? 0;
    this.walTli = m.walTimeline ?? 1;
    this.walBytesSinceSnapshot = m.walSegments.reduce(
      (n, s) => n + Number(parseLsn(s.endLsn) - parseLsn(s.startLsn)),
      0
    );
    this.bootTimings.restoreMs = performance.now() - tRestore;
    const tPg = performance.now();
    this.pg = await PGlite.create({ dataDir: this.dataDir });
    await this.pg.waitReady;
    this.bootTimings.pgliteCreateMs = performance.now() - tPg;
    await this.ensureWalConfig();
    this.forceCompactNext = m.version !== 2 || !m.walFlushLsn;
  }
  /** Overlay shipped WAL ranges onto the restored datadir: fetch concurrently
   * (small objects), verify CRC + LSN continuity, write each range into the
   * pg_wal segment file(s) it spans at the LSN-derived offsets. */
  async applyWalSegments(dir, m) {
    const segments = m.walSegments;
    if (segments.length === 0) return;
    if (!m.walFlushLsn || !m.walSegmentBytes) {
      throw new Error("manifest has WAL segments but no walFlushLsn/walSegmentBytes");
    }
    const segBytes = m.walSegmentBytes;
    const tli = m.walTimeline ?? 1;
    let expect = parseLsn(m.walFlushLsn);
    for (const seg of segments) {
      if (parseLsn(seg.startLsn) !== expect) {
        throw new Error(`WAL range gap: expected ${formatLsn(expect)}, got ${seg.startLsn} (${seg.key})`);
      }
      expect = parseLsn(seg.endLsn);
    }
    const bodies = await Promise.all(
      segments.map(async (seg) => {
        const obj = await this.store.get(seg.key);
        if (!obj) throw new Error(`manifest references missing WAL segment ${seg.key}`);
        const want = Number(parseLsn(seg.endLsn) - parseLsn(seg.startLsn));
        if (obj.bytes.byteLength !== want) {
          throw new Error(`WAL segment ${seg.key}: size ${obj.bytes.byteLength} != ${want}`);
        }
        if (crc32(obj.bytes) >>> 0 !== seg.crc32) {
          throw new Error(`WAL segment ${seg.key}: CRC mismatch`);
        }
        return obj.bytes;
      })
    );
    for (let i = 0; i < segments.length; i++) {
      const body = bodies[i];
      let pos = parseLsn(segments[i].startLsn);
      let bodyOff = 0;
      while (bodyOff < body.byteLength) {
        const offInFile = Number(pos % BigInt(segBytes));
        const take = Math.min(body.byteLength - bodyOff, segBytes - offInFile);
        const path = join2(dir, "pg_wal", walFileName(tli, pos, segBytes));
        const fh = await open(path, "a").then(async (h) => {
          await h.close();
          return open(path, "r+");
        });
        try {
          await fh.write(body, bodyOff, take, offInFile);
        } finally {
          await fh.close();
        }
        pos += BigInt(take);
        bodyOff += take;
      }
    }
  }
  /** Read WAL bytes [start, end) out of the local pg_wal segment files. */
  async readWalRange(start, end) {
    const out = Buffer.alloc(Number(end - start));
    let pos = start;
    let outOff = 0;
    while (pos < end) {
      const offInFile = Number(pos % BigInt(this.walSegBytes));
      const take = Math.min(Number(end - pos), this.walSegBytes - offInFile);
      const path = join2(this.dataDir, "pg_wal", walFileName(this.walTli, pos, this.walSegBytes));
      const fh = await open(path, "r");
      try {
        const { bytesRead } = await fh.read(out, outOff, take, offInFile);
        if (bytesRead !== take) {
          throw new Error(`short WAL read in ${path}: ${bytesRead} < ${take} at ${offInFile}`);
        }
      } finally {
        await fh.close();
      }
      pos += BigInt(take);
      outOff += take;
    }
    return out;
  }
  /** Advance manifest.fencingToken to ours (no data change). On conflict the
   * manifest moved while we were restoring — adopt the new state and retry. */
  async fenceStamp() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const m = { ...this.manifest, fencingToken: this.lease.fencingToken };
      try {
        const { etag } = await this.store.put(MANIFEST_KEY, encodeManifest(m), {
          ifMatch: this.manifestEtag ?? void 0,
          contentType: "application/json"
        });
        this.manifest = m;
        this.manifestEtag = etag;
        return;
      } catch (e) {
        if (!(e instanceof PreconditionFailedError)) throw e;
        const cur = await this.store.get(MANIFEST_KEY);
        if (!cur) throw e;
        await this.adoptManifest(decodeManifest(cur.bytes), cur.etag);
      }
    }
    throw new Error("fence-stamp failed after repeated manifest races");
  }
  /** Stream a snapshot object into dir; returns its stored size. The key
   * suffix says whether it is gzipped (.tar.gz) or raw tar (.tar). */
  async restoreInto(dir, snapshotKey) {
    const src = await this.store.getStream(snapshotKey);
    if (!src) throw new Error(`manifest references missing snapshot ${snapshotKey}`);
    const tarStream = snapshotKey.endsWith(".gz") ? compose2(Readable2.from(src.stream), createGunzip()) : Readable2.from(src.stream);
    await extractTarStream(tarStream, dir);
    return src.size;
  }
  /**
   * Decide the snapshot codec by test-compressing a slice of the largest heap
   * file. Incompressible data (media blobs, encrypted values, random test
   * data) makes gzip pure CPU waste — on a 1-vCPU Cloud Run instance, deflate
   * caps the upload at ~12MB/s while a raw PUT runs at network speed.
   */
  async chooseCodec() {
    try {
      const big = await largestFile(this.dataDir);
      if (!big || big.size < 1024 * 1024) return "gzip";
      const fh = await import("node:fs/promises");
      const sample = Buffer.alloc(Math.min(big.size, 4 * 1024 * 1024));
      const f = await fh.open(big.path, "r");
      try {
        await f.read(sample, 0, sample.length, 0);
      } finally {
        await f.close();
      }
      const ratio = gzipSync(sample, { level: 1 }).length / sample.length;
      return ratio > 0.65 ? "none" : "gzip";
    } catch {
      return "gzip";
    }
  }
  /** Persist WAL GUCs into the datadir (travels with snapshots), and probe
   * whether this session can ship WAL incrementally: the flush-LSN function
   * must exist and our LSN->filename math must agree with the server's. */
  async ensureWalConfig() {
    try {
      const cur = await this.pg.query(
        "SELECT name, setting FROM pg_settings WHERE name = 'max_wal_size'"
      );
      await this.pg.exec("SET synchronous_commit = on");
      if (cur.rows[0]?.setting !== "64") {
        for (const [k, v] of WAL_GUCS) {
          await this.pg.exec(`ALTER SYSTEM SET ${k} = ${v}`);
        }
        await this.pg.query("SELECT pg_reload_conf()");
      }
    } catch {
    }
    try {
      const probe = await this.pg.query(
        `SELECT pg_current_wal_flush_lsn()::text lsn,
                pg_walfile_name(pg_current_wal_flush_lsn())::text fname,
                current_setting('wal_segment_size') segsz`
      );
      const { lsn, fname, segsz } = probe.rows[0];
      const m = /^(\d+)\s*(MB|kB|GB)$/.exec(segsz);
      if (!m) throw new Error(`unparseable wal_segment_size: ${segsz}`);
      const mult = { kB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2]];
      this.walSegBytes = Number(m[1]) * mult;
      this.walTli = parseInt(fname.slice(0, 8), 16);
      const at = parseLsn(lsn);
      const ours = walFileName(this.walTli, at, this.walSegBytes);
      const oursPrev = walFileName(this.walTli, at > 0n ? at - 1n : 0n, this.walSegBytes);
      this.incrementalCapable = fname === ours || fname === oursPrev;
    } catch {
      this.incrementalCapable = false;
    }
  }
  /** Flush dirty pages + trim pg_wal so the tar reflects the data, not the
   * write burst. Must run BEFORE chooseCodec so the probe sees heap files.
   * In an incremental-capable session, also switch onto a fresh WAL segment:
   * the post-snapshot tail then grows organically from byte 0, which is what
   * makes size-diff shipping safe forever after. */
  async checkpointForSnapshot() {
    const t0 = performance.now();
    let flushLsn = null;
    try {
      await this.pg.exec("CHECKPOINT");
      await this.pg.exec("CHECKPOINT");
      if (this.incrementalCapable) {
        const r = await this.pg.query(
          "SELECT pg_current_wal_flush_lsn()::text lsn"
        );
        flushLsn = r.rows[0]?.lsn ?? null;
      }
    } catch {
    }
    return { ms: performance.now() - t0, flushLsn };
  }
  async uploadSnapshot(key, codec, dumpMs) {
    const tUp = performance.now();
    let snapshotBytes = 0;
    const tar = Readable2.from(createTarStream(this.dataDir));
    const body = codec === "gzip" ? compose2(tar, createGzip({ level: 1 })) : tar;
    const counted = async function* () {
      for await (const chunk of body) {
        snapshotBytes += chunk.length;
        yield chunk;
      }
    };
    await this.store.putStream(key, counted(), {
      contentType: codec === "gzip" ? "application/gzip" : "application/x-tar"
    });
    return { snapshotBytes, dumpMs, uploadMs: performance.now() - tUp };
  }
  snapshotKeyFor(seq, codec) {
    return `generations/${this.generation}/snapshot-${seq}.tar${codec === "gzip" ? ".gz" : ""}`;
  }
  async commitInitial() {
    const cp = await this.checkpointForSnapshot();
    const codec = await this.chooseCodec();
    const snapshotKey = this.snapshotKeyFor(0, codec);
    await this.uploadSnapshot(snapshotKey, codec, cp.ms);
    if (cp.flushLsn) this.lastShippedLsn = parseLsn(cp.flushLsn);
    this.walBytesSinceSnapshot = 0;
    const m = {
      // version 2 means "walFlushLsn is recorded": incremental shipping can
      // resume from it. Without it the next writer compacts first.
      version: cp.flushLsn ? 2 : 1,
      generation: this.generation,
      fencingToken: this.lease?.held ? this.lease.fencingToken : 1,
      snapshot: snapshotKey,
      walSegments: [],
      ...cp.flushLsn ? { walFlushLsn: cp.flushLsn, walSegmentBytes: this.walSegBytes, walTimeline: this.walTli } : {},
      commitSeq: 0,
      committedAt: new Date(this.now()).toISOString()
    };
    try {
      const { etag } = await this.store.put(MANIFEST_KEY, encodeManifest(m), {
        ifNoneMatch: true,
        contentType: "application/json"
      });
      this.manifest = m;
      this.manifestEtag = etag;
    } catch (e) {
      if (e instanceof PreconditionFailedError) {
        const cur = await this.store.get(MANIFEST_KEY);
        if (!cur) throw e;
        await this.adoptManifest(decodeManifest(cur.bytes), cur.etag);
      } else throw e;
    }
  }
  /**
   * The commit: snapshot the datadir, upload it, then CAS the manifest. The
   * manifest PUT IS the commit. Precondition failure means the lease was lost
   * (a newer writer advanced the manifest) -> FencedError, never a blind retry.
   */
  async commit() {
    if (this.closed) throw new Error("database is closed");
    if (!this.dirty) return null;
    if (this.commitInFlight) return this.commitInFlight;
    this.commitInFlight = (async () => {
      const wait = this.commitIntervalMs - (this.now() - this.lastCasAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await this.doCommit();
      } finally {
        this.lastCasAt = this.now();
        this.commitInFlight = null;
      }
    })();
    return this.commitInFlight;
  }
  async doCommit() {
    if (this.incrementalCapable && !this.forceCompactNext && this.manifest.version === 2 && this.manifest.walSegments.length < COMPACT_AT_SEGMENTS && this.walBytesSinceSnapshot < COMPACT_AT_WAL_BYTES) {
      const r = await this.commitIncremental();
      if (r) return r;
    }
    return this.commitSnapshot();
  }
  /**
   * v1 commit: ship only the WAL bytes appended since the last commit — the
   * LSN range [lastShippedLsn, flushLsn) — as one immutable segment object,
   * then CAS the manifest with the new entry. O(transaction size), not
   * O(database size). Returns null if there is nothing shippable or the local
   * WAL no longer holds the range (caller falls back to compaction).
   */
  async commitIncremental() {
    const token = this.lease?.held ? this.lease.fencingToken : this.manifest.fencingToken;
    const nextSeq = this.manifest.commitSeq + 1;
    const t0 = performance.now();
    const r = await this.pg.query("SELECT pg_current_wal_flush_lsn()::text lsn");
    const end = parseLsn(r.rows[0].lsn);
    const start = this.lastShippedLsn;
    if (end <= start) return null;
    const dumpMs = performance.now() - t0;
    const tUp = performance.now();
    let buf;
    try {
      buf = await this.readWalRange(start, end);
    } catch {
      return null;
    }
    const key = `generations/${this.generation}/wal/${String(nextSeq).padStart(8, "0")}.seg`;
    await this.store.put(key, buf, { contentType: "application/octet-stream" });
    const entry = {
      key,
      startLsn: formatLsn(start),
      endLsn: formatLsn(end),
      crc32: crc32(buf) >>> 0
    };
    const uploadMs = performance.now() - tUp;
    const m = {
      ...this.manifest,
      version: 2,
      fencingToken: token,
      walSegments: [...this.manifest.walSegments, entry],
      commitSeq: nextSeq,
      committedAt: new Date(this.now()).toISOString()
    };
    const manifestMs = await this.casManifest(m, token);
    this.manifest = m;
    this.dirty = false;
    this.lastShippedLsn = end;
    this.walBytesSinceSnapshot += buf.length;
    return {
      commitSeq: nextSeq,
      generation: this.generation,
      mode: "incremental",
      snapshotKey: key,
      snapshotBytes: buf.length,
      segments: 1,
      dumpMs,
      uploadMs,
      manifestMs
    };
  }
  /** v0-style full commit, now serving as compaction + rolling backup. */
  async commitSnapshot() {
    const token = this.lease?.held ? this.lease.fencingToken : this.manifest.fencingToken;
    const nextSeq = this.manifest.commitSeq + 1;
    const cp = await this.checkpointForSnapshot();
    const codec = await this.chooseCodec();
    const snapshotKey = this.snapshotKeyFor(nextSeq, codec);
    const { snapshotBytes, dumpMs, uploadMs } = await this.uploadSnapshot(snapshotKey, codec, cp.ms);
    const oldSnapshot = this.manifest.snapshot;
    const oldBackup = this.manifest.previousSnapshot;
    const oldSegments = this.manifest.walSegments;
    const m = {
      ...this.manifest,
      version: cp.flushLsn ? 2 : 1,
      fencingToken: token,
      snapshot: snapshotKey,
      walSegments: [],
      walFlushLsn: cp.flushLsn ?? void 0,
      walSegmentBytes: cp.flushLsn ? this.walSegBytes : void 0,
      walTimeline: cp.flushLsn ? this.walTli : void 0,
      // The compacted-away snapshot stays as a one-generation-back backup in
      // case something corrupts the current state. GC preserves it.
      previousSnapshot: oldSnapshot !== snapshotKey ? oldSnapshot : oldBackup,
      commitSeq: nextSeq,
      committedAt: new Date(this.now()).toISOString()
    };
    const manifestMs = await this.casManifest(m, token);
    this.manifest = m;
    this.dirty = false;
    this.forceCompactNext = false;
    if (cp.flushLsn) this.lastShippedLsn = parseLsn(cp.flushLsn);
    this.walBytesSinceSnapshot = 0;
    if (oldBackup && oldBackup !== m.previousSnapshot) {
      void this.store.delete(oldBackup).catch(() => {
      });
    }
    for (const seg of oldSegments) {
      void this.store.delete(seg.key).catch(() => {
      });
    }
    return {
      commitSeq: nextSeq,
      generation: this.generation,
      mode: "snapshot",
      snapshotKey,
      snapshotBytes,
      segments: 0,
      dumpMs,
      uploadMs,
      manifestMs
    };
  }
  /** Conditional manifest swap — the one operation that IS a commit. */
  async casManifest(m, token) {
    const tMan = performance.now();
    try {
      const r = await this.store.put(MANIFEST_KEY, encodeManifest(m), {
        ifMatch: this.manifestEtag ?? void 0,
        contentType: "application/json"
      });
      this.manifestEtag = r.etag;
    } catch (e) {
      if (e instanceof PreconditionFailedError) {
        throw new FencedError(token, "manifest CAS failed at commit");
      }
      throw e;
    }
    return performance.now() - tMan;
  }
  /** Flush pending writes (interval/sleep mode / explicit). No-op if clean. */
  async flush() {
    return this.commit();
  }
  /** Mark the database dirty after writes made via `raw` (bypassing exec/query). */
  markDirty() {
    this.dirty = true;
  }
  // ---- Query surface (delegates to PGlite, commits on writes in strict mode) ----
  async exec(sql) {
    await this.pg.exec(sql);
    await this.afterWrite(SQL_WRITE.test(sql));
  }
  async query(sql, params) {
    const t0 = performance.now();
    const r = await this.pg.query(sql, params);
    const execMs = performance.now() - t0;
    const commit = await this.afterWrite(SQL_WRITE.test(sql));
    return { rows: r.rows, affectedRows: r.affectedRows, execMs, commit };
  }
  /** Run a function inside a Postgres transaction, then commit durably. */
  async transaction(fn) {
    const out = await this.pg.transaction(fn);
    await this.afterWrite(true);
    return out;
  }
  /** @returns the CommitInfo when this write triggered a durable commit. */
  async afterWrite(isWrite) {
    if (!isWrite) return null;
    this.dirty = true;
    if (this.durability === "strict") return this.commit();
    return null;
  }
  /**
   * Re-validate the lease on the request path (E4 bet b: no background work),
   * and renew it once it is past half-life so a warm instance under traffic
   * keeps writership indefinitely. Throws FencedError if taken over.
   */
  async validateLease() {
    if (!this.lease) return true;
    const ok = await this.lease.validate();
    if (!ok || this.lease.expiresInMs(this.now()) < this.leaseTtlMs / 2) {
      await this.lease.renew();
    }
    return true;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    try {
      if (this.dirty) {
        await (this.commitInFlight ?? this.doCommit());
      }
    } finally {
      if (this.lease) await this.lease.release().catch(() => {
      });
      await this.pg.close();
      await this.cleanupScratch().catch(() => {
      });
    }
  }
  async cleanupScratch() {
    if (this.dataDir) await rm(this.dataDir, { recursive: true, force: true });
  }
  // ---- Helpers ----
  /** Build a reusable empty-datadir snapshot (gzipped) to seed fresh DBs fast.
   * The WAL GUCs are baked in so databases born from it never bloat. */
  static async buildEmptySnapshot() {
    const pg = new PGlite();
    await pg.waitReady;
    for (const [k, v] of WAL_GUCS) {
      await pg.exec(`ALTER SYSTEM SET ${k} = ${v}`);
    }
    const file = await pg.dumpDataDir("none");
    const raw = new Uint8Array(await file.arrayBuffer());
    await pg.close();
    return gzipSync(raw, { level: 1 });
  }
};

// experiments/e3-service/server.ts
var PROCESS_START = performance.now();
var __dirname = dirname(fileURLToPath(import.meta.url));
var BUCKET = process.env.ZEROPG_BUCKET ?? "zeropg-experiments-euw1";
var DB_PREFIX = process.env.ZEROPG_PREFIX ?? "demo/default";
var APP_LABEL = process.env.APP_LABEL ?? "zeropg demo";
var DURABILITY = ["strict", "interval", "sleep"].includes(
  process.env.ZEROPG_DURABILITY ?? ""
) ? process.env.ZEROPG_DURABILITY : "sleep";
var IDLE_FLUSH_MS = Number(process.env.ZEROPG_IDLE_FLUSH_MS ?? 25e3);
var PORT = Number(process.env.PORT ?? 8080);
var INSTANCE_ID = `${process.env.K_REVISION ?? "local"}-${process.pid}`;
function loadSeed() {
  const p = join3(__dirname, "seed.tar.gz");
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : void 0;
}
var db;
var readyMs = 0;
var bootError = null;
var requestsServed = 0;
var paused = false;
var lastWrite = null;
var idleTimer = null;
function armIdleFlush() {
  if (IDLE_FLUSH_MS <= 0 || DURABILITY !== "sleep") return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (db?.pendingFlush) {
      const t0 = performance.now();
      db.flush().then(
        (c) => console.log(JSON.stringify({ event: "idle-flush", ms: Math.round(performance.now() - t0), commit: c }))
      ).catch((e) => console.error(JSON.stringify({ event: "idle-flush-error", error: String(e) })));
    }
  }, IDLE_FLUSH_MS);
  idleTimer.unref?.();
}
async function boot() {
  const store = new GcsBlobStore({ bucket: BUCKET, prefix: DB_PREFIX });
  try {
    db = await ZeroPG.open({
      store,
      holder: INSTANCE_ID,
      durability: DURABILITY,
      leaseTtlMs: 6e4,
      // > Cloud Run idle windows; revalidated on the request path
      acquireTimeoutMs: 9e4,
      // ride out revision-switch / crash-restart lease overlap
      seedSnapshot: loadSeed()
    });
    await db.raw.exec(
      `CREATE TABLE IF NOT EXISTS notes (id serial primary key, body text not null, created_at timestamptz default now());`
    );
    readyMs = performance.now() - PROCESS_START;
    console.log(JSON.stringify({ event: "ready", readyMs, boot: db.bootTimings, instance: INSTANCE_ID }));
  } catch (e) {
    bootError = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ event: "boot-error", error: bootError }));
  }
}
function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => b += c);
    req.on("end", () => resolve(b));
  });
}
async function dbSizeInfo() {
  const notes = await db.raw.query("SELECT count(*)::text n FROM notes");
  let fillerRows = "0";
  let dbBytes = "0";
  try {
    const f = await db.raw.query("SELECT count(*)::text n FROM filler");
    fillerRows = f.rows[0]?.n ?? "0";
  } catch {
  }
  try {
    const sz = await db.raw.query(
      "SELECT pg_database_size(current_database())::text b"
    );
    dbBytes = sz.rows[0]?.b ?? "0";
  } catch {
  }
  return { notes: notes.rows[0]?.n ?? "0", fillerRows, dbBytes };
}
async function handle(req, res) {
  const url = new URL(req.url ?? "/", `http://localhost`);
  if (url.pathname === "/up" || url.pathname === "/healthz") {
    if (bootError) return json(res, 503, { ok: false, error: bootError });
    return json(res, db ? 200 : 503, { ok: !!db });
  }
  if (url.pathname === "/_restart") {
    res.end(JSON.stringify({ restarting: true, pendingFlush: db?.pendingFlush ?? false }));
    setTimeout(() => {
      void (db ? db.close() : Promise.resolve()).finally(() => process.exit(0));
    }, 50);
    return;
  }
  const isColdRequest = requestsServed === 0;
  requestsServed++;
  armIdleFlush();
  if (!db) return json(res, 503, { error: bootError ?? "still booting" });
  if (url.pathname === "/_fault/pause-lease") {
    paused = true;
    return json(res, 200, { paused });
  }
  if (url.pathname === "/_fault/resume-lease") {
    paused = false;
    return json(res, 200, { paused });
  }
  if (url.pathname === "/_fault/abort") {
    res.end();
    process.exit(137);
    return;
  }
  if (url.pathname === "/metrics") {
    const mem = process.memoryUsage();
    return json(res, 200, {
      instance: INSTANCE_ID,
      revision: process.env.K_REVISION ?? null,
      coldRequest: isColdRequest,
      readyMs: Math.round(readyMs),
      bootTimings: db.bootTimings,
      requestsServed,
      fencingToken: db.fencingToken,
      durability: db.durabilityMode,
      pendingFlush: db.pendingFlush,
      lastWrite,
      rssMB: Math.round(mem.rss / 1e6),
      ...await dbSizeInfo()
    });
  }
  if (url.pathname === "/sql" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { sql } = JSON.parse(body);
      const t0 = performance.now();
      const r = await db.query(sql);
      return json(res, 200, {
        rows: r.rows,
        ms: Math.round((performance.now() - t0) * 100) / 100,
        execMs: Math.round(r.execMs * 100) / 100,
        commit: r.commit,
        durability: db.durabilityMode
      });
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (url.pathname === "/flush" && req.method === "POST") {
    try {
      const t0 = performance.now();
      const commit = await db.flush();
      return json(res, 200, { flushed: !!commit, ms: Math.round(performance.now() - t0), commit });
    } catch (e) {
      const status = e instanceof FencedError ? 423 : 500;
      return json(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (url.pathname === "/notes" && req.method === "POST") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const text = (params.get("body") ?? "").slice(0, 500);
    const durableNow = params.get("durable") === "on";
    try {
      const t0 = performance.now();
      let leaseMs = 0;
      if (!paused) {
        const tl = performance.now();
        await db.validateLease();
        leaseMs = performance.now() - tl;
      }
      const r = await db.query("INSERT INTO notes (body) VALUES ($1)", [text || "(empty)"]);
      let commit = r.commit;
      if (durableNow && !commit) commit = await db.flush();
      lastWrite = {
        at: (/* @__PURE__ */ new Date()).toISOString(),
        sql: "INSERT INTO notes (body) VALUES ($1)",
        execMs: r.execMs,
        leaseMs,
        commit,
        totalMs: performance.now() - t0,
        durable: commit !== null
      };
      res.writeHead(302, { location: "/" });
      res.end();
    } catch (e) {
      const status = e instanceof FencedError || e instanceof LockedError ? 423 : 500;
      return json(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
  if (url.pathname === "/" || url.pathname === "") {
    const info = await dbSizeInfo();
    const recent = await db.raw.query(
      "SELECT id, body, created_at FROM notes ORDER BY id DESC LIMIT 10"
    );
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "x-zeropg-boot-ms": String(Math.round(readyMs)),
      "x-zeropg-cold": String(isColdRequest)
    });
    res.end(renderPage(info, recent.rows, isColdRequest));
    return;
  }
  return json(res, 404, { error: "not found" });
}
function renderPage(info, notes, cold) {
  const b = db.bootTimings;
  const dbMB = (Number(info.dbBytes) / 1e6).toFixed(1);
  const banner = cold ? `<div class="banner cold">\u{1F976} This page was served by a <b>COLD</b> instance that woke from zero and restored a ${dbMB}&nbsp;MB Postgres in <b>${Math.round(readyMs)}&nbsp;ms</b>.</div>` : `<div class="banner warm">\u{1F525} Warm instance \u2014 request #${requestsServed}. (It cold-started in ${Math.round(readyMs)}&nbsp;ms.)</div>`;
  const rows = notes.map(
    (n) => `<li><span class="when">${new Date(n.created_at).toISOString().slice(0, 19).replace("T", " ")}</span> ${escapeHtml(n.body)}</li>`
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(APP_LABEL)} \u2014 zeropg</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;max-width:680px;margin:2rem auto;padding:0 1rem;color:#111}
 h1{font-size:1.4rem;margin-bottom:0}.sub{color:#666;margin-top:.2rem}
 .banner{padding:.8rem 1rem;border-radius:8px;margin:1rem 0;font-size:.95rem}
 .cold{background:#e8f0fe;border:1px solid #aac4f5}.warm{background:#fef6e8;border:1px solid #f5d9aa}
 table{border-collapse:collapse;margin:1rem 0;font-size:.9rem}td{padding:.15rem .8rem .15rem 0;color:#333}
 td:first-child{color:#888}
 form{display:flex;gap:.5rem;margin:1rem 0}input[type=text]{flex:1;padding:.5rem;border:1px solid #ccc;border-radius:6px}
 button{padding:.5rem 1rem;border:0;background:#1a73e8;color:#fff;border-radius:6px;cursor:pointer}
 ul{list-style:none;padding:0}li{padding:.35rem 0;border-bottom:1px solid #eee}.when{color:#999;font-size:.8rem;margin-right:.5rem}
 code{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px}
 .hint{color:#888;font-size:.85rem}.durable{display:flex;align-items:center;gap:.3rem;font-size:.85rem;color:#555;white-space:nowrap}
 details.write{background:#f6fef6;border:1px solid #bce3bc;border-radius:8px;padding:.5rem .8rem;margin:1rem 0;font-size:.9rem}
 details.write table{margin:.3rem 0}
</style></head><body>
<h1>${escapeHtml(APP_LABEL)}</h1>
<div class="sub">A real Postgres, living in a GCS bucket. No database server. Scales to zero.</div>
${banner}
<table>
 <tr><td>database size</td><td><b>${dbMB} MB</b> on disk</td></tr>
 <tr><td>notes</td><td>${info.notes}</td></tr>
 <tr><td>filler rows</td><td>${info.fillerRows}</td></tr>
 <tr><td>cold-start total</td><td><b>${Math.round(readyMs)} ms</b></td></tr>
 <tr><td>\xB7 snapshot restore (download+gunzip+untar, ${(b.snapshotBytes / 1e6).toFixed(1)} MB)</td><td>${Math.round(b.restoreMs)} ms</td></tr>
 <tr><td>\xB7 PGlite open</td><td>${Math.round(b.pgliteCreateMs)} ms</td></tr>
 <tr><td>\xB7 lease acquire</td><td>${Math.round(b.leaseMs)} ms</td></tr>
 <tr><td>durability mode</td><td><b>${db.durabilityMode}</b>${durabilityHint()}</td></tr>
 <tr><td>unflushed writes</td><td>${db.pendingFlush ? "\u23F3 in memory, upload on sleep" : "\u2713 none \u2014 bucket is current"}</td></tr>
 <tr><td>fencing token</td><td>${db.fencingToken ?? "\u2014"}</td></tr>
</table>
${renderLastWrite()}
<form method="post" action="/notes">
 <input type="text" name="body" placeholder="leave a note (it persists in the bucket)" maxlength="500" autofocus>
 <label class="durable"><input type="checkbox" name="durable"> durable&nbsp;now</label>
 <button>add note</button>
</form>
<ul>${rows || "<li><i>no notes yet \u2014 add one, then watch it survive a scale-to-zero</i></li>"}</ul>
<p class="sub">Powered by <code>zeropg</code>: PGlite + object storage + a conditional-write lease.</p>
</body></html>`;
}
function durabilityHint() {
  switch (db.durabilityMode) {
    case "sleep":
      return ' <span class="hint">\u2014 writes are memory-speed; the snapshot uploads when the instance is put to sleep</span>';
    case "interval":
      return ' <span class="hint">\u2014 background flush every second (bounded loss window)</span>';
    default:
      return ' <span class="hint">\u2014 every write is durable in the bucket before it returns</span>';
  }
}
function renderLastWrite() {
  if (!lastWrite) return "";
  const w = lastWrite;
  const f = (n) => n < 10 ? n.toFixed(2) : String(Math.round(n));
  const fmtBytes = (n) => n < 1e6 ? `${(n / 1e3).toFixed(1)} KB` : `${(n / 1e6).toFixed(1)} MB`;
  const commitRows = w.commit ? w.commit.mode === "incremental" ? `<tr><td>\xB7 WAL delta scan</td><td>${f(w.commit.dumpMs)} ms</td></tr>
 <tr><td>\xB7 WAL segment upload (${w.commit.segments} \xD7 ${fmtBytes(w.commit.snapshotBytes)})</td><td>${f(w.commit.uploadMs)} ms</td></tr>
 <tr><td>\xB7 manifest CAS (the actual commit)</td><td>${f(w.commit.manifestMs)} ms</td></tr>` : `<tr><td>\xB7 checkpoint + WAL switch</td><td>${f(w.commit.dumpMs)} ms</td></tr>
 <tr><td>\xB7 snapshot upload \u2014 compaction (${fmtBytes(w.commit.snapshotBytes)})</td><td>${f(w.commit.uploadMs)} ms</td></tr>
 <tr><td>\xB7 manifest CAS (the actual commit)</td><td>${f(w.commit.manifestMs)} ms</td></tr>` : `<tr><td>\xB7 bucket upload</td><td><i>deferred \u2014 happens on ${db.durabilityMode === "interval" ? "the next interval flush" : "sleep/flush"}</i></td></tr>`;
  return `<details class="write" open><summary>last write: <b>${f(w.totalMs)} ms</b> ${w.durable ? "(durable in bucket)" : "(memory; not yet in bucket)"}</summary>
<table>
 <tr><td>SQL execute (PGlite, in memory)</td><td>${f(w.execMs)} ms</td></tr>
 <tr><td>lease validate/renew</td><td>${f(w.leaseMs)} ms</td></tr>
 ${commitRows}
 <tr><td>total request</td><td><b>${f(w.totalMs)} ms</b></td></tr>
</table></details>`;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
async function shutdown(signal) {
  const pending = db?.pendingFlush ?? false;
  console.log(JSON.stringify({ event: "shutdown", signal, pendingFlush: pending }));
  const t0 = performance.now();
  try {
    if (db) await db.close();
    console.log(
      JSON.stringify({ event: "shutdown-done", flushed: pending, ms: Math.round(performance.now() - t0) })
    );
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "shutdown-flush-failed",
        lostPendingWrites: pending,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      })
    );
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
await boot();
createServer((req, res) => {
  handle(req, res).catch((e) => json(res, 500, { error: e instanceof Error ? e.message : String(e) }));
}).listen(PORT, () => console.log(JSON.stringify({ event: "listening", port: PORT })));
