// Fleet admin core types. The design principle (cross-model reviewed, see
// docs/FLEET.md): NO stored registry. The clouds themselves are the source of
// truth - instances are discovered live from the provider APIs by looking for
// services that carry zeropg metadata (env vars / labels). The only local state
// is a list of "contexts": places to look, never a list of databases.

/** A place to look for zeropg instances, not a database inventory. */
export interface FleetContext {
  /** Short name used in CLI output and --context flags, e.g. "gcp-main". */
  name: string
  /** Provider id. v1 ships gcloud (Cloud Run); the interface is provider-narrow
   *  on purpose: list services, read env, wake URL. */
  provider: 'gcloud'
  /** GCP project id. */
  project: string
  /** Cloud Run region, e.g. europe-west1. */
  region: string
}

/** One discovered zeropg instance (a deployed service carrying zeropg env). */
export interface Instance {
  /** Cloud Run service name (unique per context). */
  name: string
  context: string
  project: string
  region: string
  /** Public base URL of the service (the HTTP control face). */
  url: string | null
  /** Durable home of the database. */
  bucket: string | null
  prefix: string | null
  appLabel: string | null
  durability: string | null
  /** Contrib extensions the service preloads (ZEROPG_EXTENSIONS). */
  extensions: string[]
  /** Container image currently deployed. */
  image: string | null
  /** Cloud Run ingress setting (e.g. INGRESS_TRAFFIC_ALL). */
  ingress: string | null
  /** Last deploy/update time (RFC3339). */
  updateTime: string | null
  labels: Record<string, string>
  /** How this service was recognized as zeropg: label and/or env vars. */
  matchedBy: Array<'label' | 'env'>
}

/** Live health, obtained by probing the control face. NOTE: probing a
 *  scale-to-zero service wakes it; `fleet ls` never probes, `fleet status`
 *  does and says so. */
export interface InstanceStatus {
  instance: Instance
  reachable: boolean
  /** True when the service answered on the zeropg HTTP control face (/up JSON).
   *  False for an app service (PrivateBin, NocoDB, ...) that fronts zeropg and
   *  serves its own app on the public port - it answers HTTP but has no zeropg
   *  control face, so phase/metrics are unavailable (inspect it via the
   *  bucket-backed studio snapshot instead). */
  hasControlFace: boolean
  /** HTTP status of the probe response (any value means the container is up). */
  httpStatus: number | null
  /** Server boot phase from /up: init | restoring | wire | postgrest | ready | error. */
  phase: string | null
  ready: boolean
  /** From /metrics when ready. */
  dbBytes: number | null
  totalRssMB: number | null
  requestsServed: number | null
  fencingToken: number | string | null
  postgrest: boolean | null
  /** Security posture: true when the service is invokable by allUsers.
   *  zeropg has no wire/HTTP auth today, so public ingress + public invoker
   *  means the database endpoints are open to the internet. */
  publicInvoker: boolean | null
  probeMs: number
  error: string | null
}

export interface FleetConfig {
  contexts: FleetContext[]
}
