// Object-store cost model for the EAGER-vs-LAZY sweep.
//
// We have no cloud access, so we MODEL the object store. The model has three
// knobs per provider profile, each sampled PER REQUEST so tail effects show up:
//   - first-byte latency (TTFB): a base + jittered distribution (ms). This is
//     the dominant cost for many small range GETs (the lazy fault path).
//   - bandwidth cap (MB/s): throughput once bytes start flowing. This dominates
//     the eager full-restore of a large datadir.
//   - parallelism cap: max concurrent in-flight requests. Eager restore and
//     prefetch can saturate this; a serial fault path cannot.
//
// IMPORTANT: the numbers below are PUBLIC-ESTIMATE PLACEHOLDERS, to be replaced
// by real measured GCS/S3 numbers (V2 Section 8 step 2). They are best-effort
// approximations of commonly reported behavior, NOT measurements. Sources are
// general public knowledge of these services' characteristics circa 2024-2025:
//   - S3 standard: first-byte commonly tens of ms (~30-60ms p50, long p99 tail);
//     per-connection throughput often ~50-90 MB/s; high parallelism available.
//   - S3 Express One Zone / regional-fast: single-digit-ms first byte (~5-10ms).
//   - GCS same-region: between the two (~15-30ms first byte typical).
// Replace ALL of these with measured distributions before trusting POLICY.md.

export const PROVIDER_PROFILES = {
  's3-standard': {
    label: 'S3 Standard (cross-AZ, same region)',
    ttfbBaseMs: 35,        // ESTIMATE: typical p50 first-byte
    ttfbJitterMs: 25,      // ESTIMATE: exponential-ish spread
    ttfbTailMs: 180,       // ESTIMATE: occasional p99 spike magnitude
    tailProb: 0.02,        // ESTIMATE: 2% of requests hit the tail
    bandwidthMBps: 70,     // ESTIMATE: per-connection sustained
    parallelism: 16,       // ESTIMATE: usable concurrent GETs
  },
  'gcs-same-region': {
    label: 'GCS same-region',
    ttfbBaseMs: 20,        // ESTIMATE
    ttfbJitterMs: 15,      // ESTIMATE
    ttfbTailMs: 120,       // ESTIMATE
    tailProb: 0.02,        // ESTIMATE
    bandwidthMBps: 90,     // ESTIMATE
    parallelism: 16,       // ESTIMATE
  },
  's3-express': {
    label: 'S3 Express One Zone / regional-fast',
    ttfbBaseMs: 7,         // ESTIMATE: single-digit-ms first byte
    ttfbJitterMs: 5,       // ESTIMATE
    ttfbTailMs: 40,        // ESTIMATE
    tailProb: 0.01,        // ESTIMATE
    bandwidthMBps: 110,    // ESTIMATE
    parallelism: 32,       // ESTIMATE
  },
}

// Deterministic PRNG so a sweep is reproducible given a seed.
export function makeRng(seed = 1) {
  let s = seed >>> 0
  return () => {
    // xorshift32
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    return s / 0xffffffff
  }
}

// Return a copy of a profile with the base first-byte latency overridden, and
// the jitter/tail scaled proportionally so the distribution shape is preserved.
// Used by the latency-sensitivity sweep (the dominant unknown until we have real
// GCS/S3 numbers).
export function withTTFB(profile, baseMs) {
  const ratio = baseMs / profile.ttfbBaseMs
  return {
    ...profile,
    ttfbBaseMs: baseMs,
    ttfbJitterMs: profile.ttfbJitterMs * ratio,
    ttfbTailMs: profile.ttfbTailMs * ratio,
  }
}

// Sample one request's first-byte latency (ms) from a profile.
export function sampleTTFB(profile, rng) {
  if (rng() < profile.tailProb) {
    // Tail event: base + a large spike (uniform up to tailMs).
    return profile.ttfbBaseMs + rng() * profile.ttfbTailMs
  }
  // Body: base + exponential-ish jitter (-ln(u) gives a right-skewed spread).
  const u = Math.max(rng(), 1e-9)
  return profile.ttfbBaseMs + (-Math.log(u)) * (profile.ttfbJitterMs / 1.5)
}

// Cost (ms) of transferring `bytes` over the link once first byte arrives.
export function transferMs(bytes, profile) {
  return (bytes / (profile.bandwidthMBps * 1e6)) * 1000
}

// Model the wall-clock of issuing N requests of given sizes with a parallelism
// cap. Each request costs TTFB(sampled) + transfer(bytes). With parallelism P,
// we approximate makespan as: requests are distributed across P workers, each
// worker runs its share serially; wall-clock = max over workers of sum of its
// request costs. We assign greedily (longest-processing-time) for a tighter,
// realistic estimate. Returns { wallMs, totalBytes, requests }.
export function modelRequests(sizes, profile, rng) {
  const costs = sizes.map((bytes) => sampleTTFB(profile, rng) + transferMs(bytes, profile))
  // Greedy LPT bin-packing onto `parallelism` workers.
  const workers = new Array(Math.max(1, profile.parallelism)).fill(0)
  const order = costs.map((c, i) => [c, sizes[i]]).sort((a, b) => b[0] - a[0])
  let totalBytes = 0
  for (const [c, bytes] of order) {
    // assign to least-loaded worker
    let min = 0
    for (let w = 1; w < workers.length; w++) if (workers[w] < workers[min]) min = w
    workers[min] += c
    totalBytes += bytes
  }
  return { wallMs: Math.max(...workers), totalBytes, requests: sizes.length }
}

// Coalesce a set of touched 8KB block indices (per relation) into object-layer
// page-groups of `groupBytes`, returning the list of group byte-sizes that must
// be fetched. A group is fetched whole if ANY block in it is touched (this is
// the read-amplification cost of grouping). Blocks are keyed as `${relId}:${blk}`.
export function coalesceToGroups(touchedBlocks, blocksPerGroupBytes, blockSize = 8192) {
  const blocksPerGroup = Math.max(1, Math.round(blocksPerGroupBytes / blockSize))
  const groups = new Set()
  for (const key of touchedBlocks) {
    const [rel, blkStr] = key.split(':')
    const blk = Number(blkStr)
    const groupIdx = Math.floor(blk / blocksPerGroup)
    groups.add(rel + ':' + groupIdx)
  }
  // Each group is fetched as one range GET of groupBytes (or less at file end,
  // but we model full group size as the upper-bound read amplification).
  return Array.from(groups).map(() => blocksPerGroupBytes)
}
