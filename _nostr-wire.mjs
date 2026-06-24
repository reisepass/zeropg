import { serveWire } from '@zeropg/client'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = await mkdtemp(join(tmpdir(),'nostr-zpg-'))
const wire = await serveWire({ dataDir: join(dir,'db'), host: '0.0.0.0', port: 5499, maxConnections: 80 })
console.log('zeropg wire up on 0.0.0.0:5499, datadir', dir)
