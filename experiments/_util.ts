// Shared helpers for experiment probes: JSON-line result logging, latency
// stats, and a unique run prefix so concurrent/repeat runs never collide.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const BUCKET = process.env.ZEROPG_BUCKET ?? 'zeropg-experiments-euw1'

/** A run id derived from time + pid; passed in for reproducibility in logs. */
export function runId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
}

/** Append one JSON line to results/<file>. */
export function logResult(file: string, obj: Record<string, unknown>): void {
  const path = `results/${file}`
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n')
}

export interface Stats {
  n: number
  min: number
  p50: number
  p99: number
  max: number
  mean: number
}

export function stats(samplesMs: number[]): Stats {
  const s = [...samplesMs].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  const sum = s.reduce((a, b) => a + b, 0)
  return {
    n: s.length,
    min: round(s[0] ?? 0),
    p50: round(q(0.5) ?? 0),
    p99: round(q(0.99) ?? 0),
    max: round(s[s.length - 1] ?? 0),
    mean: round(sum / (s.length || 1)),
  }
}

export function round(n: number, dp = 2): number {
  const f = 10 ** dp
  return Math.round(n * f) / f
}

export async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now()
  const out = await fn()
  return [out, performance.now() - t0]
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  // crypto.getRandomValues caps at 65536 per call.
  for (let i = 0; i < n; i += 65536) {
    crypto.getRandomValues(b.subarray(i, Math.min(i + 65536, n)))
  }
  return b
}

/** Pretty console section header. */
export function section(title: string): void {
  console.log(`\n${'═'.repeat(4)} ${title} ${'═'.repeat(Math.max(0, 60 - title.length))}`)
}

let failures = 0
export function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.log(`  ✗ FAIL: ${msg}`)
  }
}
export function failureCount(): number {
  return failures
}
export function resetFailures(): void {
  failures = 0
}
