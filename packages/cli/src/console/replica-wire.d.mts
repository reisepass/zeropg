// Type surface of replica-wire.mjs (plain .mjs so it runs under tsx and plain
// node without a build step; see the header there).

export interface ReplicaWire {
  port: number
  host: string
  url: string
  stop(): Promise<void>
}

export function openReplicaWire(opts: {
  bucket: string
  prefix: string
  host?: string
  port?: number
  maxConnections?: number
}): Promise<ReplicaWire>

export interface ReplicaManagerEntry extends ReplicaWire {
  openedAt: number
}

export interface ReplicaManager {
  list(): Array<{ key: string; port: number; openedAt: number }>
  get(key: string): ReplicaManagerEntry | undefined
  ensure(key: string, opts: { bucket: string; prefix: string; host?: string; port?: number; maxConnections?: number }): Promise<ReplicaManagerEntry>
  close(key: string): Promise<boolean>
  closeAll(): Promise<void>
}

export function createReplicaManager(opts?: { maxOpen?: number; log?: (msg: string) => void }): ReplicaManager
