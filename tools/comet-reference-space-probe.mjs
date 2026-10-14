import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { CDP, connect, launchChrome } from './tail-probe-lib/cdp.mjs'
import { referenceSpaceInstallerSource } from './comet-reference-space-page.mjs'
import { judge, LIMITS } from './space-pursuit-lib/checks.mjs'
import { saveAlignedShot } from './space-pursuit-lib/images.mjs'
import { rawEvidence, boundedWrite, sourceRecorder, verdict } from './comet-reference-evidence.mjs'

const args = Object.fromEntries(process.argv.slice(2).flatMap((v, i, a) => v.startsWith('--') ? [[v.slice(2), a[i + 1]]] : []))
for (const k of ['url', 'repo', 'out', 'port']) if (!args[k]) throw Error('required --' + k)
const out = path.resolve(args.out), port = Number(args.port), width = Number(args.width || 1440), height = Number(args.height || 900)
const cadence = args.dt ? args.dt.split(',').map(Number) : [1 / 60]
if (!cadence.every(v => v > 0 && v <= .1)) throw Error('invalid cadence')
await fs.mkdir(out, { recursive: true })
if (await fs.stat(path.join(out, 'result.json')).catch(() => null)) throw Error('use fresh --out')
const data = { schema: 2, url: args.url, repo: path.resolve(args.repo), out, width, height, cadence, limits: LIMITS, started: new Date().toISOString(), checks: [], samples: [], pairs: [], arrivals: [] }
let browser, cdp, ws, recorder
const ev = async expression => { const r = await cdp.eval(expression); if (r?.__error) throw Error(r.__error); return r }
try {
  await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', () => reject(Error('instrument-invalid: CDP port busy'))); s.listen(port, '127.0.0.1', () => s.close(resolve)) })
  data.profile = path.join(process.env.TMPDIR, 'comet-space-' + port)
  browser = launchChrome({ port, profile: data.profile, chrome: args.chrome || 'C:/Program Files/Google/Chrome/Application/chrome.exe', w: width, h: height, extra: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disk-cache-size=1000000'] })
  ws = new WebSocket(await connect(port)); await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) }); cdp = new CDP(ws)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable', { maxTotalBufferSize: 50000000, maxResourceBufferSize: 9000000 })
  recorder = sourceRecorder({ cdp, ws, out, repo: data.repo })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: args.theme || 'dark' }, { name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await cdp.send('Page.navigate', { url: args.url })
  if (!await ev('new Promise(r=>{let n=0;const poll=()=>window.__SUB2API_PARTICLE_ENGINE__?.currentBrandSlug?r(true):++n>300?r(false):setTimeout(poll,100);poll()})')) throw Error('instrument-invalid: no live engine')
  data.document = await recorder.seal()
  data.meta = await ev(referenceSpaceInstallerSource()); await ev('__SPACE_PROBE.stop()')
  data.gpu = await ev('__SPACE_PROBE.audit()')
  const start = data.meta.initial.t, first = Math.floor(start / 12) + 1, last = first + 3, end = last * 12 + 11.7
  const schedule = new Map(), put = (t, event) => { const key = Number(t.toFixed(7)), events = schedule.get(key) || []; if (event) events.push(event); schedule.set(key, events) }
  for (let t = Math.ceil(start * 10) / 10; t <= end; t += .1) put(t)
  for (let leg = first; leg <= last; leg++) {
    const base = leg * 12
    for (const [dt, kind] of [[6.50001, 'arrival'], [7.8999, 'before'], [7.90001, 'enter'], [7.9001, 'start'], [10.8999, 'end'], [10.90001, 'exit']]) put(base + dt, { kind, leg })
    put(base + 11.582 - .0001); put(base + 11.582 + .0001)
  }
  const pairMap = new Map(), entries = [...schedule].filter(([t]) => t > start).sort((a, b) => a[0] - b[0])
  for (let index = 0; index < entries.length;) {
    const batch = []
    do { batch.push(entries[index++]) } while (index < entries.length && !batch.at(-1)[1].length && batch.length < 20)
    const results = await ev(`(async()=>{const out=[];for(const t of ${JSON.stringify(batch.map(([t]) => t))})out.push(await __SPACE_PROBE.advance(t,${JSON.stringify(cadence)}));return out})()`)
    data.samples.push(...results)
    for (let i = 0; i < batch.length; i++) for (const event of batch[i][1]) {
      const sample = results[i]
      if (event.kind === 'arrival') { data.arrivals.push(sample); continue }
      const pair = pairMap.get(event.leg) || {}; pairMap.set(event.leg, pair)
      if (['start', 'end'].includes(event.kind)) {
        const detail = await ev('__SPACE_PROBE.sample(true)')
        if (Math.abs(detail.t - sample.t) > 1e-8) throw Error('instrument-invalid: screenshot epoch drift')
        pair[event.kind] = detail; pair.png ??= { aligned: true }
        pair.png[event.kind] = await saveAlignedShot(cdp, detail, path.join(out, `hold-${event.leg}-${event.kind}.png`))
      } else pair[event.kind] = sample
    }
  }
  data.pairs = [...pairMap.values()]
  await ev(`__SPACE_PROBE.advance(${(last + 1) * 12 + 4.8})`)
  data.counterfactual = await ev('__SPACE_PROBE.counterfactual()')
  data.cameraBoundary = []
  for (const t of [149.9, 150, 150.1, 151, 152.1, 152.2, 152.3, 153]) {
    const r = await ev(`__SPACE_PROBE.advance(${t},${JSON.stringify(cadence)},false)`)
    data.cameraBoundary.push({ t: r.t, camera: r.camera, phase: r.phase, head: r.head })
  }
  Object.assign(data, judge(data))
  data.sourceBinding = await recorder.finish()
  data.checks.push({ id: 'normal-RAF-recording', status: 'skip', detail: 'No normal-clock long recording in this deterministic run; not counted as pass' })
  data.checks.push({ id: 'served-source-stable', status: data.sourceBinding.status, detail: 'actual document epoch / loaded sourcesContent equals target repo before and after capture' })
  // Original judge exports 40; the legacy entry adds recording and source stability = 42.
  data.spatial = verdict(data.checks)
  if (data.checks.length !== 42) throw Error('instrument-invalid: spatial denominator changed: ' + data.checks.length)
  const headCheck = data.checks.find(c => c.id === 'head-final-geometry-agreement')
  headCheck.detail.source = 'actual body offsets[coreAssignment[i]] (identity fallback for d85) transformed by scratch.bodyBasis, then actual matrix; original tolerance unchanged'
  data.shapeProof = await ev('__SPACE_PROBE.shapeProof()')
  data.additionalChecks = [{ id: 'future-head-camera-birth-independence', ...data.counterfactual }, { id: 'flow-basis-aperture-3D', ...data.shapeProof }]
  data.raw = await rawEvidence(out, 'space-observations.json', { meta: data.meta, gpu: data.gpu, samples: data.samples, pairs: data.pairs, arrivals: data.arrivals })
  data.sampleCount = data.samples.length
  delete data.samples; delete data.pairs; delete data.arrivals; delete data.meta; delete data.gpu
} catch (error) {
  data.error = String(error.stack || error)
  const fixedIds = ['actual-source', 'gpu-position3-color4-scale', 'sample-coverage', 'head-final-geometry-agreement', 'finite', 'camera-always-plus-Z', 'camera-150-152.2', 'gather-hold-early-scatter-freeze', 'four-consecutive-flights', 'XZ-movement-support', 'flight-no-rest-plus-Z', 'X-one-sign-flip-at-departure', 'stop-at-fitGap', 'capture-band', 'fixed-world-subject-groups', 'tail-real-births', 'tail-world-inertia', 'tail-axis-world-plus-Z', 'draw-budget', 'geometry-budget', 'normal-RAF-recording', 'served-source-stable']
  const first = data.meta ? Math.floor(data.meta.initial.t / 12) + 1 : 1
  const expected = [...fixedIds, ...Array.from({ length: 4 }, (_, i) => first + i).flatMap(leg => ['hold-world-freeze-', 'hold-perspective-shrink-', 'hold-three-seconds-', 'glyph-final-geometry-', 'paired-PNG-'].map(id => id + leg))]
  for (const id of expected) if (!data.checks.some(c => c.id === id)) data.checks.push({ id, status: 'instrument-invalid', detail: 'capture aborted before check; see error' })
  data.spatial = verdict(data.checks)
  data.additionalChecks = [{ id: 'future-head-camera-birth-independence', status: 'instrument-invalid', reason: data.error }, { id: 'flow-basis-aperture-3D', status: 'instrument-invalid', reason: data.error }]
  if (recorder) data.sourceBinding = await recorder.finish().catch(e => ({ status: 'instrument-invalid', error: String(e) }))
} finally {
  if (cdp) try { await cdp.send('Browser.close') } catch {}
  ws?.close(); browser?.kill()
  if (browser?.exitCode === null) await new Promise(r => { browser.once('exit', r); setTimeout(r, 3000) })
  if (data.profile) await fs.rm(data.profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  Object.assign(data, verdict([...data.checks, ...(data.additionalChecks || [])])); data.finished = new Date().toISOString()
  // Partial observations also remain compressed if instrumentation fails.
  if (data.samples) { data.raw = await rawEvidence(out, 'partial-space-observations.json', { meta: data.meta, gpu: data.gpu, samples: data.samples, pairs: data.pairs }); delete data.samples; delete data.pairs; delete data.meta; delete data.gpu }
  await boundedWrite(path.join(out, 'result.json'), JSON.stringify(data, null, 2))
  await boundedWrite(path.join(out, 'summary.txt'), [JSON.stringify({ status: data.status, exit: data.exitCode, spatial: data.spatial, total: data.total, counts: data.counts }), ...data.checks.map(c => `${c.status}: ${c.id}`), data.error || ''].join('\n'))
  console.log(JSON.stringify({ status: data.status, exit: data.exitCode, spatial: data.spatial, total: data.total, counts: data.counts, samples: data.sampleCount, out, error: data.error?.split('\n').slice(0, 2) }))
  process.exitCode = data.exitCode
}
