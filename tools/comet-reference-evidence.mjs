import fs from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { hash } from './comet-reference-image.mjs'

export const MAX_FILE_BYTES = 10_000_000
// Independently decodable gzip parts, concatenated after decompression in manifest order.
export async function rawEvidence(out, name, value) {
  const raw = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
  const parts = []
  for (let offset = 0; offset < Math.max(1, raw.length); offset += 8_000_000) {
    const bytes = gzipSync(raw.subarray(offset, offset + 8_000_000))
    const file = `${name}${raw.length > 8_000_000 ? '.part' + String(parts.length + 1).padStart(3, '0') : ''}.gz`
    if (bytes.length >= MAX_FILE_BYTES) throw Error('instrument-invalid: evidence part exceeds file cap')
    await fs.mkdir(path.dirname(path.join(out, file)), { recursive: true })
    await fs.writeFile(path.join(out, file), bytes)
    parts.push({ file, bytes: bytes.length, sha256: hash(bytes) })
  }
  return { encoding: 'gzip parts; concatenate decompressed bytes', rawBytes: raw.length, sha256: hash(raw), parts }
}
export async function boundedWrite(file, bytes) {
  if (Buffer.byteLength(bytes) >= MAX_FILE_BYTES) throw Error('instrument-invalid: file exceeds 10 MB: ' + file)
  await fs.writeFile(file, bytes)
}
export function verdict(checks) {
  const counts = Object.fromEntries(['pass', 'fail', 'instrument-invalid', 'skip', 'measured-not-verdict'].map(s => [s, checks.filter(c => c.status === s).length]))
  const status = counts['instrument-invalid'] ? 'instrument-invalid' : counts.fail ? 'fail' : counts.skip || counts['measured-not-verdict'] ? 'skip' : 'pass'
  return { status, exitCode: status === 'instrument-invalid' ? 2 : status === 'fail' ? 1 : 0, total: checks.length, counts }
}

export const REQUIRED_PRODUCTS = ['ParticleEngine', 'emittedTail', 'cometVisual', 'cometTransition', 'choreography', 'spaceMotion', 'spaceMotionContract']
const enginePrefix = '/src/features/home-particle/engine/'
// Captures the browser's actual responses, not a parallel fetch mistaken for loaded code.
export function sourceRecorder({ cdp, ws, out, repo }) {
  const epochs = [], responses = [], pending = new Map(), jobs = [], errors = []
  let frozenEpoch = null
  const record = async row => {
    try {
      const response = await cdp.send('Network.getResponseBody', { requestId: row.requestId })
      const body = response.base64Encoded ? Buffer.from(response.body, 'base64').toString('utf8') : response.body
      const raw = await rawEvidence(out, `sources/epoch-${row.loaderId}/${row.requestId.replace(/[^\w.-]/g, '_')}.js`, body)
      row.raw = raw
      const match = body.match(/sourceMappingURL=data:application\/json[^,]*;base64,([^\s]+)/)
      if (!match && new URL(row.url).pathname === enginePrefix + 'types.ts' && body === '') {
        Object.assign(row, { raw, erasedTypesOnly: true, binding: 'skip: empty Vite type-only response; excluded from required runtime source set' })
        return
      }
      if (!match) throw Error('missing inline sourcesContent')
      const map = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'))
      const name = new URL(row.url).pathname.slice(enginePrefix.length)
      if (!/^[\w-]+\.ts$/.test(name)) throw Error('unexpected engine path')
      const index = map.sources?.findIndex(s => s.replaceAll('\\', '/').split('/').at(-1) === name)
      const content = map.sourcesContent?.[index]
      if (typeof content !== 'string') throw Error('missing matching sourcesContent: ' + name)
      const file = path.join(repo, 'frontend/src/features/home-particle/engine', name)
      const actual = await fs.readFile(file, 'utf8')
      Object.assign(row, { file, raw, name: name.slice(0, -3), mapSource: map.sources[index], sourceSha256: hash(content), repoSha256: hash(actual), matches: content === actual })
    } catch (error) { row.error = String(error); errors.push({ url: row.url, error: row.error }) }
  }
  ws.addEventListener('message', event => {
    const m = JSON.parse(event.data), p = m.params
    if (m.method === 'Page.frameNavigated' && !p.frame.parentId) epochs.push({ loaderId: p.frame.loaderId, frameId: p.frame.id, url: p.frame.url, observedAt: new Date().toISOString() })
    if (m.method === 'Network.responseReceived' && new URL(p.response.url).pathname.startsWith(enginePrefix)) {
      const row = { requestId: p.requestId, loaderId: p.loaderId, url: p.response.url, status: p.response.status }
      responses.push(row); pending.set(p.requestId, row)
    }
    if (m.method === 'Network.loadingFinished' && pending.has(p.requestId)) {
      const row = pending.get(p.requestId); pending.delete(p.requestId); jobs.push(record(row))
    }
    if (m.method === 'Network.loadingFailed' && pending.has(p.requestId)) { const row = pending.get(p.requestId); pending.delete(p.requestId); row.error = p.errorText }
  })
  return {
    async seal() { await Promise.all(jobs); frozenEpoch = epochs.at(-1)?.loaderId; return { loaderId: frozenEpoch, epochs: [...epochs], responses: responses.length } },
    async finish() {
      await Promise.all(jobs)
      for (const row of responses) if (row.file) row.repoUnchanged = hash(await fs.readFile(row.file)) === row.repoSha256
      const loaded = responses.filter(r => r.loaderId === frozenEpoch), missing = REQUIRED_PRODUCTS.filter(n => !loaded.some(r => r.name === n))
      const stable = !!frozenEpoch && epochs.at(-1)?.loaderId === frozenEpoch && epochs.filter(e => e.loaderId === frozenEpoch).length === 1
      const valid = stable && !pending.size && !errors.length && !missing.length && loaded.length >= REQUIRED_PRODUCTS.length && loaded.every(r => r.status === 200 && (r.erasedTypesOnly || r.matches && r.repoUnchanged) && !r.error)
      return { status: valid ? 'pass' : 'instrument-invalid', repo, frozenEpoch, epochs, required: REQUIRED_PRODUCTS, missing, pending: pending.size, errors, stable, responses }
    }
  }
}
