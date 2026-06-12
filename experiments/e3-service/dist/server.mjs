import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// experiments/e3-service/server.ts
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// packages/blobstore/src/types.ts
var PreconditionFailedError = class extends Error {
  key;
  constructor(key, detail) {
    super(`precondition failed for key "${key}"${detail ? `: ${detail}` : ""}`);
    this.name = "PreconditionFailedError";
    this.key = key;
  }
};

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
var BASE = "https://storage.googleapis.com";
function joinPrefix(prefix, key) {
  if (!prefix) return key;
  const p = prefix.replace(/\/+$/, "");
  return `${p}/${key}`;
}
var GcsBlobStore = class {
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
  async put(key, bytes, opts) {
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
      body: bytes
    });
    if (res.status === 412) {
      throw new PreconditionFailedError(key, opts?.ifNoneMatch ? "object exists" : "generation mismatch");
    }
    if (!res.ok) throw await gcsError(res, "put", key);
    const meta = await res.json();
    return { etag: meta.generation };
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

// packages/objectstore-fs/src/zeropg.ts
import { gzipSync, gunzipSync } from "node:zlib";
var SQL_WRITE = /^\s*(insert|update|delete|create|alter|drop|truncate|comment|grant|revoke|with[\s\S]*\b(insert|update|delete)\b|copy)/i;
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
  relaxed;
  flushIntervalMs;
  now;
  manifest;
  manifestEtag = null;
  generation;
  dirty = false;
  flushTimer = null;
  closed = false;
  commitInFlight = null;
  constructor(opts) {
    this.store = opts.store;
    this.noLease = opts.noLease ?? false;
    this.relaxed = opts.relaxedDurability ?? false;
    this.flushIntervalMs = opts.flushIntervalMs ?? 1e3;
    this.now = opts.now ?? Date.now;
  }
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
  /** Cold-start phase breakdown (ms), populated during open(). */
  bootTimings = {
    manifestGetMs: 0,
    leaseMs: 0,
    snapshotGetMs: 0,
    snapshotBytes: 0,
    gunzipMs: 0,
    pgliteCreateMs: 0,
    totalMs: 0,
    fresh: false
  };
  static async open(opts) {
    const db2 = new _ZeroPG(opts);
    await db2.boot(opts);
    return db2;
  }
  async boot(opts) {
    const bootStart = performance.now();
    const holder = opts.holder ?? `${process.env.HOSTNAME ?? "host"}:${process.pid}`;
    const tMan = performance.now();
    const existing = await this.store.get(MANIFEST_KEY);
    this.bootTimings.manifestGetMs = performance.now() - tMan;
    const tokenFloor = existing ? decodeManifest(existing.bytes).fencingToken : 0;
    if (!this.noLease) {
      this.lease = new Lease(this.store, {
        holder,
        ttlMs: opts.leaseTtlMs ?? 3e4,
        now: this.now,
        tokenFloor
      });
      const tLease = performance.now();
      await this.lease.acquire();
      this.bootTimings.leaseMs = performance.now() - tLease;
    }
    if (existing) {
      const m = decodeManifest(existing.bytes);
      if (m.movedTo) {
        throw new Error(
          `this database was migrated out to ${m.movedTo}; refusing to boot stale data`
        );
      }
      this.manifest = m;
      this.manifestEtag = existing.etag;
      this.generation = m.generation;
      const tSnap = performance.now();
      const snap = await this.store.get(m.snapshot);
      this.bootTimings.snapshotGetMs = performance.now() - tSnap;
      if (!snap) throw new Error(`manifest references missing snapshot ${m.snapshot}`);
      this.bootTimings.snapshotBytes = snap.bytes.byteLength;
      const tGz = performance.now();
      const tar = gunzipSync(snap.bytes);
      this.bootTimings.gunzipMs = performance.now() - tGz;
      const tPg = performance.now();
      this.pg = await PGlite.create({ loadDataDir: new Blob([tar]) });
      await this.pg.waitReady;
      this.bootTimings.pgliteCreateMs = performance.now() - tPg;
    } else {
      this.bootTimings.fresh = true;
      this.generation = randomGeneration();
      const tPg = performance.now();
      if (opts.seedSnapshot) {
        const tar = gunzipSync(opts.seedSnapshot);
        this.pg = await PGlite.create({ loadDataDir: new Blob([tar]) });
      } else {
        this.pg = new PGlite();
      }
      await this.pg.waitReady;
      this.bootTimings.pgliteCreateMs = performance.now() - tPg;
      await this.commitInitial();
    }
    this.bootTimings.totalMs = performance.now() - bootStart;
    if (this.relaxed) {
      this.flushTimer = setInterval(() => {
        void this.flush().catch(() => {
        });
      }, this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }
  async snapshotBytes() {
    const t0 = performance.now();
    const file = await this.pg.dumpDataDir("none");
    const raw = new Uint8Array(await file.arrayBuffer());
    const bytes = gzipSync(raw, { level: 1 });
    return { bytes, dumpMs: performance.now() - t0 };
  }
  async commitInitial() {
    const { bytes } = await this.snapshotBytes();
    const snapshotKey = `generations/${this.generation}/snapshot-0.tar.gz`;
    await this.store.put(snapshotKey, bytes, { contentType: "application/gzip" });
    const m = {
      version: 1,
      generation: this.generation,
      fencingToken: this.lease?.held ? this.lease.fencingToken : 1,
      snapshot: snapshotKey,
      walSegments: [],
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
        const cm = decodeManifest(cur.bytes);
        this.manifest = cm;
        this.manifestEtag = cur.etag;
        this.generation = cm.generation;
        const snap = await this.store.get(cm.snapshot);
        if (snap) {
          await this.pg.close();
          this.pg = await PGlite.create({ loadDataDir: new Blob([gunzipSync(snap.bytes)]) });
          await this.pg.waitReady;
        }
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
    this.commitInFlight = this.doCommit().finally(() => {
      this.commitInFlight = null;
    });
    return this.commitInFlight;
  }
  async doCommit() {
    const token = this.lease?.held ? this.lease.fencingToken : this.manifest.fencingToken;
    const { bytes, dumpMs } = await this.snapshotBytes();
    const nextSeq = this.manifest.commitSeq + 1;
    const snapshotKey = `generations/${this.generation}/snapshot-${nextSeq}.tar.gz`;
    const tUp = performance.now();
    await this.store.put(snapshotKey, bytes, { contentType: "application/gzip" });
    const uploadMs = performance.now() - tUp;
    const m = {
      ...this.manifest,
      fencingToken: token,
      snapshot: snapshotKey,
      commitSeq: nextSeq,
      committedAt: new Date(this.now()).toISOString()
    };
    const tMan = performance.now();
    let etag;
    try {
      const r = await this.store.put(MANIFEST_KEY, encodeManifest(m), {
        ifMatch: this.manifestEtag ?? void 0,
        contentType: "application/json"
      });
      etag = r.etag;
    } catch (e) {
      if (e instanceof PreconditionFailedError) {
        throw new FencedError(token, "manifest CAS failed at commit");
      }
      throw e;
    }
    const manifestMs = performance.now() - tMan;
    this.manifest = m;
    this.manifestEtag = etag;
    this.dirty = false;
    const prevKey = `generations/${this.generation}/snapshot-${this.manifest.commitSeq - 1}.tar.gz`;
    if (this.manifest.commitSeq - 1 >= 0) {
      void this.store.delete(prevKey).catch(() => {
      });
    }
    return {
      commitSeq: nextSeq,
      generation: this.generation,
      snapshotKey,
      snapshotBytes: bytes.byteLength,
      dumpMs,
      uploadMs,
      manifestMs
    };
  }
  /** Flush pending writes (relaxed mode / explicit). No-op if not dirty. */
  async flush() {
    return this.commit();
  }
  // ---- Query surface (delegates to PGlite, commits on writes in strict mode) ----
  async exec(sql) {
    await this.pg.exec(sql);
    await this.afterWrite(SQL_WRITE.test(sql));
  }
  async query(sql, params) {
    const r = await this.pg.query(sql, params);
    await this.afterWrite(SQL_WRITE.test(sql));
    return { rows: r.rows, affectedRows: r.affectedRows };
  }
  /** Run a function inside a Postgres transaction, then commit durably. */
  async transaction(fn) {
    const out = await this.pg.transaction(fn);
    this.dirty = true;
    if (!this.relaxed) await this.commit();
    return out;
  }
  async afterWrite(isWrite) {
    if (!isWrite) return;
    this.dirty = true;
    if (!this.relaxed) await this.commit();
  }
  /** Re-validate the lease on the request path (E4 bet b: no background work). */
  async validateLease() {
    if (!this.lease) return true;
    return this.lease.validate();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    try {
      if (this.dirty) await this.commit();
    } finally {
      if (this.lease) await this.lease.release().catch(() => {
      });
      await this.pg.close();
    }
  }
  // ---- Helpers ----
  /** Build a reusable empty-datadir snapshot (gzipped) to seed fresh DBs fast. */
  static async buildEmptySnapshot() {
    const pg = new PGlite();
    await pg.waitReady;
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
var RELAXED = process.env.ZEROPG_RELAXED === "1";
var PORT = Number(process.env.PORT ?? 8080);
var INSTANCE_ID = `${process.env.K_REVISION ?? "local"}-${process.pid}`;
function loadSeed() {
  const p = join(__dirname, "seed.tar.gz");
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : void 0;
}
var db;
var readyMs = 0;
var bootError = null;
var requestsServed = 0;
var paused = false;
async function boot() {
  const store = new GcsBlobStore({ bucket: BUCKET, prefix: DB_PREFIX });
  try {
    db = await ZeroPG.open({
      store,
      holder: INSTANCE_ID,
      relaxedDurability: RELAXED,
      leaseTtlMs: 6e4,
      // > Cloud Run idle windows; revalidated on the request path
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
  if (url.pathname === "/healthz") {
    if (bootError) return json(res, 503, { ok: false, error: bootError });
    return json(res, db ? 200 : 503, { ok: !!db });
  }
  const isColdRequest = requestsServed === 0;
  requestsServed++;
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
      relaxed: RELAXED,
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
      return json(res, 200, { rows: r.rows, ms: Math.round((performance.now() - t0) * 100) / 100 });
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (url.pathname === "/notes" && req.method === "POST") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const text = (params.get("body") ?? "").slice(0, 500);
    try {
      if (!paused) await db.validateLease();
      await db.query("INSERT INTO notes (body) VALUES ($1)", [text || "(empty)"]);
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
</style></head><body>
<h1>${escapeHtml(APP_LABEL)}</h1>
<div class="sub">A real Postgres, living in a GCS bucket. No database server. Scales to zero.</div>
${banner}
<table>
 <tr><td>database size</td><td><b>${dbMB} MB</b> on disk</td></tr>
 <tr><td>notes</td><td>${info.notes}</td></tr>
 <tr><td>filler rows</td><td>${info.fillerRows}</td></tr>
 <tr><td>cold-start total</td><td><b>${Math.round(readyMs)} ms</b></td></tr>
 <tr><td>\xB7 snapshot download</td><td>${Math.round(b.snapshotGetMs)} ms (${(b.snapshotBytes / 1e6).toFixed(1)} MB)</td></tr>
 <tr><td>\xB7 gunzip</td><td>${Math.round(b.gunzipMs)} ms</td></tr>
 <tr><td>\xB7 PGlite init + restore</td><td>${Math.round(b.pgliteCreateMs)} ms</td></tr>
 <tr><td>\xB7 lease acquire</td><td>${Math.round(b.leaseMs)} ms</td></tr>
 <tr><td>fencing token</td><td>${db.fencingToken ?? "\u2014"}</td></tr>
</table>
<form method="post" action="/notes">
 <input type="text" name="body" placeholder="leave a note (it persists in the bucket)" maxlength="500" autofocus>
 <button>add note</button>
</form>
<ul>${rows || "<li><i>no notes yet \u2014 add one, then watch it survive a scale-to-zero</i></li>"}</ul>
<p class="sub">Powered by <code>zeropg</code>: PGlite + object storage + a conditional-write lease.</p>
</body></html>`;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
async function shutdown(signal) {
  console.log(JSON.stringify({ event: "shutdown", signal }));
  try {
    if (db) await db.close();
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
