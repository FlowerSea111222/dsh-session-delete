/**
 * Offline check of the Host half: drive the registered route against a temp
 * layout instead of a real Session store.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const plugin = await import('./index.js')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dssd-'))
const project = path.join(root, '--D-project--')
const sessionId = 'session-abc-123'
const sessionDir = path.join(project, sessionId)
await fs.mkdir(sessionDir, { recursive: true })
await fs.writeFile(path.join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.alloc(1024))

let route = null
const calls = []
const ctx = {
  connection: { fetch: { register: (r) => { route = r; return () => { route = null } } } },
  sessionPersistence: {
    stat: async (id) => (id === sessionId
      ? { location: { kind: 'jsonl', path: path.join(sessionDir, 'session.v4.jsonl.zstd') } }
      : undefined),
  },
  workspaceRegistry: {
    unarchiveSession: async (id) => { calls.push(['unarchive', id]) },
    unpinSession: async (id) => { calls.push(['unpin', id]) },
  },
  waterfall: async () => [],
  get: () => ({ get: () => undefined }),
  effect: (fn) => fn(),
  logger: { debug: () => {} },
}

plugin.apply(ctx)
if (route === null) throw new Error('route was not registered')

const post = (body) => route.fetch(new Request('http://local' + route.path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})).then(async (response) => ({ status: response.status, payload: await response.json() }))

const ok = await post({ sessionId })
console.log('delete:', ok.status, JSON.stringify(ok.payload))
console.log('dir gone:', !(await fs.stat(sessionDir).catch(() => null)))
console.log('registry calls:', JSON.stringify(calls))

const again = await post({ sessionId })
console.log('second delete:', again.status, JSON.stringify(again.payload))

const escaped = await post({ sessionId: '../../etc' })
console.log('bad id:', escaped.status, escaped.payload.code)

// A running turn must block the deletion the same way archive does.
await fs.mkdir(sessionDir, { recursive: true })
await fs.writeFile(path.join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.alloc(8))
ctx.waterfall = async () => [{ kind: 'turn' }]
const busy = await post({ sessionId })
console.log('busy:', busy.status, busy.payload.code)
console.log('dir kept:', Boolean(await fs.stat(sessionDir).catch(() => null)))

await fs.rm(root, { recursive: true, force: true })
