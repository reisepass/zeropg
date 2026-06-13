// Remote client for a standalone ZeroPGServer. Our existing client is PGlite-only
// (in-process); this is the variant a SEPARATE app uses to talk to a dedicated,
// scale-to-zero zeropg instance over HTTP. It encodes the one extra step a
// scale-to-zero database needs: wake the instance and wait for the restore to
// finish BEFORE the first query, so the app never races a cold start.
//
// Flow: wake() -> poll /ready until ready -> then query via POST /sql (sql()) or
// the auto-REST surface (rest()). Minimal on purpose; no deps.

export interface ZeroPGRemoteClientOptions {
  /** Base URL of the standalone server, e.g. https://zeropg-standalone.example.run. */
  baseUrl: string
  /** Max time to wait for the instance to become ready. Default 120s. */
  readyTimeoutMs?: number
  /** Poll interval while waiting for /ready. Default 500ms. */
  pollIntervalMs?: number
  /** Extra headers (e.g. Authorization) sent on every request. */
  headers?: Record<string, string>
}

interface Readiness {
  ready: boolean
  phase: string
  error: string | null
  restBasePath: string | null
}

export class ZeroPGRemoteClient {
  private readonly base: string
  private readonly readyTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly headers: Record<string, string>

  constructor(opts: ZeroPGRemoteClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 120_000
    this.pollIntervalMs = opts.pollIntervalMs ?? 500
    this.headers = opts.headers ?? {}
  }

  /** Hit /wake so the platform spins the instance up from zero, then resolve
   *  the current readiness snapshot. The HTTP request itself is the wake signal. */
  async wake(): Promise<Readiness> {
    const res = await fetch(`${this.base}/wake`, { headers: this.headers })
    return (await res.json()) as Readiness
  }

  /** Poll /ready until the instance reports ready (restore complete). Throws on
   *  boot error or timeout. */
  async waitReady(): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs
    for (;;) {
      let r: Readiness
      try {
        const res = await fetch(`${this.base}/ready`, { headers: this.headers })
        r = (await res.json()) as Readiness
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`waitReady: ${e instanceof Error ? e.message : e}`)
        await this.sleep()
        continue
      }
      if (r.phase === 'error') throw new Error(`server boot error: ${r.error}`)
      if (r.ready) return
      if (Date.now() > deadline) throw new Error(`waitReady timed out (phase=${r.phase})`)
      await this.sleep()
    }
  }

  /** wake() + waitReady() in one call. Idempotent; cheap once warm. */
  async ensureReady(): Promise<void> {
    await this.wake()
    await this.waitReady()
  }

  /** Run SQL over HTTP (POST /sql). Auto-waits for readiness on first use. */
  async sql<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[]; ms: number }> {
    await this.ensureReady()
    const res = await fetch(`${this.base}/sql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify({ sql }),
    })
    const body = (await res.json()) as { rows?: T[]; ms?: number; error?: string }
    if (!res.ok) throw new Error(body.error ?? `sql failed (${res.status})`)
    return { rows: body.rows ?? [], ms: body.ms ?? 0 }
  }

  /** Talk to the PostgREST auto-REST surface under /rest. `path` is everything
   *  after /rest, e.g. "/notes?select=id,body&order=id.desc". Auto-waits ready. */
  async rest<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    await this.ensureReady()
    const p = path.startsWith('/') ? path : `/${path}`
    const res = await fetch(`${this.base}/rest${p}`, {
      ...init,
      headers: { ...this.headers, ...(init.headers as Record<string, string> | undefined) },
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`rest ${res.status}: ${text}`)
    return (text ? JSON.parse(text) : null) as T
  }

  private sleep(): Promise<void> {
    return new Promise((r) => setTimeout(r, this.pollIntervalMs))
  }
}
