// Access-token provider for the GCS JSON API.
//
// On GCE/Cloud Run we read a token straight from the metadata server (the VM
// runs as the project service account). Locally we shell out to
// `gcloud auth print-access-token` via ADC. Tokens are cached until shortly
// before expiry. No google-auth-library dependency: one fetch, one fallback.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'

interface CachedToken {
  token: string
  expiresAtMs: number
}

let cache: CachedToken | null = null
let source: 'metadata' | 'gcloud' | null = null

async function fetchFromMetadata(): Promise<CachedToken | null> {
  try {
    const res = await fetch(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { access_token: string; expires_in: number }
    return {
      token: body.access_token,
      expiresAtMs: Date.now() + body.expires_in * 1000,
    }
  } catch {
    return null
  }
}

async function fetchFromGcloud(): Promise<CachedToken | null> {
  try {
    const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token'])
    return {
      token: stdout.trim(),
      // gcloud tokens are ~1h; refresh conservatively.
      expiresAtMs: Date.now() + 50 * 60 * 1000,
    }
  } catch {
    return null
  }
}

/** Returns a valid OAuth2 access token, cached until ~60s before expiry. */
export async function getAccessToken(): Promise<string> {
  if (cache && Date.now() < cache.expiresAtMs - 60_000) {
    return cache.token
  }
  // Prefer whatever source worked last time to avoid a dead 2s metadata probe.
  const order: Array<() => Promise<CachedToken | null>> =
    source === 'gcloud'
      ? [fetchFromGcloud, fetchFromMetadata]
      : [fetchFromMetadata, fetchFromGcloud]
  for (const fn of order) {
    const t = await fn()
    if (t) {
      cache = t
      source = fn === fetchFromGcloud ? 'gcloud' : 'metadata'
      return t.token
    }
  }
  throw new Error(
    'could not obtain a GCP access token from the metadata server or gcloud',
  )
}
