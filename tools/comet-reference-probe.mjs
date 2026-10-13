import fs from 'node:fs/promises'
import path from 'node:path'
import { rawEvidence, boundedWrite, sourceRecorder, verdict } from './comet-reference-evidence.mjs'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { CDP, connect, launchChrome } from './tail-probe-lib/cdp.mjs'
import { referenceSpaceInstallerSource } from './comet-reference-space-page.mjs'
import { installMaterialProbe } from './comet-material-page.mjs'
import { installReferenceProbe } from './comet-reference-page.mjs'
import { referenceEvidence, measureImage, comparison, hash } from './comet-reference-image.mjs'
import { decodePng } from './tail-probe-lib/png.mjs'
import { LIMITS, deltaPixels, visibility, tailMetrics, motionCheck, lifecycle, scatterMetrics, resourceBudget, discCheck } from './comet-reference-checks.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, s) => v.startsWith('--') ? [...a, v.includes('=') ? [v.slice(2, v.indexOf('=')), v.slice(v.indexOf('=') + 1)] : [v.slice(2), s[i + 1]]] : a, []))
const legOffset = Number(args['leg-offset'] ?? 0)
if (![0, 1].includes(legOffset)) throw Error('--leg-offset must be 0 or 1')
for (const k of ['url', 'repo', 'out', 'port', 'w', 'h', 'theme', 'reference']) if (!args[k]) throw Error('required --' + k)
if (!['light', 'dark'].includes(args.theme)) throw Error('--theme must be light or dark')
const out = path.resolve(args.out), port = Number(args.port), width = Number(args.w), height = Number(args.h)
if (!Number.isInteger(port) || !Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 240) throw Error('invalid --port/--w/--h')
await fs.mkdir(out, { recursive: true })
if (await fs.stat(path.join(out, 'result.json')).catch(() => null)) throw Error('use fresh --out')
const save = (name, value) => boundedWrite(path.join(out, name), JSON.stringify(value, null, 2))
const writeShot = async (name, base64) => { const bytes = Buffer.from(base64, 'base64'); await boundedWrite(path.join(out, name), bytes); return { file: name, sha256: hash(bytes), bytes: bytes.length } }
let decodedReference = args.reference, referenceConversion = null
const signature = await fs.readFile(args.reference)
if (signature.subarray(0, 4).toString('latin1') !== '\x89PNG' && signature.subarray(0, 4).toString('latin1') !== 'RIFF') throw Error('unsupported image signature; expected PNG or WebP')
if (signature.subarray(0, 4).toString('latin1') === 'RIFF') {
  decodedReference = path.join(out, 'reference-decoded.png')
  const ffmpeg = 'C:/Users/28147/AppData/Local/hermes/tools/ffmpeg-9.0.1-win32-x64/bin/ffmpeg.exe'
  execFileSync(ffmpeg, ['-y', '-i', path.resolve(args.reference), '-frames:v', '1', decodedReference], { stdio: 'pipe' })
  referenceConversion = { tool: ffmpeg, output: decodedReference }
}
const ref = await referenceEvidence(args.reference, path.join(out, 'reference'), decodedReference)
const data = { schema: 1, started: new Date().toISOString(), url: args.url, out, port, width, height, theme: args.theme, legOffset,
  reference: ref, referenceConversion, limits: LIMITS, baseline: 'd85ab0fb5c04c1caded90d6305c306c0c07cf999', sourceHashes: [], frames: [], destructive: [], checks: [], visualReview: [],
  inheritedFreeze: { status: 'not-rerun', note: 'Run comet-reference-space-probe.mjs on the same stable target for the original 42 world/camera/three-second checks. The short visual capture does not infer their verdict.' } }
await save('initial.json', data)
let browser, ws, cdp, recorder
const ev = async expression => { const r = await cdp.eval(expression); if (r?.__error) throw Error(r.__error); return r }
const shot = async (name, expression = null) => { if (expression) await ev(expression); return writeShot(name, await cdp.shot()) }
const isolate = ids => ev(`__MATERIAL_PROBE.isolate(${JSON.stringify(ids)})`)
const restore = '__MATERIAL_PROBE.restore()'
const raw = row => rawEvidence(out, `${row.label}.json`, row)
const budgetSamples = []
const sample = async (audit = false) => {
  const row = await ev(`__REFERENCE_PROBE.sample(${audit})`)
  budgetSamples.push({ t: row.t, phase: row.phase, leg: row.leg, drawCalls: row.drawCalls, geometryBytes: row.geometryBytes })
  return row
}
const advance = async t => { await ev(`__REFERENCE_PROBE.advance(${t})`); return sample() }
const isolatedShot = async (name, ids) => { await isolate(ids); try { return await shot(name) } finally { await ev(restore) } }
const pixelDelta = async (a, b) => deltaPixels(await fs.readFile(path.join(out, a.file)), await fs.readFile(path.join(out, b.file)))
try {
  await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', () => reject(Error('instrument-invalid: CDP port busy'))); s.listen(port, '127.0.0.1', () => s.close(resolve)) })
  data.profile = path.join(process.env.TMPDIR, 'comet-reference-' + port)
  browser = launchChrome({ port, profile: data.profile, chrome: args.chrome || 'C:/Program Files/Google/Chrome/Application/chrome.exe', w: width, h: height, extra: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disk-cache-size=1000000'] })
  ws = new WebSocket(await connect(port)); await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) }); cdp = new CDP(ws)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Network.enable', { maxTotalBufferSize: 50000000, maxResourceBufferSize: 9000000 })
  recorder = sourceRecorder({ cdp, ws, out, repo: path.resolve(args.repo) })
  const errors = []
  ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.method === 'Runtime.exceptionThrown' || m.method === 'Log.entryAdded' && m.params.entry.level === 'error' || m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.method) })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: args.theme }, { name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await cdp.send('Page.navigate', { url: args.url })
  if (!await ev('new Promise(r=>{let n=0;const poll=()=>window.__SUB2API_PARTICLE_ENGINE__?.currentBrandSlug?r(true):++n>300?r(false):setTimeout(poll,100);poll()})')) throw Error('instrument-invalid: no dev engine on target; production pixels cannot certify particles')
  data.document = await recorder.seal()
  const transformed = await (await fetch(new URL('/src/features/home-particle/engine/ParticleEngine.ts', args.url))).text()
  const three = transformed.match(/from\s*["']([^"']*\/three\.js[^"']*)["']/)?.[1]
  if (!three) throw Error('instrument-invalid: missing served Three import')
  await ev(`import(${JSON.stringify(three)}).then(m=>{window.__REFERENCE_THREE=m;return true})`)
  data.before = await shot('page-original.png')
  data.space = await ev(referenceSpaceInstallerSource()); await ev('__SPACE_PROBE.stop()')
  data.material = await ev('(' + installMaterialProbe.toString() + ')()')
  data.probe = await ev('(' + installReferenceProbe.toString() + ')()')
  const inventory = await ev('__MATERIAL_PROBE.inventory()')
  data.inventory = inventory
  const meshCandidates = inventory.filter(o => o.isMesh)
  const isolateAll = async name => { await isolate([inventory.find(o => o.body).uuid, inventory.find(o => o.tail).uuid, ...meshCandidates.map(o => o.uuid)]); try { return await shot(name) } finally { await ev(restore) } }
  const first = Math.floor(data.material.pose.t / 12) + 1 + legOffset
  data.leg = { offset: legOffset, index: first, raw: [], checks: [] }
  const start = first * 12 + 1.0
  await ev(`__SPACE_PROBE.advance(${start})`)
  const flightStart = await sample()
  await ev('__REFERENCE_PROBE.advance(' + (first * 12 + 6.45) + ')')
  const travel = await sample(true)
  data.leg.flight = { start: flightStart.head, end: travel.head, dx: travel.head[0] - flightStart.head[0], dz: travel.head[2] - flightStart.head[2] }
  data.leg.flight.xSign = Math.sign(data.leg.flight.dx)
  data.leg.raw.push(await raw({ label: 'flight-start', ...flightStart }))
  data.frames.push({ label: 'travel-before-gather', sample: await raw({ label: 'travel-before-gather', ...travel }), wholePage: await shot('travel-original-page.png'), blackScene: await isolateAll('travel-isolated-all.png') })
  data.frames.at(-1).bodyOnly = await (async () => { await isolate([inventory.find(o => o.body).uuid]); try { return await shot('travel-body-only.png') } finally { await ev(restore) } })()
  data.frames.at(-1).tailOnly = await (async () => { await isolate([inventory.find(o => o.tail).uuid]); try { return await shot('travel-tail-only.png') } finally { await ev(restore) } })()
  data.frames.at(-1).tailEmpty = await (async () => { await isolate([]); try { return await shot('travel-tail-empty.png') } finally { await ev(restore) } })()
  data.frames.at(-1).tailMetrics = tailMetrics(travel)
  data.frames.at(-1).visibilityPixelTest = visibility(travel, deltaPixels(await fs.readFile(path.join(out, data.frames.at(-1).tailOnly.file)), await fs.readFile(path.join(out, data.frames.at(-1).tailEmpty.file))))
  data.comparison = await comparison(path.join(out, 'reference', 'reference-crop.png'), path.join(out, data.frames.at(-1).blackScene.file), path.join(out, 'reference-comparison.png'), data.frames.at(-1).tailMetrics.head, data.frames.at(-1).tailMetrics.tip)
  const eventMeshes = meshCandidates.filter(o => o.materials.some(m => /uEventMode/.test(m.fragment || '') && /float thickness=0\.075\+radial/.test(m.fragment || '')))
  data.eventContributions = []
  for (const obj of meshCandidates) {
    await isolate([obj.uuid]); let part
    try { part = await shot(`mesh-${obj.uuid}.png`) } finally { await ev(restore) }
    const empty = await (async () => { await isolate([]); try { return Buffer.from(await cdp.shot(), 'base64') } finally { await ev(restore) } })()
    data.frames.at(-1).meshContributions ??= []
    data.frames.at(-1).meshContributions.push({ uuid: obj.uuid, name: obj.name, triangles: obj.triangles, visible: obj.visible, effect: deltaPixels(await fs.readFile(path.join(out, part.file)), empty) })
  }
  const warmStart = first * 12 + 6.5
  const gatherFrames = []
  for (const [label, q] of [['gather-early', .05], ['gather-middle', .4], ['gather-late', .95]]) {
    const r = await advance(warmStart + q * 1.4)
    const screenshot = await isolateAll(`${label}.png`)
    gatherFrames.push({ label, phase: r.phase, leg: r.leg, sample: await raw({ label, ...r }), screenshot })
  }
  data.frames.push(...gatherFrames)
  const hold = await advance(first * 12 + 8.5)
  data.frames.push({ label: 'logo-hold', sample: await raw({ label: 'logo-hold', ...hold }), screenshot: await isolateAll('logo-hold.png') })
  const scatterRows = []
  for (const q of [0,.2,.4,.6,.8,1]) {
    const r = await advance(first * 12 + 10.9 + q * 1.1 * .62)
    for (const mesh of eventMeshes) {
      const isolated = await isolatedShot(`scatter-${q}-event.png`, [mesh.uuid]), empty = await isolatedShot(`scatter-${q}-empty.png`, [])
      data.eventContributions.push({ q, isolated, empty, check: discCheck(mesh, await pixelDelta(isolated, empty)) })
    }
    scatterRows.push(r)
    const screenshot = await isolateAll(`scatter-${q}.png`)
    data.frames.push({ label: `scatter-${q}`, q, sample: await raw({ label: `scatter-${q}`, ...r }), screenshot })
  }
  data.scatter = scatterMetrics(scatterRows)
  const preMotion = await advance((first + 1) * 12 + 4.8)
  const postMotion = await advance((first + 1) * 12 + 4.88)
  data.normalMotion = motionCheck(preMotion, postMotion)
  await ev(`__REFERENCE_PROBE.mutate('static')`)
  const staticBefore = await ev('__REFERENCE_PROBE.sample(true)'), staticBeforeShot = await shot('control-static-before.png')
  await ev('__REFERENCE_PROBE.staticStep(0.08)')
  const staticAfter = await ev('__REFERENCE_PROBE.sample(true)')
  data.destructive.push({ label: 'static-tail', prerequisite: data.normalMotion, before: staticBeforeShot, after: await shot('control-static-after.png'), check: motionCheck(staticBefore, staticAfter), raw: await raw({ label: 'control-static', staticBefore, staticAfter }) }); await ev('__REFERENCE_PROBE.restore()')
  // Visible diagnostic state is separate from the native product verdict; d85 opacity is zero.
  const nativeOpacity = await ev('__SPACE_PROBE.engine.tailPoints.material.opacity')
  await ev('__SPACE_PROBE.engine.tailPoints.material.opacity=1')
  const alphaBefore = await ev('__REFERENCE_PROBE.sample(true)'), alphaShot = await isolatedShot('control-alpha-visible.png', [inventory.find(o => o.tail).uuid]), emptyAlpha = await isolatedShot('control-alpha-empty.png', [])
  await ev(`__REFERENCE_PROBE.mutate('alpha0')`)
  const zeroAlpha = await ev('__REFERENCE_PROBE.sample(true)'), zeroShot = await isolatedShot('control-alpha-zero.png', [inventory.find(o => o.tail).uuid])
  data.destructive.push({ label: 'zero-GPU-alpha', fixture: 'diagnostic material opacity=1 only; native product result unchanged', nativeOpacity, prerequisite: visibility(alphaBefore, await pixelDelta(alphaShot, emptyAlpha)), check: visibility(zeroAlpha, await pixelDelta(zeroShot, emptyAlpha)), screenshots: [alphaShot, zeroShot, emptyAlpha], raw: await raw({ label: 'control-alpha', alphaBefore, zeroAlpha }) })
  await ev('__REFERENCE_PROBE.restore()'); await ev(`__SPACE_PROBE.engine.tailPoints.material.opacity=${nativeOpacity}`)
  const flatBefore = await ev('__REFERENCE_PROBE.sample(true)'); await ev(`__REFERENCE_PROBE.mutate('flat')`); const flatAfter = await ev('__REFERENCE_PROBE.sample(true)')
  data.destructive.push({ label: '2D-depth-collapse', prerequisite: tailMetrics(flatBefore).depth, check: tailMetrics(flatAfter).depth, raw: await raw({ label: 'control-flat', flatBefore, flatAfter }), screenshot: await shot('control-flat-tail.png') })
  await ev('__REFERENCE_PROBE.restore()')
  const injection = await ev(`__REFERENCE_PROBE.mutate('disc')`), discSample = await ev('__REFERENCE_PROBE.sample(false)')
  const injected = discSample.meshes.find(m => m.uuid === injection.mesh)
  const discShot = await isolatedShot('control-disc.png', [injected.uuid]), emptyDisc = await isolatedShot('control-disc-empty.png', [])
  data.destructive.push({ label: 'visible-disc', prerequisite: { status: 'pass', reason: 'injected UUID absent from original inventory' }, mesh: injected, check: discCheck(injected, await pixelDelta(discShot, emptyDisc)), screenshot: discShot, empty: emptyDisc })
  await ev('__REFERENCE_PROBE.restore()')
  const history = await ev('window.__REFERENCE_PROBE.history')
  data.history = await raw({ label: 'lifecycle-history', ...history })
  data.lifecycle = lifecycle(history)
  data.sourceBinding = await recorder.finish()
  data.checks = [
    { id: 'loaded-source-bound-to-repo', status: data.sourceBinding.status },
    { id: 'tail GPU alpha & rendering', ...data.frames.find(x => x.label === 'travel-before-gather').visibilityPixelTest },
    { id: 'tail projection/depth', status: data.frames.find(x => x.label === 'travel-before-gather').tailMetrics.depth.status, detail: data.frames.find(x => x.label === 'travel-before-gather').tailMetrics },
    { id: 'atomized body visual form', status: 'skip', reason: 'Review required: screenshots show real body points at gather/scatter phases, but no machine score asserts fine-particle breakup versus chunky fragments.' },
    { id: 'radial collapse measured', status: data.scatter.status, detail: data.scatter },
    { id: 'birth lifecycle source-to-outflow', status: 'skip', reason: 'Small identity sample and retirement observations do not certify the full tail lifetime; raw measurements retained.', detail: data.lifecycle },
    { id: 'advecting jet visual strength', status: data.lifecycle.convection.status, reason: data.lifecycle.convection.reason },
    { id: 'disc/event geometry', status: data.eventContributions.some(r => r.check.status === 'fail') ? 'fail' : eventMeshes.length ? 'pass' : meshCandidates.length ? 'skip' : 'pass', reason: 'compiled radial strata event shader identified independently; per-event isolated pixels versus empty frame', detail: data.eventContributions },
    { id: 'frozen camera and 3-second path', status: 'skip', reason: data.inheritedFreeze.note },
    { id: 'draw/geometry resource budget', ...resourceBudget(budgetSamples) },
    { id: 'FPS 55 target', status: 'skip', reason: 'FPS intentionally not measured during this short geometry probe.' },
    { id: 'human visual comparison', status: 'skip', reason: 'Use unaltered screenshot and reference crop side by side; no SSIM/similarity threshold or 100% claim.' }
  ]
  data.visualReview = [
    { item: 'Reference black crop / warm white-gold wedge, orange-gold sheath and cold blue-gold interwoven plume', status: 'review-required', reference: 'reference/reference-crop.png', frame: 'travel-isolated-all.png' },
    { item: 'Long shallow tail with fine sparse skirt and a dense porous particle nucleus', status: 'review-required', frame: 'travel-body-only.png' },
    { item: 'Body progressively separates as real particles into logo shape rather than a large rock or smoke shell', status: 'review-required', frames: ['gather-early.png','gather-middle.png','gather-late.png','logo-hold.png'] },
    { item: 'Radial collapse visibly starts outside, accelerates inward, and leaves center quiet without a disk, ring, or added bright surface', status: 'review-required', frames: ['scatter-0.png','scatter-0.4.png','scatter-0.8.png','scatter-1.png'] }
  ]
  data.checks.push(...data.destructive.map(c => ({ id: 'selftest-' + c.label, status: c.prerequisite.status === 'pass' && c.check.status === 'fail' ? 'pass' : 'instrument-invalid', prerequisite: c.prerequisite, rejection: c.check })))
  if (data.checks.length !== 16) throw Error('instrument-invalid: core denominator changed')
  data.leg.raw.push(...data.frames.map(f => ({ label: f.label, ...f.sample })))
  data.leg.coverage = { status: flightStart.phase === 'travel' && travel.phase === 'travel' && flightStart.leg === first && travel.leg === first && Math.abs(data.leg.flight.dx) > LIMITS.numericalEpsilon && data.leg.flight.dz > 0 && gatherFrames.every(f => f.phase === 'gather' && f.leg === first) && hold.phase === 'hold' && hold.leg === first && scatterRows.every(r => r.phase === 'scatter' && r.leg === first) ? 'pass' : 'instrument-invalid', criterion: 'selected leg flight + three gather frames + hold + six scatter frames; run both offsets and compare actual xSign' }
  if (data.leg.coverage.status !== 'pass') throw Error('instrument-invalid: selected leg coverage incomplete')
  data.leg.checks = data.checks
  Object.assign(data, verdict(data.checks)); process.exitCode = data.exitCode
  data.inventory = await raw({ label: 'inventory', inventory: data.inventory })
  data.material = await raw({ label: 'material', ...data.material })
  data.space = await raw({ label: 'space', ...data.space })
  data.consoleErrors = errors
  data.finished = new Date().toISOString()
  await save('result.json', data)
  const report = [`Comet reference judge — evidentiary report`, `Run: ${out}`, `Target: ${args.url}; ${width}x${height}; ${args.theme}`, `Reference: ${ref.sourceSha256}; ${ref.width}x${ref.height}; crops ${ref.crop.join(',')}; mask polygon in reference/reference.json`, '', `Machine checks (pass/fail/skip are not a visual match score):`, ...data.checks.map(c => `${c.status}: ${c.id}${c.reason ? ' — ' + c.reason : ''}`), '', `Manual visual review remains required for all four image/staging items. No similarity percentage is calculated.`, `Reference measurements, raw geometry frames and screenshots are enumerated in result.json.`, `Source baseline hashes: ${data.sourceHashes.length}; frames: ${data.frames.length}; destructive controls: ${data.destructive.length}; console errors: ${errors.length}.`, `Budget gates remain ${LIMITS.drawCalls} draw calls / ${LIMITS.geometryBytes} bytes; target ${LIMITS.fpsTarget} FPS.`].join('\n')
  await fs.writeFile(path.join(out, 'README.txt'), report)
  console.log(JSON.stringify({ status: data.status, exit: data.exitCode, total: data.total, counts: data.counts, out, frames: data.frames.length, controls: data.destructive.length, births: data.lifecycle.birthCount, consoleErrors: errors.length }))
} catch (error) {
  data.error = String(error.stack || error)
  const expected = ['loaded-source-bound-to-repo', 'tail GPU alpha & rendering', 'tail projection/depth', 'atomized body visual form', 'radial collapse measured', 'birth lifecycle source-to-outflow', 'advecting jet visual strength', 'disc/event geometry', 'frozen camera and 3-second path', 'draw/geometry resource budget', 'FPS 55 target', 'human visual comparison', 'selftest-static-tail', 'selftest-zero-GPU-alpha', 'selftest-2D-depth-collapse', 'selftest-visible-disc']
  for (const id of expected) if (!data.checks.some(c => c.id === id)) data.checks.push({ id, status: 'instrument-invalid', reason: 'capture aborted before this check; see error' })
  // Preserve the same denominator when an exception occurs after checks were built.
  if (!data.checks.some(c => c.status === 'instrument-invalid')) data.checks[0] = { id: expected[0], status: 'instrument-invalid', reason: data.error }
  if (recorder) data.sourceBinding = await recorder.finish().catch(e => ({ status: 'instrument-invalid', error: String(e) }))
  Object.assign(data, verdict(data.checks))
  data.finished = new Date().toISOString(); await save('result.json', data); await fs.writeFile(path.join(out, 'README.txt'), `instrument-invalid\n${data.error}\n`)
  console.error(data.error); process.exitCode = 2
} finally {
  if (cdp) try { await ev('__REFERENCE_PROBE?.restore()'); await ev('__MATERIAL_PROBE?.restore()'); await cdp.send('Browser.close') } catch {}
  ws?.close(); browser?.kill()
  if (browser?.exitCode === null) await new Promise(r => { browser.once('exit', r); setTimeout(r, 3000) })
  if (data.profile) await fs.rm(data.profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
}
