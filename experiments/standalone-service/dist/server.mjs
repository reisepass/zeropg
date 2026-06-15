import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// experiments/standalone-service/server.ts
import { readFileSync as readFileSync2, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as join5 } from "node:path";

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
  maxWritesPerObjectPerSec: 1,
  // True monotonic generation numbers — no ABA window. The strongest CAS tier
  // (TODO B3); R2/S3 are 'etag'. See types.ts CostModel.casStrength.
  casStrength: "generation"
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

// packages/blobstore/src/r2.ts
import { createHash, createHmac } from "node:crypto";
var R2_COST = {
  asOf: "2026-06",
  writeOpUsd: 4.5 / 1e6,
  // Class A $4.50 / million
  readOpUsd: 0.36 / 1e6,
  // Class B $0.36 / million
  storageGbMonthUsd: 0.015,
  internetEgressGbUsd: 0,
  // the whole point of R2
  casStrength: "etag",
  // S3 If-Match/If-None-Match, not monotonic generations
  freeTier: { storageGb: 10, writeOps: 1e6, readOps: 1e7 }
};
var EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
function r2OptionsFromEnv(prefix) {
  const e = process.env;
  const accessKeyId = e.R2_ACCESS_KEY_ID ?? e.AWS_ACCESS_KEY_ID;
  const secretAccessKey = e.R2_SECRET_ACCESS_KEY ?? e.AWS_SECRET_ACCESS_KEY;
  const bucket = e.R2_BUCKET ?? e.AWS_BUCKET ?? e.S3_BUCKET;
  const accountId = e.R2_ACCOUNT_ID ?? e.CF_ACCOUNT_ID;
  const endpoint = e.R2_ENDPOINT ?? e.AWS_ENDPOINT_URL_S3 ?? e.AWS_ENDPOINT_URL;
  if (!accessKeyId || !secretAccessKey || !bucket) return null;
  if (!accountId && !endpoint) return null;
  return {
    accessKeyId,
    secretAccessKey,
    bucket,
    accountId,
    endpoint,
    prefix,
    region: e.R2_REGION ?? e.AWS_REGION ?? "auto"
  };
}
function joinPrefix2(prefix, key) {
  if (!prefix) return key;
  const p = prefix.replace(/\/+$/, "");
  return `${p}/${key}`;
}
function uriEncode(s, encodeSlash = true) {
  let out = "";
  for (const ch of Buffer.from(s, "utf8").toString("latin1")) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === "/") out += encodeSlash ? "%2F" : "/";
    else out += "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}
function hmac(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}
function stripQuotes(s) {
  return s.replace(/^W\//, "").replace(/^"|"$/g, "");
}
var R2BlobStore = class _R2BlobStore {
  cost = R2_COST;
  accessKeyId;
  secretAccessKey;
  bucket;
  prefix;
  origin;
  region;
  constructor(opts) {
    this.accessKeyId = opts.accessKeyId;
    this.secretAccessKey = opts.secretAccessKey;
    this.bucket = opts.bucket;
    this.prefix = opts.prefix;
    this.region = opts.region ?? "auto";
    const endpoint = opts.endpoint ?? (opts.accountId ? `https://${opts.accountId}.r2.cloudflarestorage.com` : void 0);
    if (!endpoint) throw new Error("R2BlobStore: provide either `endpoint` or `accountId`");
    this.origin = endpoint.replace(/\/+$/, "");
  }
  static fromEnv(prefix) {
    const opts = r2OptionsFromEnv(prefix);
    return opts ? new _R2BlobStore(opts) : null;
  }
  fullKey(key) {
    return joinPrefix2(this.prefix, key);
  }
  /** Path-style object URL: <origin>/<bucket>/<key>. */
  objectPath(key) {
    return `/${this.bucket}/${uriEncode(this.fullKey(key), false)}`;
  }
  // ---- SigV4 -------------------------------------------------------------
  /**
   * Sign a request and return the headers to send. `query` is the parsed query
   * params (already decoded values); they are canonicalised and signed. The
   * caller builds the final URL from `path` + the same query.
   */
  sign(method, path, query, headers, payloadHash) {
    const now = /* @__PURE__ */ new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const host = new URL(this.origin).host;
    const allHeaders = {
      ...headers,
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    };
    const headerNames = Object.keys(allHeaders).map((h) => h.toLowerCase()).sort();
    const lower = {};
    for (const [k, v] of Object.entries(allHeaders)) lower[k.toLowerCase()] = String(v).trim();
    const canonicalHeaders = headerNames.map((h) => `${h}:${lower[h]}
`).join("");
    const signedHeaders = headerNames.join(";");
    const canonicalQuery = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join("&");
    const canonicalRequest = [
      method,
      path,
      // already RFC3986-encoded (slashes preserved)
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join("\n");
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex")
    ].join("\n");
    const kDate = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
    return {
      ...allHeaders,
      Authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    };
  }
  buildUrl(path, query) {
    const qs = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join("&");
    return `${this.origin}${path}${qs ? `?${qs}` : ""}`;
  }
  /** Map S3 conditional headers from our PutOptions. */
  condHeaders(opts) {
    const h = {};
    if (opts?.ifNoneMatch) h["If-None-Match"] = "*";
    else if (opts?.ifMatch !== void 0) h["If-Match"] = opts.ifMatch;
    if (opts?.contentType) h["Content-Type"] = opts.contentType;
    return h;
  }
  // ---- core ops ----------------------------------------------------------
  async get(key, opts) {
    const path = this.objectPath(key);
    const headers = {};
    if (opts?.range) {
      const { start, end } = opts.range;
      headers.Range = `bytes=${start}-${end ?? ""}`;
    }
    const signed = this.sign("GET", path, {}, headers, EMPTY_SHA256);
    const res = await fetch(this.buildUrl(path, {}), { headers: signed });
    if (res.status === 404) return null;
    if (!(res.ok || res.status === 206)) throw await r2Error(res, "get", key);
    const buf = new Uint8Array(await res.arrayBuffer());
    return { bytes: buf, etag: stripQuotes(res.headers.get("etag") ?? ""), size: buf.byteLength };
  }
  async head(key) {
    const path = this.objectPath(key);
    const signed = this.sign("HEAD", path, {}, {}, EMPTY_SHA256);
    const res = await fetch(this.buildUrl(path, {}), { method: "HEAD", headers: signed });
    if (res.status === 404) return null;
    if (!res.ok) throw await r2Error(res, "head", key);
    return {
      etag: stripQuotes(res.headers.get("etag") ?? ""),
      size: Number(res.headers.get("content-length") ?? "0")
    };
  }
  async put(key, bytes, opts) {
    const path = this.objectPath(key);
    const payloadHash = createHash("sha256").update(bytes).digest("hex");
    const cond = this.condHeaders(opts);
    for (let attempt = 0; ; attempt++) {
      const signed = this.sign("PUT", path, {}, cond, payloadHash);
      const res = await fetch(this.buildUrl(path, {}), {
        method: "PUT",
        headers: signed,
        body: bytes
      });
      if (res.status === 412 || res.status === 409) {
        await res.body?.cancel().catch(() => {
        });
        throw new PreconditionFailedError(
          key,
          opts?.ifNoneMatch ? "object exists" : "etag mismatch"
        );
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await res.text().catch(() => {
        });
        const backoff = Math.min(3e3, 200 * 2 ** attempt) * (0.5 + Math.random());
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      if (!res.ok) throw await r2Error(res, "put", key);
      const etag = stripQuotes(res.headers.get("etag") ?? "");
      await res.body?.cancel().catch(() => {
      });
      return { etag };
    }
  }
  async delete(key) {
    const path = this.objectPath(key);
    const signed = this.sign("DELETE", path, {}, {}, EMPTY_SHA256);
    const res = await fetch(this.buildUrl(path, {}), { method: "DELETE", headers: signed });
    if (res.status === 404 || res.status === 204 || res.ok) {
      await res.body?.cancel().catch(() => {
      });
      return;
    }
    throw await r2Error(res, "delete", key);
  }
  async *list(prefix) {
    const fullPrefix = this.fullKey(prefix);
    const stripLen = this.prefix ? this.prefix.replace(/\/+$/, "").length + 1 : 0;
    let token;
    do {
      const query = { "list-type": "2", prefix: fullPrefix };
      if (token) query["continuation-token"] = token;
      const path = `/${this.bucket}`;
      const signed = this.sign("GET", path, query, {}, EMPTY_SHA256);
      const res = await fetch(this.buildUrl(path, query), { headers: signed });
      if (!res.ok) throw await r2Error(res, "list", prefix);
      const xml = await res.text();
      for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
        const name = decodeXml(matchTag(block, "Key") ?? "");
        const etag = stripQuotes(decodeXml(matchTag(block, "ETag") ?? ""));
        const size = Number(matchTag(block, "Size") ?? "0");
        const logical = stripLen ? name.slice(stripLen) : name;
        yield { key: logical, etag, size };
      }
      const truncated = matchTag(xml, "IsTruncated") === "true";
      token = truncated ? matchTag(xml, "NextContinuationToken") ?? void 0 : void 0;
    } while (token);
  }
  /**
   * Server-side copy within the bucket (S3 CopyObject) — no bytes flow through
   * the client. The source is pinned via x-amz-copy-source.
   */
  async copy(srcKey, destKey) {
    const path = this.objectPath(destKey);
    const headers = {
      "x-amz-copy-source": `/${this.bucket}/${uriEncode(this.fullKey(srcKey), false)}`
    };
    const signed = this.sign("PUT", path, {}, headers, EMPTY_SHA256);
    const res = await fetch(this.buildUrl(path, {}), { method: "PUT", headers: signed });
    if (!res.ok) throw await r2Error(res, "copy", srcKey);
    const xml = await res.text();
    return { etag: stripQuotes(decodeXml(matchTag(xml, "ETag") ?? "")) };
  }
  // ---- streaming ---------------------------------------------------------
  /** Tuning for getStream's parallel-range download (mirrors gcs.ts). */
  static STREAM_CHUNK_BYTES = 32 * 1024 * 1024;
  static STREAM_CONCURRENCY = 4;
  /** Multipart part size for putStream (S3 minimum is 5MB per non-final part). */
  static PART_BYTES = 8 * 1024 * 1024;
  async getStream(key) {
    const meta = await this.head(key);
    if (!meta) return null;
    const path = this.objectPath(key);
    const self = this;
    const CHUNK = _R2BlobStore.STREAM_CHUNK_BYTES;
    const CONC = _R2BlobStore.STREAM_CONCURRENCY;
    async function fetchRange(start, endIncl) {
      const headers = { Range: `bytes=${start}-${endIncl}`, "If-Match": meta.etag };
      const signed = self.sign("GET", path, {}, headers, EMPTY_SHA256);
      const res = await fetch(self.buildUrl(path, {}), { headers: signed });
      if (res.status === 412) throw await r2Error(res, "getStream(version changed)", key);
      if (!(res.status === 206 || res.status === 200)) throw await r2Error(res, "getStream", key);
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
        const r = await inflight.shift();
        fill();
        if (!r.body) throw new Error(`R2 getStream "${key}": empty response body`);
        for await (const part of r.body) yield part;
      }
    }
    return { stream: ordered(), etag: meta.etag, size };
  }
  /**
   * PUT from a byte stream. Small streams (under one part) collapse to a single
   * conditional PutObject; larger ones use an S3 multipart upload (parts
   * buffered to PART_BYTES, so peak memory is O(part size)). The conditional
   * precondition is applied to the final commit step in both cases — a single
   * PUT, or CompleteMultipartUpload — so it stays atomic.
   */
  async putStream(key, source2, opts) {
    const PART = _R2BlobStore.PART_BYTES;
    const it = source2[Symbol.asyncIterator]();
    let buf = [];
    let n = 0;
    let done = false;
    while (n < PART) {
      const { value, done: d } = await it.next();
      if (d) {
        done = true;
        break;
      }
      buf.push(value);
      n += value.length;
    }
    if (done) return this.put(key, Buffer.concat(buf, n), opts);
    const path = this.objectPath(key);
    const uploadId = await this.createMultipart(path, key, opts?.contentType);
    const parts = [];
    try {
      let partNo = 0;
      const flush = async (chunks, total) => {
        partNo++;
        const body = Buffer.concat(chunks, total);
        const etag = await this.uploadPart(path, key, uploadId, partNo, body);
        parts.push({ PartNumber: partNo, ETag: etag });
      };
      await flush(buf, n);
      buf = [];
      n = 0;
      for (; ; ) {
        const { value, done: d } = await it.next();
        if (d) break;
        buf.push(value);
        n += value.length;
        if (n >= PART) {
          await flush(buf, n);
          buf = [];
          n = 0;
        }
      }
      if (n > 0) await flush(buf, n);
      return await this.completeMultipart(path, key, uploadId, parts, opts);
    } catch (e) {
      await this.abortMultipart(path, uploadId).catch(() => {
      });
      throw e;
    }
  }
  async createMultipart(path, key, contentType) {
    const query = { uploads: "" };
    const headers = {};
    if (contentType) headers["Content-Type"] = contentType;
    const signed = this.sign("POST", path, query, headers, EMPTY_SHA256);
    const res = await fetch(this.buildUrl(path, query), { method: "POST", headers: signed });
    if (!res.ok) throw await r2Error(res, "createMultipart", key);
    const xml = await res.text();
    const id = matchTag(xml, "UploadId");
    if (!id) throw new Error(`R2 createMultipart "${key}": no UploadId in response`);
    return id;
  }
  async uploadPart(path, key, uploadId, partNumber, body) {
    const query = { partNumber: String(partNumber), uploadId };
    const payloadHash = createHash("sha256").update(body).digest("hex");
    for (let attempt = 0; ; attempt++) {
      const signed = this.sign("PUT", path, query, {}, payloadHash);
      const res = await fetch(this.buildUrl(path, query), {
        method: "PUT",
        headers: signed,
        body
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await res.text().catch(() => {
        });
        await new Promise((r) => setTimeout(r, Math.min(3e3, 200 * 2 ** attempt) * (0.5 + Math.random())));
        continue;
      }
      if (!res.ok) throw await r2Error(res, `uploadPart#${partNumber}`, key);
      const etag = res.headers.get("etag") ?? "";
      await res.body?.cancel().catch(() => {
      });
      if (!etag) throw new Error(`R2 uploadPart "${key}" #${partNumber}: no ETag header`);
      return etag;
    }
  }
  async completeMultipart(path, key, uploadId, parts, opts) {
    const query = { uploadId };
    const xmlBody = "<CompleteMultipartUpload>" + parts.map((p) => `<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${p.ETag}</ETag></Part>`).join("") + "</CompleteMultipartUpload>";
    const bodyBytes = Buffer.from(xmlBody, "utf8");
    const payloadHash = createHash("sha256").update(bodyBytes).digest("hex");
    const headers = this.condHeaders(opts);
    const signed = this.sign("POST", path, query, headers, payloadHash);
    const res = await fetch(this.buildUrl(path, query), {
      method: "POST",
      headers: signed,
      body: bodyBytes
    });
    if (res.status === 412 || res.status === 409) {
      await res.body?.cancel().catch(() => {
      });
      throw new PreconditionFailedError(key, opts?.ifNoneMatch ? "object exists" : "etag mismatch");
    }
    if (!res.ok) throw await r2Error(res, "completeMultipart", key);
    const xml = await res.text();
    if (/<Error>/.test(xml)) throw new Error(`R2 completeMultipart "${key}" failed: ${xml.slice(0, 400)}`);
    return { etag: stripQuotes(decodeXml(matchTag(xml, "ETag") ?? "")) };
  }
  async abortMultipart(path, uploadId) {
    const query = { uploadId };
    const signed = this.sign("DELETE", path, query, {}, EMPTY_SHA256);
    const res = await fetch(this.buildUrl(path, query), { method: "DELETE", headers: signed });
    await res.body?.cancel().catch(() => {
    });
  }
};
function matchTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : void 0;
}
function decodeXml(s) {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
async function r2Error(res, op, key) {
  let detail = "";
  try {
    detail = await res.text();
  } catch {
  }
  return new Error(`R2 ${op} "${key}" failed: ${res.status} ${res.statusText} ${detail.slice(0, 400)}`);
}

// packages/server/src/server.ts
import { createServer } from "node:http";

// packages/objectstore-fs/src/zeropg.ts
import { PGlite as PGlite2 } from "@electric-sql/pglite";

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
   * Bump our held token to strictly above `minToken` if it isn't already.
   * Called right after acquiring when the caller re-reads the manifest and finds
   * the manifest's fencingToken >= our issued token (which happens on the
   * clean-release path: the previous holder released, we created a fresh lease
   * with floor+1, but the manifest still carries the previous holder's last
   * commit token — same value). CASes our own lease object in-place so that any
   * concurrent reader of the lease sees the update atomically; throws FencedError
   * if we were already taken over between acquire() and this call.
   */
  async upgradeToken(minToken) {
    if (!this.body || !this.etag) throw new Error("lease not held; call acquire first");
    if (this.body.fencingToken > minToken) return;
    const newToken = minToken + 1;
    const body = this.makeBody(newToken);
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
        throw new FencedError(token, "upgradeToken CAS failed: taken over before upgrade");
      }
      throw e;
    }
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
  async function readBody(n, sink) {
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
      await readBody(size, async (b) => void parts.push(Buffer.from(b)));
      pendingLongName = Buffer.concat(parts).toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      await readBody(size, null);
      continue;
    }
    const safe = sanitizeEntryName(name);
    if (safe === null) {
      await readBody(size, null);
      continue;
    }
    const dest = join(destDir, safe);
    if (typeflag === "5") {
      await mkdir(dest, { recursive: true });
      await readBody(size, null);
      continue;
    }
    if (typeflag !== "0") {
      await readBody(size, null);
      continue;
    }
    await mkdir(join(destDir, posix.dirname(safe)), { recursive: true });
    const ws = createWriteStream(dest, { mode: 384 });
    await readBody(size, (b) => {
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

// packages/objectstore-fs/src/archive.ts
import { PGlite } from "@electric-sql/pglite";

// packages/objectstore-fs/src/restore.ts
import { createGunzip, crc32 } from "node:zlib";
import { Readable as Readable2 } from "node:stream";
import * as nodeStream from "node:stream";
import { open } from "node:fs/promises";
import { join as join2 } from "node:path";
var compose2 = nodeStream.compose;
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
async function restoreSnapshotInto(store, dir, snapshotKey) {
  const src = await store.getStream(snapshotKey);
  if (!src) throw new Error(`manifest references missing snapshot ${snapshotKey}`);
  const tarStream = snapshotKey.endsWith(".gz") ? compose2(Readable2.from(src.stream), createGunzip()) : Readable2.from(src.stream);
  await extractTarStream(tarStream, dir);
  return src.size;
}
async function applyWalSegments(store, dir, m) {
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
      const obj = await store.get(seg.key);
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
  const touched = /* @__PURE__ */ new Set();
  for (let i = 0; i < segments.length; i++) {
    const body = bodies[i];
    let pos = parseLsn(segments[i].startLsn);
    let bodyOff = 0;
    while (bodyOff < body.byteLength) {
      const offInFile = Number(pos % BigInt(segBytes));
      const take = Math.min(body.byteLength - bodyOff, segBytes - offInFile);
      const path = join2(dir, "pg_wal", walFileName(tli, pos, segBytes));
      touched.add(path);
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
  for (const path of touched) {
    const fh = await open(path, "r+");
    try {
      const st = await fh.stat();
      if (st.size < segBytes) await fh.truncate(segBytes);
    } finally {
      await fh.close();
    }
  }
}

// packages/objectstore-fs/src/archive.ts
import { createGzip, gzipSync } from "node:zlib";
import { Readable as Readable3 } from "node:stream";
import * as nodeStream2 from "node:stream";
import { mkdtemp, mkdir as mkdir2, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";
var compose4 = nodeStream2.compose;
var INDEX_KEY = "backups/index.json";
function encodeBackupIndex(idx) {
  return new TextEncoder().encode(JSON.stringify(idx, null, 2));
}
function decodeBackupIndex(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}
function backupKey(commitSeq, committedAt, codec) {
  const seq = String(commitSeq).padStart(20, "0");
  const stamp = committedAt.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  return `backups/${seq}-${stamp}.tar${codec === "gzip" ? ".gz" : ""}`;
}
var DAY_MS = 864e5;
function utcDayKey(d) {
  return d.toISOString().slice(0, 10);
}
function utcMonthKey(d) {
  return d.toISOString().slice(0, 7);
}
function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
function gfsKeep(sorted, gfs) {
  const keep = /* @__PURE__ */ new Set();
  const pick = (keyOf, limit) => {
    if (!limit || limit <= 0) return;
    const newestPerBucket = /* @__PURE__ */ new Map();
    for (const b of sorted) newestPerBucket.set(keyOf(new Date(b.committedAt)), b);
    const bucketKeys = [...newestPerBucket.keys()].sort();
    for (const bk of bucketKeys.slice(-limit)) keep.add(newestPerBucket.get(bk).key);
  };
  pick(utcDayKey, gfs.daily);
  pick(isoWeekKey, gfs.weekly);
  pick(utcMonthKey, gfs.monthly);
  return keep;
}
function retain(backups, policy, nowMs) {
  if (backups.length === 0) return [];
  const sorted = [...backups].sort(
    (a, b) => Date.parse(a.committedAt) - Date.parse(b.committedAt) || a.commitSeq - b.commitSeq
  );
  const keep = /* @__PURE__ */ new Set();
  keep.add(sorted[sorted.length - 1].key);
  if (policy.keepLast && policy.keepLast > 0) {
    for (const b of sorted.slice(-policy.keepLast)) keep.add(b.key);
  }
  if (policy.maxAgeDays && policy.maxAgeDays > 0) {
    const cutoff = nowMs - policy.maxAgeDays * DAY_MS;
    for (const b of sorted) if (Date.parse(b.committedAt) >= cutoff) keep.add(b.key);
  }
  if (policy.gfs) {
    for (const k of gfsKeep(sorted, policy.gfs)) keep.add(k);
  }
  return sorted.filter((b) => keep.has(b.key));
}
var ColdArchiver = class {
  primary;
  secondary;
  scratchBase;
  now;
  log;
  constructor(primary, secondary, opts = {}) {
    this.primary = primary;
    this.secondary = secondary;
    this.scratchBase = opts.scratchDir ?? tmpdir();
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((e) => console.log(JSON.stringify(e)));
  }
  /**
   * Take one self-contained backup of the primary's current committed point
   * and append it to the cold-store index. Returns the new entry, or null when
   * there is nothing to back up (empty/migrated primary) — a logged no-op,
   * never an error (cf. gc.ts returning empty on no manifest).
   *
   * Algorithm (design doc "out-of-process archiver"):
   *   1. GET the current manifest from the PRIMARY (pins the committed point).
   *   2. Restore it into a temp datadir (restoreSnapshotInto + applyWalSegments,
   *      the exact existing restore path).
   *   3. CHECKPOINT and re-tar a clean, WAL-folded full snapshot.
   *   4. putStream to the SECONDARY at an immutable backups/<seq>-<at> key
   *      (ifNoneMatch: backup keys are never reused).
   *   5. Append to the CAS'd backup index.
   */
  async backupOnce() {
    const cur = await this.primary.get(MANIFEST_KEY);
    if (!cur) {
      this.log({ event: "zeropg-backup-skip", reason: "no manifest at primary (empty bucket)" });
      return null;
    }
    const m = decodeManifest(cur.bytes);
    if (m.movedTo) {
      this.log({ event: "zeropg-backup-skip", reason: "primary migrated out", movedTo: m.movedTo });
      return null;
    }
    const dir = await mkdtemp(join3(this.scratchBase, "zpg-backup-"));
    try {
      await restoreSnapshotInto(this.primary, dir, m.snapshot);
      await applyWalSegments(this.primary, dir, m);
      const pg = await PGlite.create({ dataDir: dir });
      await pg.waitReady;
      try {
        await pg.exec("CHECKPOINT");
        await pg.exec("CHECKPOINT");
      } catch {
      }
      await pg.syncToFs().catch(() => {
      });
      await pg.close();
      const codec = await this.chooseCodec(dir);
      const key = backupKey(m.commitSeq, m.committedAt, codec);
      let sizeBytes = 0;
      const tar = Readable3.from(createTarStream(dir));
      const body = codec === "gzip" ? compose4(tar, createGzip({ level: 1 })) : tar;
      const counted = async function* () {
        for await (const chunk of body) {
          sizeBytes += chunk.length;
          yield chunk;
        }
      };
      try {
        await this.secondary.putStream(key, counted(), {
          ifNoneMatch: true,
          contentType: codec === "gzip" ? "application/gzip" : "application/x-tar"
        });
      } catch (e) {
        if (e instanceof PreconditionFailedError) {
          this.log({ event: "zeropg-backup-exists", key, commitSeq: m.commitSeq });
          return this.adoptExisting(key, m, codec);
        }
        throw e;
      }
      const entry = {
        key,
        commitSeq: m.commitSeq,
        committedAt: m.committedAt,
        createdAt: new Date(this.now()).toISOString(),
        sizeBytes,
        codec,
        sourceGeneration: m.generation,
        fencingToken: m.fencingToken
      };
      await this.appendToIndex(entry);
      this.log({
        event: "zeropg-backup-ok",
        key,
        commitSeq: entry.commitSeq,
        sizeBytes: entry.sizeBytes,
        codec: entry.codec
      });
      return entry;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {
      });
    }
  }
  /** Append an entry to the CAS'd backup index, retrying on a lost race exactly
   * as the manifest commit does. Idempotent: an entry whose key already exists
   * is left as-is (a re-run that adopted a pre-existing snapshot object). */
  async appendToIndex(entry) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await this.secondary.get(INDEX_KEY);
      if (!cur) {
        const idx2 = { version: 1, backups: [entry] };
        try {
          await this.secondary.put(INDEX_KEY, encodeBackupIndex(idx2), {
            ifNoneMatch: true,
            contentType: "application/json"
          });
          return;
        } catch (e) {
          if (e instanceof PreconditionFailedError) continue;
          throw e;
        }
      }
      const idx = decodeBackupIndex(cur.bytes);
      if (idx.backups.some((b) => b.key === entry.key)) return;
      idx.backups.push(entry);
      idx.backups.sort((a, b) => a.commitSeq - b.commitSeq);
      try {
        await this.secondary.put(INDEX_KEY, encodeBackupIndex(idx), {
          ifMatch: cur.etag,
          contentType: "application/json"
        });
        return;
      } catch (e) {
        if (e instanceof PreconditionFailedError) continue;
        throw e;
      }
    }
    throw new Error("backup index CAS failed after repeated races");
  }
  /**
   * A snapshot object already existed at `key`. Two cases:
   *   1. A previous run fully recorded it — its entry is in the index; return it
   *      (the idempotent re-run path).
   *   2. A previous run wrote the object but CRASHED before the index append —
   *      the object is an orphan the index never names. The object IS a complete,
   *      immutable snapshot of THIS committed point (same key => same commitSeq),
   *      so we can finish what the dead run started: reconstruct the entry from
   *      the manifest we are holding + the object's real stored size, and append
   *      it. This is what makes "crash mid-backup, next backup succeeds" hold —
   *      without it the orphan is un-adoptable and the backup is lost forever.
   */
  async adoptExisting(key, m, codec) {
    const cur = await this.secondary.get(INDEX_KEY);
    if (cur) {
      const existing = decodeBackupIndex(cur.bytes).backups.find((b) => b.key === key);
      if (existing) return existing;
    }
    const head = await this.secondary.head(key);
    if (!head) return null;
    const entry = {
      key,
      commitSeq: m.commitSeq,
      committedAt: m.committedAt,
      createdAt: new Date(this.now()).toISOString(),
      sizeBytes: head.size,
      codec,
      sourceGeneration: m.generation,
      fencingToken: m.fencingToken
    };
    await this.appendToIndex(entry);
    this.log({ event: "zeropg-backup-adopted-orphan", key, commitSeq: m.commitSeq, sizeBytes: head.size });
    return entry;
  }
  /**
   * Restore a backup from the cold store into a datadir. Picks the entry by
   * `commitSeq` if given, else the newest. A backup is already a clean,
   * WAL-folded snapshot, so this is the snapshot half of the restore path with
   * NO WAL overlay (restoreSnapshotInto handles the .tar / .tar.gz codecs).
   *
   * Returns the chosen entry + the datadir it was materialized into; the caller
   * boots a ZeroPG/PGlite on it directly, or seeds a fresh primary bucket from
   * it for disaster recovery into a new home.
   */
  async restoreFromBackup(seq, into) {
    const cur = await this.secondary.get(INDEX_KEY);
    if (!cur) throw new Error("no backup index at secondary (nothing to restore)");
    const idx = decodeBackupIndex(cur.bytes);
    if (idx.backups.length === 0) throw new Error("backup index is empty");
    const entry = seq === void 0 ? idx.backups[idx.backups.length - 1] : idx.backups.find((b) => b.commitSeq === seq);
    if (!entry) throw new Error(`no backup with commitSeq ${seq}`);
    const dir = into ?? await mkdtemp(join3(this.scratchBase, "zpg-restore-"));
    await mkdir2(dir, { recursive: true, mode: 448 });
    const bytes = await restoreSnapshotInto(this.secondary, dir, entry.key);
    this.log({ event: "zeropg-restore-ok", key: entry.key, commitSeq: entry.commitSeq, dir, bytes });
    return { entry, dir, bytes };
  }
  /**
   * Apply a retention policy to the cold store: compute the keep-set with the
   * pure `retain`, delete everything outside it from the secondary, and rewrite
   * the index — mirroring gc.ts's keep-set-first discipline (never delete
   * outside the computed set).
   *
   * Cold-tier guard: when respectMinStorageDuration is set (default) and the
   * destination's CostModel declares a minStorageDurationDays, an object younger
   * than that minimum is NOT deleted (deleting early still pays the floored
   * price — the opposite of the savings the cold tier is for); it is reported as
   * `blocked` and survives in the index. A policy that would routinely churn
   * under the minimum (e.g. maxAgeDays below it) is warned about.
   */
  async applyRetention(policy, opts = {}) {
    const cur = await this.secondary.get(INDEX_KEY);
    if (!cur) {
      this.log({ event: "zeropg-retention-skip", reason: "no backup index" });
      return { kept: [], deleted: [], blocked: [], bytesFreed: 0 };
    }
    const dryRun = opts.dryRun ?? false;
    const idx = decodeBackupIndex(cur.bytes);
    const nowMs = this.now();
    const keepKeys = new Set(retain(idx.backups, policy, nowMs).map((b) => b.key));
    const minDays = this.secondary.cost?.minStorageDurationDays;
    const respectMin = policy.respectMinStorageDuration ?? true;
    if (respectMin && minDays && policy.maxAgeDays && policy.maxAgeDays < minDays) {
      this.log({
        event: "zeropg-retention-warn",
        reason: `maxAgeDays ${policy.maxAgeDays} on a tier with a ${minDays}-day minimum storage duration will incur early-deletion fees on every backup; raise maxAgeDays >= ${minDays} or use a Standard/IA-class bucket`
      });
    }
    const deleted = [];
    const blocked = [];
    let bytesFreed = 0;
    for (const b of idx.backups) {
      if (keepKeys.has(b.key)) continue;
      if (respectMin && minDays) {
        const ageDays = (nowMs - Date.parse(b.createdAt)) / DAY_MS;
        if (ageDays < minDays) {
          blocked.push(b);
          this.log({ event: "zeropg-retention-blocked", key: b.key, ageDays: Math.floor(ageDays), minDays });
          continue;
        }
      }
      if (!dryRun) await this.secondary.delete(b.key);
      deleted.push(b);
      bytesFreed += b.sizeBytes;
    }
    const deletedKeys = new Set(deleted.map((b) => b.key));
    const kept = idx.backups.filter((b) => !deletedKeys.has(b.key));
    if (!dryRun && deleted.length > 0) {
      const newIdx = { version: 1, backups: kept };
      await this.secondary.put(INDEX_KEY, encodeBackupIndex(newIdx), {
        ifMatch: cur.etag,
        contentType: "application/json"
      });
    }
    this.log({
      event: "zeropg-retention-ok",
      dryRun,
      kept: kept.length,
      deleted: deleted.length,
      blocked: blocked.length,
      bytesFreed
    });
    return { kept, deleted, blocked, bytesFreed };
  }
  /**
   * Decide the snapshot codec by test-compressing a slice of the largest heap
   * file (mirrors ZeroPG.chooseCodec): incompressible data makes gzip pure CPU
   * waste, so ship raw tar and let the NIC do the work.
   */
  async chooseCodec(dir) {
    try {
      const big = await largestFile(dir);
      if (!big || big.size < 1024 * 1024) return "gzip";
      const { open: open3 } = await import("node:fs/promises");
      const sample = Buffer.alloc(Math.min(big.size, 4 * 1024 * 1024));
      const f = await open3(big.path, "r");
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
};

// packages/objectstore-fs/src/zeropg.ts
import { createGunzip as createGunzip2, createGzip as createGzip2, gzipSync as gzipSync2, crc32 as crc322 } from "node:zlib";
import { Readable as Readable4 } from "node:stream";
import * as nodeStream3 from "node:stream";
import { mkdir as mkdir3, rm as rm2, open as open2 } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join4 } from "node:path";
var compose6 = nodeStream3.compose;
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
  fullPageWrites;
  walCompression;
  // ---- Track D: secondary cold-storage backup ----
  backup = null;
  archiver = null;
  /** In-flight background backup, awaited by close()/flush() so a clean
   * shutdown never abandons a backup mid-upload. */
  backupInFlight = null;
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
  /** Cluster flush LSN right after this life's boot: WAL at or below this is
   * recovery artifacts, not user writes — a dirty flag with no growth past it
   * (idempotent boot DDL) must not upload anything. */
  lifeBaseLsn = 0n;
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
    this.scratchBase = opts.scratchDir ?? join4(tmpdir2(), "zeropg");
    this.fullPageWrites = opts.fullPageWrites ?? !/^(off|false|0)$/i.test(
      process.env.ZEROPG_FULL_PAGE_WRITES ?? ""
    );
    this.walCompression = opts.walCompression ?? process.env.ZEROPG_WAL_COMPRESSION;
    if (opts.backup) {
      this.backup = opts.backup;
      this.archiver = new ColdArchiver(opts.store, opts.backup.store, {
        scratchDir: opts.backup.scratchDir,
        now: this.now
      });
    }
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
    const db = new _ZeroPG(opts);
    try {
      await db.boot(opts);
    } catch (e) {
      await db.cleanupScratch().catch(() => {
      });
      throw e;
    }
    return db;
  }
  async boot(opts) {
    const bootStart = performance.now();
    const holder = opts.holder ?? `${process.env.HOSTNAME ?? "host"}:${process.pid}`;
    this.dataDir = join4(this.scratchBase, `data-${process.pid}-${randomGeneration()}`);
    await mkdir3(this.dataDir, { recursive: true, mode: 448 });
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
      const fresh = await this.store.get(MANIFEST_KEY) ?? existing;
      const m = decodeManifest(fresh.bytes);
      if (m.movedTo) {
        throw new Error(
          `this database was migrated out to ${m.movedTo}; refusing to boot stale data`
        );
      }
      await this.adoptManifest(m, fresh.etag);
      if (this.lease?.held && !this.lease.tookOver) {
        await this.lease.upgradeToken(m.fencingToken);
      }
      if (this.lease?.held && this.lease.tookOver) {
        await this.fenceStamp();
      }
    } else {
      this.bootTimings.fresh = true;
      this.generation = randomGeneration();
      const tPg = performance.now();
      if (opts.seedSnapshot) {
        await extractTarStream(
          compose6(Readable4.from([Buffer.from(opts.seedSnapshot)]), createGunzip2()),
          this.dataDir
        );
      }
      this.pg = await PGlite2.create({ dataDir: this.dataDir });
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
      await rm2(this.dataDir, { recursive: true, force: true });
      await mkdir3(this.dataDir, { recursive: true, mode: 448 });
    }
    const tRestore = performance.now();
    this.bootTimings.snapshotBytes = await restoreSnapshotInto(this.store, this.dataDir, m.snapshot);
    await applyWalSegments(this.store, this.dataDir, m);
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
    this.pg = await PGlite2.create({ dataDir: this.dataDir });
    await this.pg.waitReady;
    this.bootTimings.pgliteCreateMs = performance.now() - tPg;
    await this.ensureWalConfig();
    this.forceCompactNext = true;
    if (this.incrementalCapable) {
      try {
        const r = await this.pg.query(
          "SELECT pg_current_wal_flush_lsn()::text lsn"
        );
        this.lifeBaseLsn = parseLsn(r.rows[0].lsn);
      } catch {
        this.lifeBaseLsn = 0n;
      }
    }
  }
  /**
   * Every 8KB WAL page carries its own address (xlp_pageaddr). Verify each
   * full page in [start, end) claims the LSN it sits at — zeros or stale
   * bytes fail immediately. This is the guard against shipping WAL the
   * engine has ACCOUNTED as flushed but not yet physically written back to
   * the host FS (observed live: a 5MB commit's tail read back as garbage and
   * the restorer dropped it — acked-write loss).
   */
  validateWalRange(buf, start) {
    const PAGE = 8192n;
    let page = (start + PAGE - 1n) / PAGE * PAGE;
    const end = start + BigInt(buf.length);
    while (page + 12n <= end) {
      const off = Number(page - start);
      const pageaddr = buf.readBigUInt64LE(off + 8);
      const magic = buf.readUInt16LE(off);
      if (pageaddr !== page || magic === 0) return page;
      page += PAGE;
    }
    return null;
  }
  /**
   * Read [start, end) from local pg_wal for shipping: force the engine's FS
   * write-back first (PGlite accounts WAL flushed ahead of physically writing
   * it — large commits lose that race), then validate every full WAL page's
   * self-address, retrying while write-back catches up. Returns null if the
   * bytes never validate or the range has fallen off disk — the caller then
   * compacts rather than ship garbage. The one read-and-trust gate both the
   * incremental and rebaseline commit paths go through.
   */
  async readShippableWal(start, end) {
    await this.pg.syncToFs();
    let buf;
    try {
      buf = await this.readWalRange(start, end);
      for (let attempt = 0; ; attempt++) {
        const badPage = this.validateWalRange(buf, start);
        if (badPage === null) break;
        if (attempt >= 20) {
          console.error(
            JSON.stringify({
              event: "zeropg-wal-writeback-stall",
              badPageLsn: formatLsn(badPage),
              range: `${formatLsn(start)}..${formatLsn(end)}`,
              action: "compacting"
            })
          );
          return null;
        }
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
        buf = await this.readWalRange(start, end);
      }
    } catch {
      return null;
    }
    return buf;
  }
  /** Read WAL bytes [start, end) out of the local pg_wal segment files. */
  async readWalRange(start, end) {
    const out = Buffer.alloc(Number(end - start));
    let pos = start;
    let outOff = 0;
    while (pos < end) {
      const offInFile = Number(pos % BigInt(this.walSegBytes));
      const take = Math.min(Number(end - pos), this.walSegBytes - offInFile);
      const path = join4(this.dataDir, "pg_wal", walFileName(this.walTli, pos, this.walSegBytes));
      const fh = await open2(path, "r");
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
      const ratio = gzipSync2(sample, { level: 1 }).length / sample.length;
      return ratio > 0.65 ? "none" : "gzip";
    } catch {
      return "gzip";
    }
  }
  /** Persist WAL GUCs into the datadir (travels with snapshots), reconcile the
   * per-instance WAL knobs (full_page_writes / wal_compression) so they are
   * LIVE for this life's writes, and probe whether this session can ship WAL
   * incrementally: the flush-LSN function must exist and our LSN->filename math
   * must agree with the server's. */
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
      }
      const fpw = this.fullPageWrites ? "on" : "off";
      await this.pg.exec(`ALTER SYSTEM SET full_page_writes = ${fpw}`);
      let walcApplied = false;
      if (this.walCompression) {
        try {
          await this.pg.exec(`ALTER SYSTEM SET wal_compression = ${this.walCompression}`);
          walcApplied = true;
        } catch {
        }
      }
      await this.pg.query("SELECT pg_reload_conf()");
      const live = await this.pg.query(
        "SELECT setting FROM pg_settings WHERE name = 'full_page_writes'"
      );
      const liveWalc = walcApplied ? (await this.pg.query(
        "SELECT setting FROM pg_settings WHERE name = 'wal_compression'"
      )).rows[0]?.setting : void 0;
      const fpwMismatch = live.rows[0]?.setting !== fpw;
      const walcMismatch = walcApplied && liveWalc !== this.walCompression;
      if (fpwMismatch || walcMismatch) {
        await this.pg.close();
        this.pg = await PGlite2.create({ dataDir: this.dataDir });
        await this.pg.waitReady;
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
    await this.pg.syncToFs().catch(() => {
    });
    return { ms: performance.now() - t0, flushLsn };
  }
  async uploadSnapshot(key, codec, dumpMs) {
    const tUp = performance.now();
    let snapshotBytes = 0;
    const tar = Readable4.from(createTarStream(this.dataDir));
    const body = codec === "gzip" ? compose6(tar, createGzip2({ level: 1 })) : tar;
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
  /** Data-object keys embed the writer's fencing token (DESIGN 4.4): a fenced
   * zombie's in-flight upload then lands at a key nobody references, instead
   * of overwriting the same-seq object the winner's manifest points at.
   * (E4 P4 produced exactly that collision before tokens were embedded.) */
  snapshotKeyFor(seq, token, codec) {
    return `generations/${this.generation}/snapshot-${seq}-t${token}.tar${codec === "gzip" ? ".gz" : ""}`;
  }
  segmentKeyFor(seq, token) {
    return `generations/${this.generation}/wal/${String(seq).padStart(8, "0")}-t${token}.seg`;
  }
  async commitInitial() {
    const cp = await this.checkpointForSnapshot();
    const codec = await this.chooseCodec();
    const snapshotKey = this.snapshotKeyFor(0, this.lease?.held ? this.lease.fencingToken : 1, codec);
    await this.uploadSnapshot(snapshotKey, codec, cp.ms);
    if (cp.flushLsn) {
      this.lastShippedLsn = parseLsn(cp.flushLsn);
      this.lifeBaseLsn = this.lastShippedLsn;
    }
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
    if (this.incrementalCapable && this.lifeBaseLsn > 0n) {
      try {
        const r = await this.pg.query(
          "SELECT pg_current_wal_flush_lsn()::text lsn"
        );
        if (parseLsn(r.rows[0].lsn) <= this.lifeBaseLsn) {
          this.dirty = false;
          return null;
        }
      } catch {
      }
    }
    if (this.incrementalCapable && this.manifest.version === 2) {
      if (this.forceCompactNext) {
        const r = await this.commitRebaseline();
        if (r) return r;
      } else if (
        // Steady state: append this commit's WAL delta, until the tail grows
        // past the compaction thresholds.
        this.manifest.walSegments.length < COMPACT_AT_SEGMENTS && this.walBytesSinceSnapshot < COMPACT_AT_WAL_BYTES
      ) {
        const r = await this.commitIncremental();
        if (r === "empty") {
          this.dirty = false;
          return null;
        }
        if (r) return r;
      }
    }
    return this.commitSnapshot();
  }
  /**
   * First commit of a writer life: re-ship the WAL accumulated since the
   * current snapshot as ONE fresh segment and REPLACE the inherited segment
   * list, instead of re-snapshotting the whole database.
   *
   * Why this is sound where cross-life incremental resume is not: it ships
   * [snapshot.walFlushLsn, ourCurrentFlushLsn) — both ends are clean
   * boundaries this instance can trust (the snapshot's own checkpoint LSN and
   * our own post-recovery flush LSN), read from one coherent on-disk WAL
   * stream that recovery just replayed and extended. It never relies on the
   * dead predecessor's ragged tail LSN, which is the whole reason the
   * per-life rule exists. The new range covers everything the inherited
   * segments did (recovery replayed them) plus our end-of-recovery
   * checkpoint, so replacing them drops no committed data.
   *
   * Cost: O(WAL since the snapshot) ≤ the compaction threshold, not O(database
   * size) — a few KB–MB on the 500MB demo vs a 533MB snapshot. Returns null
   * to fall back to a full snapshot when preconditions don't hold.
   */
  async commitRebaseline() {
    const snapFlush = this.manifest.walFlushLsn;
    if (!snapFlush) return null;
    const token = this.lease?.held ? this.lease.fencingToken : this.manifest.fencingToken;
    const nextSeq = this.manifest.commitSeq + 1;
    const start = parseLsn(snapFlush);
    const t0 = performance.now();
    const r = await this.pg.query("SELECT pg_current_wal_flush_lsn()::text lsn");
    const end = parseLsn(r.rows[0].lsn);
    if (end <= start) return null;
    if (end - start > BigInt(COMPACT_AT_WAL_BYTES)) return null;
    const dumpMs = performance.now() - t0;
    const tUp = performance.now();
    const buf = await this.readShippableWal(start, end);
    if (!buf) return null;
    const key = this.segmentKeyFor(nextSeq, token);
    await this.store.put(key, buf, { contentType: "application/octet-stream" });
    const entry = {
      key,
      startLsn: formatLsn(start),
      endLsn: formatLsn(end),
      crc32: crc322(buf) >>> 0
    };
    const uploadMs = performance.now() - tUp;
    const oldSegments = this.manifest.walSegments;
    const m = {
      ...this.manifest,
      version: 2,
      fencingToken: token,
      walSegments: [entry],
      // REPLACE: this range supersedes + extends the inherited ones
      commitSeq: nextSeq,
      committedAt: new Date(this.now()).toISOString()
    };
    const manifestMs = await this.casManifest(m, token);
    this.manifest = m;
    this.dirty = false;
    this.forceCompactNext = false;
    this.lastShippedLsn = end;
    this.walBytesSinceSnapshot = Number(end - start);
    for (const seg of oldSegments) void this.store.delete(seg.key).catch(() => {
    });
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
  /**
   * v1 commit: ship only the WAL bytes appended since the last commit — the
   * LSN range [lastShippedLsn, flushLsn) — as one immutable segment object,
   * then CAS the manifest with the new entry. O(transaction size), not
   * O(database size). Returns 'empty' when the WAL did not grow (a dirty
   * flag with no real change), or null when the local WAL no longer holds
   * the range (caller falls back to compaction).
   */
  async commitIncremental() {
    const token = this.lease?.held ? this.lease.fencingToken : this.manifest.fencingToken;
    const nextSeq = this.manifest.commitSeq + 1;
    const t0 = performance.now();
    const r = await this.pg.query("SELECT pg_current_wal_flush_lsn()::text lsn");
    const end = parseLsn(r.rows[0].lsn);
    const start = this.lastShippedLsn;
    if (end === start) return "empty";
    if (end < start) {
      console.error(
        JSON.stringify({
          event: "zeropg-wal-continuity-violation",
          clusterFlushLsn: formatLsn(end),
          resumeLsn: formatLsn(start),
          action: "compacting"
        })
      );
      this.forceCompactNext = true;
      return null;
    }
    const dumpMs = performance.now() - t0;
    const tUp = performance.now();
    const buf = await this.readShippableWal(start, end);
    if (!buf) return null;
    const key = this.segmentKeyFor(nextSeq, token);
    await this.store.put(key, buf, { contentType: "application/octet-stream" });
    const entry = {
      key,
      startLsn: formatLsn(start),
      endLsn: formatLsn(end),
      crc32: crc322(buf) >>> 0
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
    const snapshotKey = this.snapshotKeyFor(nextSeq, token, codec);
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
    await this.runBackup();
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
  /**
   * Track D backup hook. Called after a compaction snapshot is durable in the
   * primary. No-op when no backup target is configured. The archiver reads the
   * primary leaselessly (no contention) and writes to the secondary, then
   * applies retention. A failure here is LOGGED, never fatal: a backup that
   * could not be taken must not fail an already-committed write.
   *
   * Default is background (fire-and-forget) so commit latency stays flat; the
   * promise is parked in backupInFlight and always awaited by flush()/close().
   * blocking:true awaits inline (tests that assert the backup right after the
   * awaited commit).
   */
  async runBackup() {
    if (!this.archiver || !this.backup) return;
    const archiver = this.archiver;
    const policy = this.backup.retention;
    const run = async () => {
      try {
        const entry = await archiver.backupOnce();
        if (entry && policy) await archiver.applyRetention(policy);
      } catch (e) {
        console.log(
          JSON.stringify({
            event: "zeropg-backup-error",
            error: e instanceof Error ? e.message : String(e)
          })
        );
      }
    };
    if (this.backup.blocking) {
      await run();
    } else {
      const prev = this.backupInFlight ?? Promise.resolve();
      this.backupInFlight = prev.then(run);
    }
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
  /**
   * Force a full-snapshot compaction now: fold the current state + all shipped
   * WAL into a fresh snapshot and empty the segment list, bounding future
   * cold-start restore to the snapshot alone. No-op if already compact
   * (nothing dirty and no WAL tail). Useful right after a bulk load so the
   * persisted state is a clean snapshot rather than one giant WAL segment.
   */
  async compact() {
    if (this.closed) throw new Error("database is closed");
    while (this.commitInFlight) await this.commitInFlight.catch(() => {
    });
    if (!this.dirty && this.manifest.walSegments.length === 0) return null;
    this.commitInFlight = this.commitSnapshot().finally(() => {
      this.lastCasAt = this.now();
      this.commitInFlight = null;
    });
    return this.commitInFlight;
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
      if (this.backupInFlight) await this.backupInFlight.catch(() => {
      });
    } finally {
      if (this.lease) await this.lease.release().catch(() => {
      });
      await this.pg.close();
      await this.cleanupScratch().catch(() => {
      });
    }
  }
  /** Await any in-flight background cold backup (Track D). Tests / graceful
   * shutdown use this to observe the backup that a non-blocking commit kicked
   * off. No-op when no backup target is configured. */
  async drainBackups() {
    if (this.backupInFlight) await this.backupInFlight.catch(() => {
    });
  }
  async cleanupScratch() {
    if (this.dataDir) await rm2(this.dataDir, { recursive: true, force: true });
  }
  // ---- Helpers ----
  /** Build a reusable empty-datadir snapshot (gzipped) to seed fresh DBs fast.
   * The WAL GUCs are baked in so databases born from it never bloat. */
  static async buildEmptySnapshot() {
    const pg = new PGlite2();
    await pg.waitReady;
    for (const [k, v] of WAL_GUCS) {
      await pg.exec(`ALTER SYSTEM SET ${k} = ${v}`);
    }
    const file = await pg.dumpDataDir("none");
    const raw = new Uint8Array(await file.arrayBuffer());
    await pg.close();
    return gzipSync2(raw, { level: 1 });
  }
};

// packages/objectstore-fs/src/replica.ts
import { PGlite as PGlite3 } from "@electric-sql/pglite";

// packages/server/src/postgrest.ts
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
var PostgrestProcess = class {
  child = null;
  restPort;
  opts;
  constructor(opts) {
    this.restPort = opts.restPort;
    this.opts = {
      bin: opts.bin,
      wirePort: opts.wirePort,
      wireHost: opts.wireHost ?? "127.0.0.1",
      dbUser: opts.dbUser ?? "postgres",
      dbName: opts.dbName ?? "postgres",
      restPort: opts.restPort,
      schemas: opts.schemas ?? "public",
      anonRole: opts.anonRole ?? "anon",
      onLog: opts.onLog
    };
  }
  /** The PostgREST child PID, for RSS measurement (null when not running). */
  get pid() {
    return this.child?.pid ?? null;
  }
  /** Resident set size of the PostgREST process in bytes (linux /proc), or 0. */
  rssBytes() {
    const pid = this.pid;
    if (pid == null) return 0;
    try {
      const pages = Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]);
      return pages * 4096;
    } catch {
      return 0;
    }
  }
  start() {
    const o = this.opts;
    const env = {
      ...process.env,
      // sslmode=disable is REQUIRED: pglite-socket (0.2.x) does not implement the
      // SSLRequest/GSSENCRequest negotiation, so a default libpq client (which
      // probes for TLS first) sends an 8-byte SSLRequest the socket buffers as an
      // "incomplete message" and the connection deadlocks. Disabling TLS makes
      // libpq send the StartupMessage straight away. (Loopback only — no TLS loss.)
      PGRST_DB_URI: `postgres://${o.dbUser}@${o.wireHost}:${o.wirePort}/${o.dbName}?sslmode=disable`,
      PGRST_DB_SCHEMAS: o.schemas,
      PGRST_DB_ANON_ROLE: o.anonRole,
      PGRST_SERVER_HOST: "127.0.0.1",
      PGRST_SERVER_PORT: String(o.restPort),
      // PGlite is a single in-process session multiplexed by pglite-socket. A pool
      // of 1 matches that (PGlite runs one query at a time anyway) and avoids
      // cross-connection session state surprises.
      PGRST_DB_POOL: "1",
      PGRST_DB_POOL_ACQUISITION_TIMEOUT: "10",
      // Prepared statements are keyed per session, but every pooled connection
      // lands on the SAME PGlite session via the multiplexer, so libpq's auto
      // prepared statements collide ("prepared statement \"0\" already exists",
      // 42P05). Turn them off — exactly the connection-pooler-in-transaction-mode
      // guidance PostgREST itself prints for this error.
      PGRST_DB_PREPARED_STATEMENTS: "false",
      PGRST_LOG_LEVEL: "error"
    };
    this.child = spawn(o.bin, [], { env, stdio: ["ignore", "pipe", "pipe"] });
    const pipe = (buf) => {
      const s = buf.toString().trimEnd();
      if (s) o.onLog?.(s);
    };
    this.child.stdout?.on("data", pipe);
    this.child.stderr?.on("data", pipe);
    this.child.on("exit", (code, sig) => {
      o.onLog?.(`postgrest exited code=${code} signal=${sig}`);
      this.child = null;
    });
  }
  /** Poll the REST port until PostgREST answers (schema cache loaded). */
  async waitReady(timeoutMs = 3e4) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = "timeout";
    while (Date.now() < deadline) {
      if (!this.child) throw new Error("postgrest exited before becoming ready");
      try {
        const res = await fetch(`http://127.0.0.1:${this.restPort}/`, {
          signal: AbortSignal.timeout(2e3)
        });
        if (res.status < 500) return;
        lastErr = `status ${res.status}`;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`postgrest not ready after ${timeoutMs}ms: ${lastErr}`);
  }
  /** Tell PostgREST to re-introspect the schema (SIGUSR1) so tables/columns
   *  created after startup appear under /rest without a restart. */
  reloadSchema() {
    this.child?.kill("SIGUSR1");
  }
  async stop() {
    const c = this.child;
    if (!c) return;
    this.child = null;
    await new Promise((resolve) => {
      c.once("exit", () => resolve());
      c.kill("SIGTERM");
      setTimeout(() => {
        c.kill("SIGKILL");
        resolve();
      }, 2e3).unref?.();
    });
  }
};
function postgrestBootstrapSql(anonRole = "anon") {
  return `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${anonRole}') THEN
    CREATE ROLE ${anonRole} NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO ${anonRole};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${anonRole};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${anonRole};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${anonRole};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${anonRole};
`.trim();
}

// packages/server/src/server.ts
var PGLiteSocketServer;
var ZeroPGServer = class _ZeroPGServer {
  db = null;
  wire = null;
  pgrest = null;
  http = null;
  phase = "init";
  bootError = null;
  readyMs = 0;
  requestsServed = 0;
  bootTimings = { restoreMs: 0, wireMs: 0, postgrestMs: 0, totalMs: 0 };
  // Raw-wire writes (psql / libpq over pglite-socket) hit PGlite directly and so
  // NEVER pass through ZeroPG.query()/exec() — the dirty flag and the durable
  // commit it triggers are bypassed. We persist them with a timer that watches
  // Postgres' own row-modification counters and commits only when they advance,
  // so an idle instance never churns the object store. lastWireWrites is the
  // baseline (insert+update+delete tuples) at the last successful flush.
  wireFlushTimer = null;
  lastWireWrites = 0;
  opts;
  processStart = performance.now();
  constructor(opts) {
    this.opts = {
      ...opts,
      port: opts.port ?? Number(process.env.PORT ?? 8080),
      wirePort: opts.wirePort ?? Number(process.env.ZEROPG_WIRE_PORT ?? 5432),
      wireHost: opts.wireHost ?? process.env.ZEROPG_WIRE_HOST ?? "127.0.0.1",
      restPort: opts.restPort ?? Number(process.env.ZEROPG_REST_PORT ?? 3e3),
      postgrest: opts.postgrest ?? !/^(off|false|0)$/i.test(process.env.ZEROPG_POSTGREST ?? ""),
      postgrestBin: opts.postgrestBin ?? process.env.ZEROPG_POSTGREST_BIN ?? "postgrest",
      restSchemas: opts.restSchemas ?? process.env.ZEROPG_REST_SCHEMAS ?? "public",
      label: opts.label ?? process.env.APP_LABEL ?? "zeropg standalone"
    };
  }
  /** Construct, start the HTTP face immediately (so /wake + /ready answer during
   *  cold start), and kick off DB restore + wire + PostgREST in the background. */
  static async start(opts) {
    const srv = new _ZeroPGServer(opts);
    srv.listen();
    void srv.boot();
    return srv;
  }
  log(event, extra = {}) {
    console.log(JSON.stringify({ event, ...extra }));
  }
  async boot() {
    const o = this.opts;
    try {
      this.phase = "restoring";
      const t0 = performance.now();
      this.db = await ZeroPG.open({
        store: o.store,
        holder: o.holder ?? `standalone-${process.pid}`,
        durability: o.durability ?? "sleep",
        leaseTtlMs: o.leaseTtlMs ?? 6e4,
        acquireTimeoutMs: o.acquireTimeoutMs ?? 9e4,
        seedSnapshot: o.seedSnapshot
      });
      this.bootTimings.restoreMs = performance.now() - t0;
      this.log("db-open", { restoreMs: Math.round(this.bootTimings.restoreMs), boot: this.db.bootTimings });
      if (o.schemaSql) await this.db.raw.exec(o.schemaSql);
      if (o.postgrest) await this.db.raw.exec(postgrestBootstrapSql());
      this.phase = "wire";
      const tw = performance.now();
      if (!PGLiteSocketServer) {
        ;
        ({ PGLiteSocketServer } = await import("@electric-sql/pglite-socket"));
      }
      this.wire = new PGLiteSocketServer({
        db: this.db.raw,
        port: o.wirePort,
        host: o.wireHost,
        // PostgREST opens a small pool; allow several concurrent loopback conns.
        maxConnections: 10
      });
      await this.wire.start();
      this.bootTimings.wireMs = performance.now() - tw;
      this.log("wire-up", { port: o.wirePort, ms: Math.round(this.bootTimings.wireMs) });
      this.lastWireWrites = await this.wireWriteCount();
      const wireFlushMs = Number(process.env.ZEROPG_WIRE_FLUSH_MS ?? 5e3);
      if (wireFlushMs > 0) {
        this.wireFlushTimer = setInterval(() => void this.flushWireWrites("timer").catch(() => {
        }), wireFlushMs);
        this.wireFlushTimer.unref?.();
      }
      if (o.postgrest) {
        this.phase = "postgrest";
        const tp = performance.now();
        this.pgrest = new PostgrestProcess({
          bin: o.postgrestBin,
          wirePort: o.wirePort,
          restPort: o.restPort,
          schemas: o.restSchemas,
          onLog: (line) => this.log("postgrest", { line })
        });
        this.pgrest.start();
        await this.pgrest.waitReady();
        this.bootTimings.postgrestMs = performance.now() - tp;
        this.log("postgrest-up", { port: o.restPort, ms: Math.round(this.bootTimings.postgrestMs) });
      }
      this.phase = "ready";
      this.readyMs = performance.now() - this.processStart;
      this.bootTimings.totalMs = this.readyMs;
      this.log("ready", { readyMs: Math.round(this.readyMs), postgrest: o.postgrest, timings: this.bootTimings });
    } catch (e) {
      this.phase = "error";
      this.bootError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.log("boot-error", { error: this.bootError });
    }
  }
  // ---- Raw-wire durability ----
  /** Cumulative row-modification count (insert+update+delete) the running
   *  Postgres reports. Advances only on actual data changes — not on reads, and
   *  not on this very query — so it is a clean "did the wire write anything?"
   *  signal. Returns the last known value on error (treated as "no change"). */
  async wireWriteCount() {
    if (!this.db) return this.lastWireWrites;
    try {
      const r = await this.db.raw.query(
        "SELECT COALESCE(tup_inserted + tup_updated + tup_deleted, 0)::text AS w FROM pg_stat_database WHERE datname = current_database()"
      );
      return Number(r.rows[0]?.w ?? this.lastWireWrites);
    } catch {
      return this.lastWireWrites;
    }
  }
  /** Commit if raw-wire writes have landed since the last flush. The wire path
   *  bypasses ZeroPG.query(), so markDirty() arms the engine's commit explicitly. */
  async flushWireWrites(reason) {
    if (!this.db || this.phase !== "ready") return;
    const w = await this.wireWriteCount();
    if (w <= this.lastWireWrites) return;
    try {
      this.db.markDirty();
      const commit = await this.db.commit();
      this.lastWireWrites = w;
      this.log("wire-flush", { reason, writes: w, committed: !!commit });
    } catch (e) {
      this.log("wire-flush-failed", { reason, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // ---- HTTP face ----
  listen() {
    this.http = createServer((req, res) => {
      this.handle(req, res).catch(
        (e) => this.json(res, 500, { error: e instanceof Error ? e.message : String(e) })
      );
    });
    this.http.listen(this.opts.port, () => this.log("listening", { port: this.opts.port }));
  }
  json(res, status, body) {
    const s = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
    res.end(s);
  }
  readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
    });
  }
  readinessBody() {
    return {
      ready: this.phase === "ready",
      phase: this.phase,
      error: this.bootError,
      readyMs: this.phase === "ready" ? Math.round(this.readyMs) : null,
      postgrest: this.opts.postgrest,
      restBasePath: this.opts.postgrest ? "/rest" : null,
      bootTimings: this.phase === "ready" ? this.bootTimings : void 0,
      restore: this.db?.bootTimings
    };
  }
  async handle(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path === "/up" || path === "/healthz") {
      return this.json(res, this.phase === "error" ? 503 : 200, {
        ok: this.phase === "ready",
        phase: this.phase
      });
    }
    if (path === "/wake") {
      return this.json(res, 200, { woke: true, ...this.readinessBody() });
    }
    if (path === "/ready") {
      return this.json(res, this.phase === "ready" ? 200 : 503, this.readinessBody());
    }
    this.requestsServed++;
    if (path === "/metrics") return this.metrics(res);
    if (path === "/sql" && req.method === "POST") return this.sql(req, res);
    if (path === "/rest" || path.startsWith("/rest/")) return this.proxyRest(req, res, url);
    if (path === "/" || path === "") return this.landing(res);
    return this.json(res, 404, { error: "not found" });
  }
  async sql(req, res) {
    if (!this.db) return this.json(res, 503, this.readinessBody());
    const raw = (await this.readBody(req)).toString();
    try {
      const { sql } = JSON.parse(raw);
      const t0 = performance.now();
      const r = await this.db.query(sql);
      if (this.pgrest && /\b(create|alter|drop|grant|revoke|comment)\b/i.test(sql)) {
        this.pgrest.reloadSchema();
      }
      return this.json(res, 200, {
        rows: r.rows,
        ms: Math.round((performance.now() - t0) * 100) / 100,
        execMs: Math.round(r.execMs * 100) / 100,
        commit: r.commit,
        durability: this.db.durabilityMode
      });
    } catch (e) {
      const status = e instanceof FencedError || e instanceof LockedError ? 423 : 400;
      return this.json(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  }
  async proxyRest(req, res, url) {
    if (!this.opts.postgrest) return this.json(res, 404, { error: "postgrest disabled (ZEROPG_POSTGREST=off)" });
    if (this.phase !== "ready" || !this.pgrest) return this.json(res, 503, this.readinessBody());
    const rest = url.pathname.slice("/rest".length) || "/";
    const target = `http://127.0.0.1:${this.opts.restPort}${rest}${url.search}`;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      const lk = k.toLowerCase();
      if (lk === "host" || lk === "connection" || lk === "content-length") continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    const method = req.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? void 0 : await this.readBody(req);
    try {
      const upstream = await fetch(target, {
        method,
        headers,
        body: body && body.length ? body : void 0,
        signal: AbortSignal.timeout(3e4)
      });
      const outHeaders = {};
      upstream.headers.forEach((value, key) => {
        if (key.toLowerCase() === "content-length") return;
        outHeaders[key] = value;
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, outHeaders);
      res.end(buf);
    } catch (e) {
      this.json(res, 502, { error: `rest proxy: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  async metrics(res) {
    const mem = process.memoryUsage();
    const pgrestRss = this.pgrest?.rssBytes() ?? 0;
    let dbBytes = "0";
    if (this.db) {
      try {
        const sz = await this.db.raw.query(
          "SELECT pg_database_size(current_database())::text b"
        );
        dbBytes = sz.rows[0]?.b ?? "0";
      } catch {
      }
    }
    return this.json(res, 200, {
      label: this.opts.label,
      phase: this.phase,
      readyMs: this.phase === "ready" ? Math.round(this.readyMs) : null,
      requestsServed: this.requestsServed,
      postgrest: this.opts.postgrest,
      durability: this.db?.durabilityMode ?? null,
      pendingFlush: this.db?.pendingFlush ?? false,
      fencingToken: this.db?.fencingToken ?? null,
      dbBytes,
      // RAM split: the Node writer process vs the PostgREST Haskell process. The
      // standalone experiment compares serverRssMB with PostgREST on vs off.
      serverRssMB: Math.round(mem.rss / 1e6),
      postgrestRssMB: Math.round(pgrestRss / 1e6),
      totalRssMB: Math.round((mem.rss + pgrestRss) / 1e6),
      bootTimings: this.phase === "ready" ? this.bootTimings : null
    });
  }
  landing(res) {
    const o = this.opts;
    const restLine = o.postgrest ? `REST (PostgREST): GET ${"<this-url>"}/rest/<table>` : `REST disabled (ZEROPG_POSTGREST=off)`;
    const body = `${o.label} \u2014 zeropg standalone dedicated Postgres

A real Postgres (PGlite) whose durable home is an object-storage bucket, in one
scale-to-zero container. A remote app connects over HTTP.

Faces:
  Wake:  GET  /wake            (call first; the request wakes the instance)
  Ready: GET  /ready           (poll until {"ready":true})
  SQL:   POST /sql  {"sql":"\u2026"}
  ${restLine}
  Metrics: GET /metrics

Wire protocol (real Postgres, libpq) is bound to loopback for Fly.io / raw TCP
later; this HTTP-only platform exposes the faces above.
`;
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(body);
  }
  /** Flush + release lease + stop child/socket. Called on SIGTERM. */
  async shutdown() {
    if (this.wireFlushTimer) clearInterval(this.wireFlushTimer);
    try {
      await this.pgrest?.stop();
    } catch {
    }
    try {
      await this.wire?.stop();
    } catch {
    }
    try {
      await this.flushWireWrites("shutdown");
    } catch {
    }
    try {
      if (this.db) await this.db.close();
    } catch (e) {
      this.log("shutdown-flush-failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  /** Wire SIGTERM/SIGINT to a graceful flush + lease release, then exit. */
  installSignalHandlers() {
    const onSig = (signal) => {
      this.log("shutdown", { signal, pendingFlush: this.db?.pendingFlush ?? false });
      void this.shutdown().finally(() => process.exit(0));
    };
    process.on("SIGTERM", () => onSig("SIGTERM"));
    process.on("SIGINT", () => onSig("SIGINT"));
  }
};

// experiments/standalone-service/server.ts
var __dirname = dirname(fileURLToPath(import.meta.url));
var USE_COS = !!(process.env.COS_HMAC_ACCESS_KEY_ID && process.env.COS_HMAC_SECRET_ACCESS_KEY);
var USE_S3 = !USE_COS && !!(process.env.AWS_ENDPOINT_URL_S3 || process.env.R2_ENDPOINT);
var DB_PREFIX = process.env.ZEROPG_PREFIX ?? "demo/standalone";
function selectStore() {
  if (USE_COS) {
    const endpoint = process.env.COS_ENDPOINT_DIRECT || process.env.COS_ENDPOINT;
    if (!endpoint) throw new Error("COS_* creds set but no COS_ENDPOINT/COS_ENDPOINT_DIRECT");
    return new R2BlobStore({
      endpoint,
      accessKeyId: process.env.COS_HMAC_ACCESS_KEY_ID,
      secretAccessKey: process.env.COS_HMAC_SECRET_ACCESS_KEY,
      bucket: process.env.COS_BUCKET ?? "zeropg-cos",
      prefix: DB_PREFIX,
      region: process.env.IBM_COS_REGION ?? "eu-de"
    });
  }
  if (USE_S3) {
    const endpoint = process.env.AWS_ENDPOINT_URL_S3 ?? process.env.R2_ENDPOINT;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.TIGRIS_BUCKET ?? process.env.AWS_BUCKET ?? process.env.S3_BUCKET ?? process.env.R2_BUCKET;
    if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error("S3 endpoint set but missing creds/bucket (AWS_*/TIGRIS_BUCKET)");
    }
    return new R2BlobStore({
      endpoint,
      accessKeyId,
      secretAccessKey,
      bucket,
      prefix: DB_PREFIX,
      region: process.env.AWS_REGION ?? "auto"
    });
  }
  return new GcsBlobStore({
    bucket: process.env.ZEROPG_BUCKET ?? "zeropg-experiments-euw1",
    prefix: DB_PREFIX
  });
}
var DURABILITY = ["strict", "interval", "sleep"].includes(process.env.ZEROPG_DURABILITY ?? "") ? process.env.ZEROPG_DURABILITY : "sleep";
function loadSeed() {
  const p = join5(__dirname, "seed.tar.gz");
  return existsSync(p) ? new Uint8Array(readFileSync2(p)) : void 0;
}
var server = await ZeroPGServer.start({
  store: selectStore(),
  holder: `${process.env.K_REVISION ?? "local"}-${process.pid}`,
  durability: DURABILITY,
  seedSnapshot: loadSeed(),
  // A demo table so the auto-REST surface has something to show immediately.
  schemaSql: `CREATE TABLE IF NOT EXISTS notes (
    id serial primary key,
    body text not null,
    created_at timestamptz default now()
  );`,
  label: process.env.APP_LABEL ?? "zeropg standalone (dedicated Postgres)"
});
server.installSignalHandlers();
