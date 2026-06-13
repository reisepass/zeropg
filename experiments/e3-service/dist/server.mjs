import { createRequire } from 'module'; const require = createRequire(import.meta.url);

// server.ts
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as join4 } from "node:path";

// ../../packages/blobstore/src/types.ts
var PreconditionFailedError = class extends Error {
  key;
  constructor(key, detail) {
    super(`precondition failed for key "${key}"${detail ? `: ${detail}` : ""}`);
    this.name = "PreconditionFailedError";
    this.key = key;
  }
};

// ../../packages/blobstore/src/gcs.ts
import { Readable } from "node:stream";

// ../../packages/blobstore/src/token.ts
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

// ../../packages/blobstore/src/gcs.ts
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

// ../../packages/blobstore/src/r2.ts
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
  return s.replace(/^"|"$/g, "");
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

// ../../packages/objectstore-fs/src/zeropg.ts
import { PGlite } from "@electric-sql/pglite";

// ../../packages/lease/src/index.ts
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

// ../../packages/objectstore-fs/src/manifest.ts
var MANIFEST_KEY = "manifest.json";
function encodeManifest(m) {
  return new TextEncoder().encode(JSON.stringify(m, null, 2));
}
function decodeManifest(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ../../packages/objectstore-fs/src/tar.ts
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

// ../../packages/objectstore-fs/src/restore.ts
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

// ../../packages/objectstore-fs/src/zeropg.ts
import { createGunzip as createGunzip2, createGzip, gzipSync, crc32 as crc322 } from "node:zlib";
import { Readable as Readable3 } from "node:stream";
import * as nodeStream2 from "node:stream";
import { mkdir as mkdir2, rm, open as open2 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";
var compose4 = nodeStream2.compose;
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
    this.scratchBase = opts.scratchDir ?? join3(tmpdir(), "zeropg");
    this.fullPageWrites = opts.fullPageWrites ?? !/^(off|false|0)$/i.test(
      process.env.ZEROPG_FULL_PAGE_WRITES ?? ""
    );
    this.walCompression = opts.walCompression ?? process.env.ZEROPG_WAL_COMPRESSION;
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
    this.dataDir = join3(this.scratchBase, `data-${process.pid}-${randomGeneration()}`);
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
      const fresh = await this.store.get(MANIFEST_KEY) ?? existing;
      const m = decodeManifest(fresh.bytes);
      if (m.movedTo) {
        throw new Error(
          `this database was migrated out to ${m.movedTo}; refusing to boot stale data`
        );
      }
      await this.adoptManifest(m, fresh.etag);
      if (this.lease?.held && this.lease.tookOver) {
        await this.fenceStamp();
      }
    } else {
      this.bootTimings.fresh = true;
      this.generation = randomGeneration();
      const tPg = performance.now();
      if (opts.seedSnapshot) {
        await extractTarStream(
          compose4(Readable3.from([Buffer.from(opts.seedSnapshot)]), createGunzip2()),
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
    this.pg = await PGlite.create({ dataDir: this.dataDir });
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
      const path = join3(this.dataDir, "pg_wal", walFileName(this.walTli, pos, this.walSegBytes));
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
      const ratio = gzipSync(sample, { level: 1 }).length / sample.length;
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
        this.pg = await PGlite.create({ dataDir: this.dataDir });
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
    const tar = Readable3.from(createTarStream(this.dataDir));
    const body = codec === "gzip" ? compose4(tar, createGzip({ level: 1 })) : tar;
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

// ../../packages/objectstore-fs/src/replica.ts
import { PGlite as PGlite2 } from "@electric-sql/pglite";

// bench.ts
var rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
var CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function astr(lo, hi) {
  const n = rnd(lo, hi);
  let s = "";
  for (let i = 0; i < n; i++) s += CHARS[rnd(0, CHARS.length - 1)];
  return s;
}
function nstr(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += rnd(0, 9);
  return s;
}
function nurand(A, x, y, C) {
  return ((rnd(0, A) | rnd(x, y)) + C) % (y - x + 1) + x;
}
var SYL = ["BAR", "OUGHT", "ABLE", "PRI", "PRES", "ESE", "ANTI", "CALLY", "ATION", "EING"];
function lastName(num) {
  return SYL[Math.floor(num / 100) % 10] + SYL[Math.floor(num / 10) % 10] + SYL[num % 10];
}
var fmt = (n) => n.toLocaleString("en-US");
var mb = (bytes) => (bytes / 1e6).toFixed(1);
function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length));
  return sorted[i];
}
var round1 = (n) => Math.round(n * 10) / 10;
async function runBenchmark(db2, opts, onProgress) {
  const durationMs = opts.durationMs ?? 25e3;
  const progressEveryMs = opts.progressEveryMs ?? 1e3;
  const maxTx = opts.maxTransactions ?? Infinity;
  const line = (s = "") => onProgress(s);
  const dbSize = async () => {
    const r = await db2.raw.query("SELECT pg_database_size(current_database())::text b");
    return Number(r.rows[0]?.b ?? "0");
  };
  const count = async (table) => {
    const r = await db2.raw.query(`SELECT count(*)::text n FROM ${table}`);
    return Number(r.rows[0]?.n ?? "0");
  };
  const baseline = await dbSize();
  const staticBudget = Math.min(4e7, Math.max(15e5, baseline * 0.15));
  const W = baseline >= 2e8 ? 2 : 1;
  const DISTRICTS = 10;
  const NUM_ITEMS = Math.min(5e3, Math.max(200, Math.round(staticBudget * 0.5 / (W * 450))));
  const CUST_PER_DIST = Math.min(1500, Math.max(50, Math.round(staticBudget * 0.5 / (W * DISTRICTS * 700))));
  const INIT_ORDERS = 30;
  line(`\u{1F3CE}  TPC-C OLTP benchmark \u2014 running server-side against the single PGlite writer`);
  line(`   (PGlite is in THIS Cloud Run container, one connection \u2014 numbers are`);
  line(`    honest single-writer: "tpmC, single connection", not a cluster.)`);
  line();
  line(`   baseline DB size: ${mb(baseline)} MB  \u2192  keeping total under ~1.5x (hard stop ~1.85x)`);
  line(`   scale factor: ${W} warehouse${W > 1 ? "s" : ""}, ${NUM_ITEMS} items, ${CUST_PER_DIST} customers/district`);
  line(`   (standard TPC-C is 100k items + 30k customers/warehouse \u2248 100MB/wh;`);
  line(`    scaled DOWN to fit the byte budget \u2014 that's the demo, stated honestly.)`);
  line();
  line(`\u2192 building TPC-C schema (tpcc_* tables, isolated from notes/filler)\u2026`);
  await dropSchema(db2);
  await db2.exec(SCHEMA_SQL);
  const tLoad = performance.now();
  await loadData(db2, { W, DISTRICTS, NUM_ITEMS, CUST_PER_DIST, INIT_ORDERS }, line);
  await db2.raw.exec("VACUUM ANALYZE");
  const afterLoad = await dbSize();
  line(`  \u2713 loaded in ${Math.round(performance.now() - tLoad)}ms \u2014 DB now ${mb(afterLoad)} MB (${(afterLoad / baseline).toFixed(2)}x baseline)`);
  line();
  const churnBudget = Math.min(baseline * 0.5, Math.max(baseline * 0.05, baseline * 1.5 - afterLoad));
  const BYTES_PER_ORDER_BUNDLE = 1600;
  const BYTES_PER_HISTORY = 160;
  const maxOrders = Math.max(W * DISTRICTS * INIT_ORDERS, Math.floor(churnBudget * 0.75 / BYTES_PER_ORDER_BUNDLE));
  const keepPerDist = Math.max(INIT_ORDERS, Math.floor(maxOrders / (W * DISTRICTS)));
  const historyKeep = Math.max(1e3, Math.floor(churnBudget * 0.25 / BYTES_PER_HISTORY));
  const HARD_STOP = baseline * 1.85;
  const RESUME = baseline * 1.5;
  line(`\u2192 running OLTP mix for ${Math.round(durationMs / 1e3)}s: New-Order 45% \xB7 Payment 43% \xB7 Order-Status 4% \xB7 Delivery 4% \xB7 Stock-Level 4%`);
  line(`   size cap: keep \u2264 ${fmt(keepPerDist)} orders/district + \u2264 ${fmt(historyKeep)} history rows; VACUUM to reuse space; pause inserts at ${mb(HARD_STOP)} MB`);
  line();
  const counts = { newOrder: 0, payment: 0, orderStatus: 0, delivery: 0, stockLevel: 0 };
  let rolledBack = 0;
  const lat = [];
  let trimmedOrders = 0;
  let trimmedHistory = 0;
  let insertsPaused = false;
  let curSize = afterLoad;
  const ctx = { W, DISTRICTS, NUM_ITEMS, CUST_PER_DIST, INIT_ORDERS };
  const start = performance.now();
  const deadline = start + durationMs;
  let lastTick = start;
  let lastTickTx = 0;
  let total = 0;
  const emitProgress = async (final = false) => {
    const elapsed2 = (performance.now() - start) / 1e3;
    curSize = await dbSize();
    const sorted2 = [...lat].sort((a, b) => a - b);
    const tpmC = Math.round(counts.newOrder / Math.max(elapsed2, 1e-3) * 60);
    const tps = Math.round(total / Math.max(elapsed2, 1e-3));
    const windowTps = Math.round((total - lastTickTx) / Math.max((performance.now() - lastTick) / 1e3, 1e-3));
    const tag = final ? "done" : `t=${Math.round(elapsed2)}s`;
    line(`[${tag}] ${fmt(total)} txn \xB7 ${fmt(tps)} tps (now ${fmt(windowTps)}) \xB7 tpmC ${fmt(tpmC)}  (New-Order/min, single conn)`);
    line(`        mix  NO ${fmt(counts.newOrder)}  PAY ${fmt(counts.payment)}  OS ${fmt(counts.orderStatus)}  DLV ${fmt(counts.delivery)}  SL ${fmt(counts.stockLevel)}${rolledBack ? `  (NO rollbacks ${fmt(rolledBack)})` : ""}`);
    line(`        lat  p50 ${round1(pct(sorted2, 50))}  p95 ${round1(pct(sorted2, 95))}  p99 ${round1(pct(sorted2, 99))} ms`);
    line(`        size ${mb(curSize)} MB (${(curSize / baseline).toFixed(2)}x baseline)  \xB7  trimmed ${fmt(trimmedOrders)} orders, ${fmt(trimmedHistory)} history${insertsPaused ? "  \u23F8 inserts paused (at cap)" : ""}`);
    lastTick = performance.now();
    lastTickTx = total;
  };
  let ticks = 0;
  const janitor = async () => {
    curSize = await dbSize();
    if (curSize >= HARD_STOP) insertsPaused = true;
    else if (curSize <= RESUME) insertsPaused = false;
    const ok = insertsPaused ? Math.floor(keepPerDist / 2) : keepPerDist;
    const hk = insertsPaused ? Math.floor(historyKeep / 2) : historyKeep;
    if (await count("tpcc_orders") > W * DISTRICTS * ok) {
      await db2.query(
        `DELETE FROM tpcc_order_line ol WHERE ol.ol_o_id <= (SELECT MAX(o.o_id) - $1 FROM tpcc_orders o WHERE o.o_w_id=ol.ol_w_id AND o.o_d_id=ol.ol_d_id)`,
        [ok]
      );
      await db2.query(
        `DELETE FROM tpcc_new_order n WHERE n.no_o_id <= (SELECT MAX(o.o_id) - $1 FROM tpcc_orders o WHERE o.o_w_id=n.no_w_id AND o.o_d_id=n.no_d_id)`,
        [ok]
      );
      const o = await db2.query(
        `DELETE FROM tpcc_orders o WHERE o.o_id <= (SELECT MAX(o2.o_id) - $1 FROM tpcc_orders o2 WHERE o2.o_w_id=o.o_w_id AND o2.o_d_id=o.o_d_id)`,
        [ok]
      );
      trimmedOrders += o.affectedRows ?? 0;
    }
    if (await count("tpcc_history") > hk) {
      const h = await db2.query(`DELETE FROM tpcc_history WHERE h_id <= (SELECT MAX(h_id) - $1 FROM tpcc_history)`, [hk]);
      trimmedHistory += h.affectedRows ?? 0;
    }
    if (++ticks % 3 === 0) await db2.raw.exec("VACUUM tpcc_orders, tpcc_order_line, tpcc_new_order, tpcc_history");
  };
  while (performance.now() < deadline && total < maxTx) {
    const roll = rnd(1, 100);
    const t0 = performance.now();
    try {
      if (!insertsPaused && roll <= 45) {
        const rb = await newOrder(db2, ctx);
        counts.newOrder++;
        if (rb) rolledBack++;
      } else if (!insertsPaused && roll <= 88) {
        await payment(db2, ctx);
        counts.payment++;
      } else if (roll <= 92) {
        await orderStatus(db2, ctx);
        counts.orderStatus++;
      } else if (roll <= 96) {
        await delivery(db2, ctx);
        counts.delivery++;
      } else {
        await stockLevel(db2, ctx);
        counts.stockLevel++;
      }
    } catch (e) {
      void e;
    }
    lat.push(performance.now() - t0);
    total++;
    if (performance.now() - lastTick >= progressEveryMs) {
      await janitor();
      await emitProgress();
    }
  }
  await janitor();
  await emitProgress(true);
  const elapsed = (performance.now() - start) / 1e3;
  const sorted = [...lat].sort((a, b) => a - b);
  line();
  line(`\u2705 benchmark complete \u2014 ${fmt(total)} transactions in ${round1(elapsed)}s`);
  line(`   tpmC ${fmt(Math.round(counts.newOrder / elapsed * 60))}  (New-Order/min, single PGlite connection)`);
  line(`   overall throughput ${fmt(Math.round(total / elapsed))} tps`);
  line(`   latency p50 ${round1(pct(sorted, 50))}ms \xB7 p95 ${round1(pct(sorted, 95))}ms \xB7 p99 ${round1(pct(sorted, 99))}ms`);
  line(`   peak/final DB size ${mb(curSize)} MB = ${(curSize / baseline).toFixed(2)}x baseline \u2014 cap held \u2713`);
  line(`   trimmed during run: ${fmt(trimmedOrders)} orders + their lines, ${fmt(trimmedHistory)} history rows`);
  line();
  line(`\u2192 cleaning up: dropping tpcc_* tables (durable demo footprint unchanged)\u2026`);
  await dropSchema(db2);
  await db2.raw.exec("VACUUM");
  const finalSize = await dbSize();
  line(`  \u2713 done \u2014 DB back to ${mb(finalSize)} MB (${(finalSize / baseline).toFixed(2)}x baseline)`);
}
var SCHEMA_SQL = `
CREATE TABLE tpcc_warehouse (
  w_id int PRIMARY KEY, w_name varchar(10), w_street_1 varchar(20), w_street_2 varchar(20),
  w_city varchar(20), w_state char(2), w_zip char(9), w_tax numeric(4,4), w_ytd numeric(12,2));
CREATE TABLE tpcc_district (
  d_w_id int, d_id int, d_name varchar(10), d_street_1 varchar(20), d_street_2 varchar(20),
  d_city varchar(20), d_state char(2), d_zip char(9), d_tax numeric(4,4), d_ytd numeric(12,2),
  d_next_o_id int, PRIMARY KEY (d_w_id, d_id));
CREATE TABLE tpcc_customer (
  c_w_id int, c_d_id int, c_id int, c_first varchar(16), c_middle char(2), c_last varchar(16),
  c_street_1 varchar(20), c_street_2 varchar(20), c_city varchar(20), c_state char(2), c_zip char(9),
  c_phone char(16), c_since timestamptz, c_credit char(2), c_credit_lim numeric(12,2),
  c_discount numeric(4,4), c_balance numeric(12,2), c_ytd_payment numeric(12,2),
  c_payment_cnt int, c_delivery_cnt int, c_data varchar(500), PRIMARY KEY (c_w_id, c_d_id, c_id));
CREATE INDEX tpcc_customer_last ON tpcc_customer (c_w_id, c_d_id, c_last, c_first);
-- h_id is a surrogate (not in the spec) used only to trim the oldest history rows.
CREATE TABLE tpcc_history (
  h_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  h_c_id int, h_c_d_id int, h_c_w_id int, h_d_id int, h_w_id int,
  h_date timestamptz, h_amount numeric(6,2), h_data varchar(24));
CREATE TABLE tpcc_new_order (
  no_o_id int, no_d_id int, no_w_id int, PRIMARY KEY (no_w_id, no_d_id, no_o_id));
CREATE TABLE tpcc_orders (
  o_id int, o_d_id int, o_w_id int, o_c_id int, o_entry_d timestamptz,
  o_carrier_id int, o_ol_cnt int, o_all_local int, PRIMARY KEY (o_w_id, o_d_id, o_id));
CREATE INDEX tpcc_orders_cust ON tpcc_orders (o_w_id, o_d_id, o_c_id, o_id);
CREATE TABLE tpcc_order_line (
  ol_o_id int, ol_d_id int, ol_w_id int, ol_number int, ol_i_id int, ol_supply_w_id int,
  ol_delivery_d timestamptz, ol_amount numeric(6,2), ol_quantity int, ol_dist_info char(24),
  PRIMARY KEY (ol_w_id, ol_d_id, ol_o_id, ol_number));
CREATE TABLE tpcc_item (
  i_id int PRIMARY KEY, i_im_id int, i_name varchar(24), i_price numeric(5,2), i_data varchar(50));
CREATE TABLE tpcc_stock (
  s_w_id int, s_i_id int, s_quantity int,
  s_dist_01 char(24), s_dist_02 char(24), s_dist_03 char(24), s_dist_04 char(24), s_dist_05 char(24),
  s_dist_06 char(24), s_dist_07 char(24), s_dist_08 char(24), s_dist_09 char(24), s_dist_10 char(24),
  s_ytd int, s_order_cnt int, s_remote_cnt int, s_data varchar(50), PRIMARY KEY (s_w_id, s_i_id));
`;
async function dropSchema(db2) {
  await db2.exec(
    `DROP TABLE IF EXISTS tpcc_order_line, tpcc_new_order, tpcc_orders, tpcc_history,
       tpcc_customer, tpcc_district, tpcc_stock, tpcc_item, tpcc_warehouse CASCADE;`
  );
}
async function bulkInsert(db2, table, cols, rows, perBatch = 400) {
  const nc = cols.length;
  for (let i = 0; i < rows.length; i += perBatch) {
    const batch = rows.slice(i, i + perBatch);
    const values = batch.map((_, r) => `(${cols.map((__, c) => `$${r * nc + c + 1}`).join(",")})`).join(",");
    const params = batch.flat();
    await db2.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${values}`, params);
  }
}
async function loadData(db2, p, line) {
  const items = [];
  for (let i = 1; i <= p.NUM_ITEMS; i++) {
    const data = rnd(1, 100) <= 10 ? astr(14, 24).slice(0, 12) + "ORIGINAL" + astr(4, 10) : astr(26, 50);
    items.push([i, rnd(1, 1e4), astr(14, 24), (rnd(100, 1e4) / 100).toFixed(2), data.slice(0, 50)]);
  }
  await bulkInsert(db2, "tpcc_item", ["i_id", "i_im_id", "i_name", "i_price", "i_data"], items);
  line(`  \xB7 ${fmt(p.NUM_ITEMS)} items`);
  for (let w = 1; w <= p.W; w++) {
    await db2.query(
      `INSERT INTO tpcc_warehouse (w_id,w_name,w_street_1,w_street_2,w_city,w_state,w_zip,w_tax,w_ytd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,300000)`,
      [w, astr(6, 10), astr(10, 20), astr(10, 20), astr(10, 20), astr(2, 2), nstr(4) + "11111", (rnd(0, 2e3) / 1e4).toFixed(4)]
    );
    const stock = [];
    for (let i = 1; i <= p.NUM_ITEMS; i++) {
      const data = rnd(1, 100) <= 10 ? astr(14, 24).slice(0, 12) + "ORIGINAL" + astr(4, 10) : astr(26, 50);
      stock.push([
        w,
        i,
        rnd(10, 100),
        astr(24, 24),
        astr(24, 24),
        astr(24, 24),
        astr(24, 24),
        astr(24, 24),
        astr(24, 24),
        astr(24, 24),
        astr(24, 24),
        astr(24, 24),
        astr(24, 24),
        0,
        0,
        0,
        data.slice(0, 50)
      ]);
    }
    await bulkInsert(
      db2,
      "tpcc_stock",
      ["s_w_id", "s_i_id", "s_quantity", "s_dist_01", "s_dist_02", "s_dist_03", "s_dist_04", "s_dist_05", "s_dist_06", "s_dist_07", "s_dist_08", "s_dist_09", "s_dist_10", "s_ytd", "s_order_cnt", "s_remote_cnt", "s_data"],
      stock
    );
    for (let d = 1; d <= p.DISTRICTS; d++) {
      await db2.query(
        `INSERT INTO tpcc_district (d_w_id,d_id,d_name,d_street_1,d_street_2,d_city,d_state,d_zip,d_tax,d_ytd,d_next_o_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,30000,$10)`,
        [w, d, astr(6, 10), astr(10, 20), astr(10, 20), astr(10, 20), astr(2, 2), nstr(4) + "11111", (rnd(0, 2e3) / 1e4).toFixed(4), p.INIT_ORDERS + 1]
      );
      const custs = [];
      for (let c = 1; c <= p.CUST_PER_DIST; c++) {
        const ln = c <= 1e3 ? lastName(c - 1) : lastName(nurand(255, 0, 999, 0));
        const bad = rnd(1, 100) <= 10;
        custs.push([
          w,
          d,
          c,
          astr(8, 16),
          "OE",
          ln,
          astr(10, 20),
          astr(10, 20),
          astr(10, 20),
          astr(2, 2),
          nstr(4) + "11111",
          nstr(16),
          (/* @__PURE__ */ new Date()).toISOString(),
          bad ? "BC" : "GC",
          5e4,
          (rnd(0, 5e3) / 1e4).toFixed(4),
          -10,
          10,
          1,
          0,
          astr(50, 200)
        ]);
      }
      await bulkInsert(
        db2,
        "tpcc_customer",
        ["c_w_id", "c_d_id", "c_id", "c_first", "c_middle", "c_last", "c_street_1", "c_street_2", "c_city", "c_state", "c_zip", "c_phone", "c_since", "c_credit", "c_credit_lim", "c_discount", "c_balance", "c_ytd_payment", "c_payment_cnt", "c_delivery_cnt", "c_data"],
        custs
      );
      const hist = [];
      for (let c = 1; c <= p.CUST_PER_DIST; c++) {
        hist.push([c, d, w, d, w, (/* @__PURE__ */ new Date()).toISOString(), 10, astr(12, 24)]);
      }
      await bulkInsert(db2, "tpcc_history", ["h_c_id", "h_c_d_id", "h_c_w_id", "h_d_id", "h_w_id", "h_date", "h_amount", "h_data"], hist);
      const orders = [];
      const olines = [];
      const neworders = [];
      for (let o = 1; o <= p.INIT_ORDERS; o++) {
        const olCnt = rnd(5, 15);
        const delivered = o <= Math.floor(p.INIT_ORDERS * 0.7);
        orders.push([o, d, w, rnd(1, p.CUST_PER_DIST), (/* @__PURE__ */ new Date()).toISOString(), delivered ? rnd(1, 10) : null, olCnt, 1]);
        if (!delivered) neworders.push([o, d, w]);
        for (let ol = 1; ol <= olCnt; ol++) {
          olines.push([o, d, w, ol, rnd(1, p.NUM_ITEMS), w, delivered ? (/* @__PURE__ */ new Date()).toISOString() : null, delivered ? (rnd(0, 999999) / 100).toFixed(2) : "0.00", 5, astr(24, 24)]);
        }
      }
      await bulkInsert(db2, "tpcc_orders", ["o_id", "o_d_id", "o_w_id", "o_c_id", "o_entry_d", "o_carrier_id", "o_ol_cnt", "o_all_local"], orders);
      await bulkInsert(db2, "tpcc_order_line", ["ol_o_id", "ol_d_id", "ol_w_id", "ol_number", "ol_i_id", "ol_supply_w_id", "ol_delivery_d", "ol_amount", "ol_quantity", "ol_dist_info"], olines);
      if (neworders.length) await bulkInsert(db2, "tpcc_new_order", ["no_o_id", "no_d_id", "no_w_id"], neworders);
    }
    line(`  \xB7 warehouse ${w}: ${fmt(p.NUM_ITEMS)} stock, ${fmt(p.DISTRICTS * p.CUST_PER_DIST)} customers, ${fmt(p.DISTRICTS * p.INIT_ORDERS)} orders`);
  }
}
var dColName = (d) => `s_dist_${String(d).padStart(2, "0")}`;
async function newOrder(db2, p) {
  const w = rnd(1, p.W);
  const d = rnd(1, p.DISTRICTS);
  const c = nurand(1023, 1, p.CUST_PER_DIST, 0);
  const olCnt = rnd(5, 15);
  const rollback = rnd(1, 100) === 1;
  const lineItems = Array.from({ length: olCnt }, (_, k) => ({
    iId: rollback && k === olCnt - 1 ? p.NUM_ITEMS + 1e6 : nurand(8191, 1, p.NUM_ITEMS, 0),
    supplyW: w,
    qty: rnd(1, 10)
  }));
  try {
    await db2.transaction(async (tx) => {
      await tx.query(`SELECT w_tax FROM tpcc_warehouse WHERE w_id=$1`, [w]);
      const dr = await tx.query(
        `SELECT d_tax, d_next_o_id FROM tpcc_district WHERE d_w_id=$1 AND d_id=$2`,
        [w, d]
      );
      const oId = dr.rows[0].d_next_o_id;
      await tx.query(`UPDATE tpcc_district SET d_next_o_id=d_next_o_id+1 WHERE d_w_id=$1 AND d_id=$2`, [w, d]);
      await tx.query(`SELECT c_discount, c_last, c_credit FROM tpcc_customer WHERE c_w_id=$1 AND c_d_id=$2 AND c_id=$3`, [w, d, c]);
      const allLocal = lineItems.every((li) => li.supplyW === w) ? 1 : 0;
      await tx.query(
        `INSERT INTO tpcc_orders (o_id,o_d_id,o_w_id,o_c_id,o_entry_d,o_carrier_id,o_ol_cnt,o_all_local)
         VALUES ($1,$2,$3,$4,now(),NULL,$5,$6)`,
        [oId, d, w, c, olCnt, allLocal]
      );
      await tx.query(`INSERT INTO tpcc_new_order (no_o_id,no_d_id,no_w_id) VALUES ($1,$2,$3)`, [oId, d, w]);
      for (let n = 0; n < lineItems.length; n++) {
        const li = lineItems[n];
        const ir = await tx.query(`SELECT i_price, i_name, i_data FROM tpcc_item WHERE i_id=$1`, [li.iId]);
        if (!ir.rows.length) throw new Error("rollback: invalid item");
        const price = Number(ir.rows[0].i_price);
        const sr = await tx.query(
          `SELECT s_quantity, ${dColName(d)} AS dist, s_data FROM tpcc_stock WHERE s_w_id=$1 AND s_i_id=$2`,
          [li.supplyW, li.iId]
        );
        const sQty = Number(sr.rows[0].s_quantity);
        const newQty = sQty - li.qty >= 10 ? sQty - li.qty : sQty - li.qty + 91;
        await tx.query(
          `UPDATE tpcc_stock SET s_quantity=$1, s_ytd=s_ytd+$2, s_order_cnt=s_order_cnt+1, s_remote_cnt=s_remote_cnt+$3
           WHERE s_w_id=$4 AND s_i_id=$5`,
          [newQty, li.qty, li.supplyW === w ? 0 : 1, li.supplyW, li.iId]
        );
        await tx.query(
          `INSERT INTO tpcc_order_line (ol_o_id,ol_d_id,ol_w_id,ol_number,ol_i_id,ol_supply_w_id,ol_delivery_d,ol_amount,ol_quantity,ol_dist_info)
           VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9)`,
          [oId, d, w, n + 1, li.iId, li.supplyW, (price * li.qty).toFixed(2), li.qty, String(sr.rows[0].dist).slice(0, 24)]
        );
      }
    });
    return false;
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("rollback")) return true;
    throw e;
  }
}
async function payment(db2, p) {
  const w = rnd(1, p.W);
  const d = rnd(1, p.DISTRICTS);
  const amount = rnd(100, 5e5) / 100;
  const byName = rnd(1, 100) <= 60;
  await db2.transaction(async (tx) => {
    await tx.query(`UPDATE tpcc_warehouse SET w_ytd=w_ytd+$1 WHERE w_id=$2`, [amount, w]);
    await tx.query(`UPDATE tpcc_district SET d_ytd=d_ytd+$1 WHERE d_w_id=$2 AND d_id=$3`, [amount, w, d]);
    let cId;
    if (byName) {
      const ln = lastName(nurand(255, 0, 999, 0));
      const rows = await tx.query(
        `SELECT c_id FROM tpcc_customer WHERE c_w_id=$1 AND c_d_id=$2 AND c_last=$3 ORDER BY c_first`,
        [w, d, ln]
      );
      if (!rows.rows.length) {
        cId = nurand(1023, 1, p.CUST_PER_DIST, 0);
      } else {
        cId = rows.rows[Math.floor((rows.rows.length - 1) / 2)].c_id;
      }
    } else {
      cId = nurand(1023, 1, p.CUST_PER_DIST, 0);
    }
    const cr = await tx.query(
      `UPDATE tpcc_customer SET c_balance=c_balance-$1, c_ytd_payment=c_ytd_payment+$1, c_payment_cnt=c_payment_cnt+1
       WHERE c_w_id=$2 AND c_d_id=$3 AND c_id=$4 RETURNING c_credit`,
      [amount, w, d, cId]
    );
    if (cr.rows[0]?.c_credit === "BC") {
      await tx.query(
        `UPDATE tpcc_customer SET c_data = substr($1 || c_data, 1, 500) WHERE c_w_id=$2 AND c_d_id=$3 AND c_id=$4`,
        [`${cId} ${d} ${w} ${amount} `, w, d, cId]
      );
    }
    await tx.query(
      `INSERT INTO tpcc_history (h_c_id,h_c_d_id,h_c_w_id,h_d_id,h_w_id,h_date,h_amount,h_data)
       VALUES ($1,$2,$3,$4,$5,now(),$6,$7)`,
      [cId, d, w, d, w, amount, astr(12, 24)]
    );
  });
}
async function orderStatus(db2, p) {
  const w = rnd(1, p.W);
  const d = rnd(1, p.DISTRICTS);
  const c = nurand(1023, 1, p.CUST_PER_DIST, 0);
  await db2.raw.query(`SELECT c_balance, c_first, c_last FROM tpcc_customer WHERE c_w_id=$1 AND c_d_id=$2 AND c_id=$3`, [w, d, c]);
  const o = await db2.raw.query(
    `SELECT o_id FROM tpcc_orders WHERE o_w_id=$1 AND o_d_id=$2 AND o_c_id=$3 ORDER BY o_id DESC LIMIT 1`,
    [w, d, c]
  );
  if (o.rows.length) {
    await db2.raw.query(
      `SELECT ol_i_id, ol_supply_w_id, ol_quantity, ol_amount, ol_delivery_d FROM tpcc_order_line
       WHERE ol_w_id=$1 AND ol_d_id=$2 AND ol_o_id=$3`,
      [w, d, o.rows[0].o_id]
    );
  }
}
async function delivery(db2, p) {
  const w = rnd(1, p.W);
  const carrier = rnd(1, 10);
  await db2.transaction(async (tx) => {
    for (let d = 1; d <= p.DISTRICTS; d++) {
      const no = await tx.query(
        `SELECT no_o_id FROM tpcc_new_order WHERE no_w_id=$1 AND no_d_id=$2 ORDER BY no_o_id ASC LIMIT 1`,
        [w, d]
      );
      if (!no.rows.length) continue;
      const oId = no.rows[0].no_o_id;
      await tx.query(`DELETE FROM tpcc_new_order WHERE no_w_id=$1 AND no_d_id=$2 AND no_o_id=$3`, [w, d, oId]);
      const cr = await tx.query(
        `UPDATE tpcc_orders SET o_carrier_id=$1 WHERE o_w_id=$2 AND o_d_id=$3 AND o_id=$4 RETURNING o_c_id`,
        [carrier, w, d, oId]
      );
      await tx.query(`UPDATE tpcc_order_line SET ol_delivery_d=now() WHERE ol_w_id=$1 AND ol_d_id=$2 AND ol_o_id=$3`, [w, d, oId]);
      const sum = await tx.query(
        `SELECT COALESCE(SUM(ol_amount),0)::text s FROM tpcc_order_line WHERE ol_w_id=$1 AND ol_d_id=$2 AND ol_o_id=$3`,
        [w, d, oId]
      );
      await tx.query(
        `UPDATE tpcc_customer SET c_balance=c_balance+$1, c_delivery_cnt=c_delivery_cnt+1 WHERE c_w_id=$2 AND c_d_id=$3 AND c_id=$4`,
        [Number(sum.rows[0].s), w, d, cr.rows[0].o_c_id]
      );
    }
  });
}
async function stockLevel(db2, p) {
  const w = rnd(1, p.W);
  const d = rnd(1, p.DISTRICTS);
  const threshold = rnd(10, 20);
  const dr = await db2.raw.query(`SELECT d_next_o_id FROM tpcc_district WHERE d_w_id=$1 AND d_id=$2`, [w, d]);
  const next = dr.rows[0]?.d_next_o_id ?? 1;
  await db2.raw.query(
    `SELECT COUNT(DISTINCT s.s_i_id) AS n FROM tpcc_order_line ol, tpcc_stock s
     WHERE ol.ol_w_id=$1 AND ol.ol_d_id=$2 AND ol.ol_o_id >= $3 AND ol.ol_o_id < $4
       AND s.s_w_id=$1 AND s.s_i_id=ol.ol_i_id AND s.s_quantity < $5`,
    [w, d, next - 20, next, threshold]
  );
}

// server.ts
var PROCESS_START = performance.now();
var __dirname = dirname(fileURLToPath(import.meta.url));
var USE_COS = !!(process.env.COS_HMAC_ACCESS_KEY_ID && process.env.COS_HMAC_SECRET_ACCESS_KEY);
var BUCKET = USE_COS ? process.env.COS_BUCKET ?? "zeropg-cos" : process.env.ZEROPG_BUCKET ?? "zeropg-experiments-euw1";
var DB_PREFIX = process.env.ZEROPG_PREFIX ?? "demo/default";
var STORAGE_SCHEME = USE_COS ? "s3" : "gs";
function selectStore() {
  if (USE_COS) {
    const endpoint = process.env.COS_ENDPOINT_DIRECT || process.env.COS_ENDPOINT;
    if (!endpoint) throw new Error("COS_* creds set but no COS_ENDPOINT/COS_ENDPOINT_DIRECT");
    return new R2BlobStore({
      endpoint,
      accessKeyId: process.env.COS_HMAC_ACCESS_KEY_ID,
      secretAccessKey: process.env.COS_HMAC_SECRET_ACCESS_KEY,
      bucket: BUCKET,
      prefix: DB_PREFIX,
      region: process.env.IBM_COS_REGION ?? "eu-de"
    });
  }
  return new GcsBlobStore({ bucket: BUCKET, prefix: DB_PREFIX });
}
var APP_LABEL = process.env.APP_LABEL ?? "zeropg demo";
var DURABILITY = ["strict", "interval", "sleep"].includes(
  process.env.ZEROPG_DURABILITY ?? ""
) ? process.env.ZEROPG_DURABILITY : "sleep";
var IDLE_FLUSH_MS = Number(process.env.ZEROPG_IDLE_FLUSH_MS ?? 25e3);
var PORT = Number(process.env.PORT ?? 8080);
var INSTANCE_ID = `${process.env.K_REVISION ?? "local"}-${process.pid}`;
function loadSeed() {
  const p = join4(__dirname, "seed.tar.gz");
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : void 0;
}
var db;
var readyMs = 0;
var bootError = null;
var requestsServed = 0;
var paused = false;
var lastWrite = null;
var sleeping = false;
var benching = false;
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
  const store = selectStore();
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
  if (url.pathname === "/bench" && req.method === "POST") {
    if (benching) return json(res, 409, { error: "benchmark already running" });
    benching = true;
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff"
      // keep proxies from buffering/sniffing
    });
    const line = (s = "") => res.write(s + "\n");
    try {
      const durationMs = Math.min(6e4, Math.max(5e3, Number(url.searchParams.get("seconds") ?? 25) * 1e3));
      await runBenchmark(db, { durationMs }, line);
    } catch (e) {
      line(`\u2717 ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    } finally {
      benching = false;
      res.end();
    }
    return;
  }
  if (url.pathname === "/sleep" && req.method === "POST") {
    if (sleeping) return json(res, 409, { error: "already shutting down" });
    sleeping = true;
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff"
      // keep proxies from buffering/ sniffing
    });
    const t0 = performance.now();
    const since = () => `${Math.round(performance.now() - t0)}ms`;
    const line = (s = "") => res.write(s + "\n");
    const fmtBytes = (n) => n < 1e6 ? `${(n / 1e3).toFixed(1)} KB` : `${(n / 1e6).toFixed(1)} MB`;
    line(`\u{1F4A4} sleep requested \u2014 instance ${INSTANCE_ID}`);
    line(`   bucket:    ${STORAGE_SCHEME}://${BUCKET}/${DB_PREFIX}`);
    line(`   durability: ${db.durabilityMode}`);
    line();
    try {
      if (db.pendingFlush) {
        line(`\u2192 flushing pending writes to object storage\u2026`);
        const c = await db.flush();
        if (c && c.mode === "incremental") {
          line(`  \xB7 scan WAL delta                 ${Math.round(c.dumpMs)}ms`);
          line(`  \xB7 PUT ${c.segments} WAL segment (${fmtBytes(c.snapshotBytes)})         ${Math.round(c.uploadMs)}ms`);
          line(`  \xB7 CAS manifest.json (the commit) ${Math.round(c.manifestMs)}ms   \u2190 durable at this instant`);
          line(`  \u2713 committed seq ${c.commitSeq} in ${since()}`);
        } else if (c) {
          line(`  (full-snapshot compaction \u2014 the first commit of an instance's life`);
          line(`   always re-snapshots so WAL ranges never cross writer lives; the`);
          line(`   2nd+ write in a life ships only its tiny WAL delta instead)`);
          line(`  \xB7 checkpoint + WAL switch        ${Math.round(c.dumpMs)}ms`);
          line(`  \xB7 PUT snapshot (${fmtBytes(c.snapshotBytes)})${" ".repeat(Math.max(1, 14 - fmtBytes(c.snapshotBytes).length))}${Math.round(c.uploadMs)}ms`);
          line(`  \xB7 CAS manifest.json (the commit) ${Math.round(c.manifestMs)}ms   \u2190 durable at this instant`);
          line(`  \u2713 committed seq ${c.commitSeq} in ${since()}`);
        } else {
          line(`  \u2713 nothing to flush after all`);
        }
      } else {
        line(`\u2192 no pending writes \u2014 the bucket is already current`);
        line(`  (in sleep mode, nothing uploads until there is something to flush)`);
      }
      line();
      line(`\u2192 releasing the writer lease + closing the engine\u2026`);
      const tc = performance.now();
      await db.close();
      line(`  \u2713 lease released, scratch dir cleared   ${Math.round(performance.now() - tc)}ms`);
      line();
      line(`\u2705 instance exiting (exit 0) after ${since()}.`);
      line(`   the next request cold-starts a fresh instance that restores from the bucket.`);
      line(`   reload the page to watch it wake up. \u{1F976}`);
    } catch (e) {
      line(`\u2717 ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      line(`  (a successor instance already took over; this one exits empty-handed)`);
    }
    res.end();
    setTimeout(() => process.exit(0), 100);
    return;
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
 .sleepbox{margin:1.5rem 0;border-top:1px solid #eee;padding-top:1rem}
 #sleepbtn{background:#5f6368}#sleepbtn:disabled{opacity:.6;cursor:default}
 #sleeplog{background:#1e1e1e;color:#d4f7d4;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;padding:.8rem 1rem;border-radius:8px;margin:.8rem 0 0;max-height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word}
 /* BENCH: TPC-C benchmark button + live log (mirrors the sleep box) */
 #benchbtn{background:#0b8043}#benchbtn:disabled{opacity:.6;cursor:default}
 #benchlog{background:#1e1e1e;color:#cfe8ff;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace;padding:.8rem 1rem;border-radius:8px;margin:.8rem 0 0;max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-word}
</style></head><body>
<h1>${escapeHtml(APP_LABEL)}</h1>
<div class="sub">A real Postgres, living in ${USE_COS ? "an IBM COS" : "a GCS"} bucket. No database server. Scales to zero.</div>
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
<div class="sleepbox">
 <button type="button" id="sleepbtn">\u{1F4A4} put this instance to sleep</button>
 <span class="hint">flushes to the bucket, releases the lease, exits \u2014 the next load cold-starts</span>
 <pre id="sleeplog" hidden></pre>
</div>
<div class="sleepbox">
 <button type="button" id="benchbtn">\u{1F3CE} run TPC-C benchmark</button>
 <span class="hint">a standard OLTP benchmark vs this PGlite DB, streamed live \u2014 self-caps its size, then cleans up</span>
 <pre id="benchlog" hidden></pre>
</div>
<p class="sub">Powered by <code>zeropg</code>: PGlite + object storage + a conditional-write lease.</p>
<script>
const sb = document.getElementById('sleepbtn'), sl = document.getElementById('sleeplog')
sb.addEventListener('click', async () => {
  if (sb.dataset.done) { location.reload(); return }
  sb.disabled = true; sb.textContent = '\u{1F4A4} sleeping\u2026'; sl.hidden = false; sl.textContent = ''
  try {
    const res = await fetch('/sleep', { method: 'POST' })
    const reader = res.body.getReader(), dec = new TextDecoder()
    for (;;) { const { value, done } = await reader.read(); if (done) break
      sl.textContent += dec.decode(value, { stream: true }); sl.scrollTop = sl.scrollHeight }
  } catch (e) { sl.textContent += '\\n[connection closed \u2014 the instance is gone]' }
  sb.disabled = false; sb.dataset.done = '1'; sb.textContent = '\u21BB reload to wake it (cold start)'
})
// BENCH: stream the TPC-C benchmark into its log pane (same reader loop as sleep).
const bb = document.getElementById('benchbtn'), bl = document.getElementById('benchlog')
bb.addEventListener('click', async () => {
  bb.disabled = true; bb.textContent = '\u{1F3CE} benchmarking\u2026'; bl.hidden = false; bl.textContent = ''
  try {
    const res = await fetch('/bench', { method: 'POST' })
    const reader = res.body.getReader(), dec = new TextDecoder()
    for (;;) { const { value, done } = await reader.read(); if (done) break
      bl.textContent += dec.decode(value, { stream: true }); bl.scrollTop = bl.scrollHeight }
  } catch (e) { bl.textContent += '\\n[connection closed]' }
  bb.disabled = false; bb.textContent = '\u{1F3CE} run TPC-C benchmark again'
})
</script>
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
