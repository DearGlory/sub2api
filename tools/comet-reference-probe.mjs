import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { gunzipSync, gzipSync } from 'node:zlib'
import { CDP, connect, launchChrome } from './tail-probe-lib/cdp.mjs'
import { installSpaceProbe } from './space-pursuit-lib/page.mjs'
import { installMaterialProbe } from './comet-material-page.mjs'
import { installReferenceProbe } from './comet-reference-page.mjs'
import { referenceEvidence, measureImage, comparison, hash } from './comet-reference-image.mjs'
import { decodePng } from './tail-probe-lib/png.mjs'
import { LIMITS, deltaPixels, visibility, tailMetrics, motionCheck, lifecycle, scatterMetrics, discCheck } from './comet-reference-checks.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, s) => v.startsWith('--') ? [...a, [v.slice(2), s[i + 1]]] : a, []))
for (const k of ['url', 'out', 'port', 'w', 'h', 'theme', 'reference']) if (!args[k]) throw Error('required --' + k)
if (!['light', 'dark'].includes(args.theme)) throw Error('--theme must be light or dark')
const out = path.resolve(args.out), port = Number(args.port), width = Number(args.w), height = Number(args.h)
if (!Number.isInteger(port) || !Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 240) throw Error('invalid --port/--w/--h')
await fs.mkdir(out, { recursive: true })
const save = (name, value) => fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2))
const writeShot = async (name, base64) => { const bytes = Buffer.from(base64, 'base64'); await fs.writeFile(path.join(out, name), bytes); return { file: name, sha256: hash(bytes), bytes: bytes.length } }
const git = (...argv) => execFileSync('git', argv, { encoding: 'utf8' }).trim()
const freezeModules = ['spaceMotion','spaceMotionContract','flightPath','flightTiming','choreography','constants','types','cometVisualContract']
const paths = name => `frontend/src/features/home-particle/engine/${name}.ts`
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
const data = { schema: 1, started: new Date().toISOString(), url: args.url, out, port, width, height, theme: args.theme,
  reference: ref, referenceConversion, limits: LIMITS, baseline: 'd85ab0fb5c04c1caded90d6305c306c0c07cf999', sourceHashes: [], frames: [], destructive: [], checks: [], visualReview: [],
  inheritedFreeze: { status: 'not-rerun', note: 'Frozen-source baseline hashes are recorded below. The existing space-pursuit probe, camera contract and 3 s motion are not rerun or inferred from this short isolated capture; parent must rerun after A/B merge.' } }
for (const name of freezeModules) {
  const file = paths(name), expected = git('rev-parse', `${data.baseline}:${file}`), actual = git('hash-object', file), response = await fetch(new URL(`/src/features/home-particle/engine/${name}.ts`, args.url)), body = await response.text()
  data.sourceHashes.push({ name, expectedGitBlob: expected, worktreeGitBlob: actual, servedStatus: response.status, servedTransformedSha256: hash(body), worktreeMatchesBaseline: expected === actual, servedModulePresent: response.ok && !body.trimStart().startsWith('<') })
}
await save('initial.json', data)
let browser, ws, cdp, draw = null
const ev = async expression => { const r = await cdp.eval(expression); if (r?.__error) throw Error(r.__error); return r }
const shot = async (name, expression = null) => { if (expression) await ev(expression); return writeShot(name, await cdp.shot()) }
const isolate = ids => `__MATERIAL_PROBE.isolate(${JSON.stringify(ids)})`
const restore = `__MATERIAL_PROBE.restore()`
const raw = async row => { const bytes = gzipSync(JSON.stringify(row)); const file = `${row.label}.json.gz`; await fs.writeFile(path.join(out, file), bytes); return { file, sha256: hash(bytes), bytes: bytes.length, rawBytes: gunzipSync(bytes).length } }
try {
  await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', () => reject(Error('instrument-invalid: CDP port busy'))); s.listen(port, '127.0.0.1', () => s.close(resolve)) })
  browser = launchChrome({ port, profile: path.join(out, 'profile'), chrome: args.chrome || 'C:/Program Files/Google/Chrome/Application/chrome.exe', w: width, h: height, extra: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] })
  ws = new WebSocket(await connect(port)); await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) }); cdp = new CDP(ws)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Network.enable')
  const errors = []
  ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.method === 'Runtime.exceptionThrown' || m.method === 'Log.entryAdded' && m.params.entry.level === 'error' || m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.method) })
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 })
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: args.theme }, { name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await cdp.send('Page.navigate', { url: args.url })
  if (!await ev('new Promise(r=>{let n=0;const poll=()=>window.__SUB2API_PARTICLE_ENGINE__?.currentBrandSlug?r(true):++n>300?r(false):setTimeout(poll,100);poll()})')) throw Error('instrument-invalid: no dev engine on target; production pixels cannot certify particles')
  data.before = await shot('page-original.png')
  data.space = await ev('(' + installSpaceProbe.toString() + ')()'); await ev('__SPACE_PROBE.stop()')
  data.material = await ev('(' + installMaterialProbe.toString() + ')()')
  data.probe = await ev('(' + installReferenceProbe.toString() + ')()')
  const inventory = await ev('__MATERIAL_PROBE.inventory()')
  data.inventory = inventory
  const meshCandidates = inventory.filter(o => o.isMesh)
  const isolateAll = async name => { await ev(isolate([inventory.find(o => o.body).uuid, inventory.find(o => o.tail).uuid, ...meshCandidates.map(o => o.uuid)])); try { return await shot(name) } finally { await ev(restore) } }
  const first = Math.floor(data.material.pose.t / 12) + 1
  const start = first * 12 + 1.0
  await ev(`__SPACE_PROBE.advance(${start})`)
  await ev('__REFERENCE_PROBE.advance(' + (first * 12 + 6.45) + ')')
  const travel = await ev('__REFERENCE_PROBE.sample(true)')
  data.frames.push({ label: 'travel-before-gather', sample: await raw({ label: 'travel-before-gather', ...travel }), wholePage: await shot('travel-original-page.png'), blackScene: await isolateAll('travel-isolated-all.png') })
  data.frames.at(-1).bodyOnly = await (async () => { await ev(isolate([inventory.find(o => o.body).uuid])); try { return await shot('travel-body-only.png') } finally { await ev(restore) } })()
  data.frames.at(-1).tailOnly = await (async () => { await ev(isolate([inventory.find(o => o.tail).uuid])); try { return await shot('travel-tail-only.png') } finally { await ev(restore) } })()
  data.frames.at(-1).tailEmpty = await (async () => { await ev(isolate([])); try { return await shot('travel-tail-empty.png') } finally { await ev(restore) } })()
  data.frames.at(-1).tailMetrics = tailMetrics(travel)
  data.frames.at(-1).visibilityPixelTest = visibility(travel, deltaPixels(await fs.readFile(path.join(out, data.frames.at(-1).tailOnly.file)), await fs.readFile(path.join(out, data.frames.at(-1).tailEmpty.file))))
  await comparison(path.join(out, 'reference', 'reference-crop.png'), path.join(out, data.frames.at(-1).tailOnly.file), path.join(out, 'reference-comparison.png'), data.frames.at(-1).tailMetrics.head, data.frames.at(-1).tailMetrics.tip)
  for (const obj of meshCandidates) {
    await ev(isolate([obj.uuid])); let part
    try { part = await shot(`mesh-${obj.uuid}.png`) } finally { await ev(restore) }
    const empty = await (async () => { await ev(isolate([])); try { return Buffer.from(await cdp.shot(), 'base64') } finally { await ev(restore) } })()
    data.frames.at(-1).meshContributions ??= []
    data.frames.at(-1).meshContributions.push({ uuid: obj.uuid, name: obj.name, triangles: obj.triangles, visible: obj.visible, effect: deltaPixels(await fs.readFile(path.join(out, part.file)), empty) })
  }
  const warmStart = first * 12 + 6.5
  const gatherFrames = []
  for (const [label, q] of [['gather-early', .05], ['gather-middle', .4], ['gather-late', .95]]) {
    const r = await ev('__REFERENCE_PROBE.advance(' + (warmStart + q * 1.4) + ')')
    const screenshot = await isolateAll(`${label}.png`)
    gatherFrames.push({ label, sample: await raw({ label, ...r }), screenshot })
  }
  data.frames.push(...gatherFrames)
  const hold = await ev('__REFERENCE_PROBE.advance(' + (first * 12 + 8.5) + ')')
  data.frames.push({ label: 'logo-hold', sample: await raw({ label: 'logo-hold', ...hold }), screenshot: await isolateAll('logo-hold.png') })
  const scatterRows = []
  for (const q of [0,.2,.4,.6,.8,1]) {
    const r = await ev('__REFERENCE_PROBE.advance(' + (first * 12 + 10.9 + q * 1.1 * .62) + ')')
    scatterRows.push(r)
    const screenshot = await isolateAll(`scatter-${q}.png`)
    data.frames.push({ label: `scatter-${q}`, q, sample: await raw({ label: `scatter-${q}`, ...r }), screenshot })
  }
  data.scatter = scatterMetrics(scatterRows)
  const lastScatter = scatterRows.at(-1), preMotion = await ev('__REFERENCE_PROBE.sample(true)')
  await ev(`__REFERENCE_PROBE.mutate('static')`); const staticBefore = await ev('__REFERENCE_PROBE.sample(true)'); await ev('__REFERENCE_PROBE.staticStep(0.08)'); const staticAfter = await ev('__REFERENCE_PROBE.sample(true)')
  data.destructive.push({ label: 'static-tail negative control', injection: 'retained exact GPU tail position buffer while the engine simulation advanced for 0.08 s', before: await shot('control-static-before.png'), after: await shot('control-static-after.png'), check: motionCheck(staticBefore, staticAfter) }); await ev('__REFERENCE_PROBE.restore()')
  const beforeAlpha = await ev('__REFERENCE_PROBE.sample(true)'); await ev(`__REFERENCE_PROBE.mutate('alpha0')`); const zeroAlpha = await ev('__REFERENCE_PROBE.sample(true)')
  const zeroAlphaPixels = await (async () => { await ev(isolate([inventory.find(o => o.tail).uuid])); try { return Buffer.from(await cdp.shot(), 'base64') } finally { await ev(restore) } })()
  const emptyTailPixels = await (async () => { await ev(isolate([])); try { return Buffer.from(await cdp.shot(), 'base64') } finally { await ev(restore) } })()
  const zeroAlphaDelta = deltaPixels(zeroAlphaPixels, emptyTailPixels)
  data.destructive.push({ label: 'zero-GPU-alpha negative control', injection: 'real tailPoints GPU material.opacity forced to zero', before: beforeAlpha.tail.gpu.uniforms.opacity, after: zeroAlpha.tail.gpu.uniforms.opacity, check: visibility(zeroAlpha, zeroAlphaDelta), screenshot: await shot('control-zero-alpha.png'), pixelMeaning: 'zero-alpha tail-only render compared with empty-scene compositor screenshot' })
  await ev('__REFERENCE_PROBE.restore()')
  const flatBefore = await ev('__REFERENCE_PROBE.sample(true)'); await ev(`__REFERENCE_PROBE.mutate('flat')`); const flatAfter = await ev('__REFERENCE_PROBE.sample(true)')
  data.destructive.push({ label: '2D depth-collapse negative control', injection: 'all actual emitted tail points set to one local z plane', before: tailMetrics(flatBefore).depth, after: tailMetrics(flatAfter).depth, screenshot: await shot('control-flat-tail.png') })
  await ev('__REFERENCE_PROBE.restore()')
  const basePage = Buffer.from(await cdp.shot(), 'base64'), emptyPage = await (async () => { await ev(isolate([])); try { return Buffer.from(await cdp.shot(), 'base64') } finally { await ev(restore) } })()
  await ev(`__REFERENCE_PROBE.mutate('disc')`); const discSample = await ev('__REFERENCE_PROBE.sample(true)'), discPage = Buffer.from(await cdp.shot(), 'base64')
  const injected = discSample.meshes.find(m => !meshCandidates.some(o => o.uuid === m.uuid)), emptyShot = Buffer.from(await cdp.shot(), 'base64')
  await fs.writeFile(path.join(out, 'control-disc.png'), discPage)
  const discDelta = deltaPixels(discPage, emptyPage)
  data.destructive.push({ label: 'visible disc-mesh negative control', injection: 'actual BufferGeometry triangle-fan mesh added to the live scene and separately identified by UUID', mesh: injected, check: discCheck(injected, discDelta), screenshot: { file: 'control-disc.png', sha256: hash(discPage) } })
  await ev('__REFERENCE_PROBE.restore()')
  const summaryAfterControls = await ev('__REFERENCE_PROBE.sample(true)')
  data.lifecycle = lifecycle(await ev('window.__REFERENCE_PROBE.history'))
  data.checks = [
    { id: 'worktree frozen sources match d85 / served modules present', status: data.sourceHashes.every(x => x.worktreeMatchesBaseline && x.servedModulePresent) ? 'pass' : 'fail', detail: data.sourceHashes.filter(x => !x.worktreeMatchesBaseline || !x.servedModulePresent).map(x => ({ name: x.name, servedStatus: x.servedStatus, expectedGitBlob: x.expectedGitBlob, worktreeGitBlob: x.worktreeGitBlob })) },
    { id: 'tail GPU alpha & rendering', ...data.frames.find(x => x.label === 'travel-before-gather').visibilityPixelTest },
    { id: 'tail projection/depth', status: data.frames.find(x => x.label === 'travel-before-gather').tailMetrics.depth.status, detail: data.frames.find(x => x.label === 'travel-before-gather').tailMetrics },
    { id: 'atomized body visual form', status: 'skip', reason: 'Review required: screenshots show real body points at gather/scatter phases, but no machine score asserts fine-particle breakup versus chunky fragments.' },
    { id: 'radial collapse measured', status: data.scatter.status, detail: data.scatter },
    { id: 'birth lifecycle source-to-outflow', status: data.lifecycle.birthCount ? 'measured-not-verdict' : 'skip', detail: data.lifecycle },
    { id: 'advecting jet visual strength', status: data.lifecycle.convection.status, reason: data.lifecycle.convection.reason },
    { id: 'disc/event geometry', status: 'skip', reason: 'Per-mesh screenshots/deltas are evidence; all unknown candidate meshes require visual review.' },
    { id: 'frozen camera and 3-second path', status: 'skip', reason: data.inheritedFreeze.note },
    { id: 'draw/geometry resource budget', status: data.frames.at(-1).sample ? 'skip' : 'instrument-invalid', reason: 'Read live draw calls and unique scene geometry bytes from JSON; short isolated probe does not establish production tier/steady-state budget.' },
    { id: 'FPS 55 target', status: 'skip', reason: 'FPS intentionally not measured during this short geometry probe.' },
    { id: 'human visual comparison', status: 'skip', reason: 'Use unaltered screenshot and reference crop side by side; no SSIM/similarity threshold or 100% claim.' }
  ]
  data.visualReview = [
    { item: 'Reference black crop / warm white-gold wedge, orange-gold sheath and cold blue-gold interwoven plume', status: 'review-required', reference: 'reference/reference-crop.png', frame: 'travel-isolated-all.png' },
    { item: 'Long shallow tail with fine sparse skirt and a dense porous particle nucleus', status: 'review-required', frame: 'travel-body-only.png' },
    { item: 'Body progressively separates as real particles into logo shape rather than a large rock or smoke shell', status: 'review-required', frames: ['gather-early.png','gather-middle.png','gather-late.png','logo-hold.png'] },
    { item: 'Radial collapse visibly starts outside, accelerates inward, and leaves center quiet without a disk, ring, or added bright surface', status: 'review-required', frames: ['scatter-0.png','scatter-0.4.png','scatter-0.8.png','scatter-1.png'] }
  ]
  data.consoleErrors = errors
  data.finished = new Date().toISOString()
  await save('result.json', data)
  const report = [`Comet reference judge — evidentiary report`, `Run: ${out}`, `Target: ${args.url}; ${width}x${height}; ${args.theme}`, `Reference: ${ref.sourceSha256}; ${ref.width}x${ref.height}; crops ${ref.crop.join(',')}; mask polygon in reference/reference.json`, '', `Machine checks (pass/fail/skip are not a visual match score):`, ...data.checks.map(c => `${c.status}: ${c.id}${c.reason ? ' — ' + c.reason : ''}`), '', `Manual visual review remains required for all four image/staging items. No similarity percentage is calculated.`, `Reference measurements, raw geometry frames and screenshots are enumerated in result.json.`, `Source baseline hashes: ${data.sourceHashes.length}; frames: ${data.frames.length}; destructive controls: ${data.destructive.length}; console errors: ${errors.length}.`, `Budget gates remain ${LIMITS.drawCalls} draw calls / ${LIMITS.geometryBytes} bytes; target ${LIMITS.fpsTarget} FPS.`].join('\n')
  await fs.writeFile(path.join(out, 'README.txt'), report)
  console.log(JSON.stringify({ status: 'captured', out, checks: data.checks.map(c => [c.id, c.status]), frames: data.frames.length, controls: data.destructive.length, births: data.lifecycle.birthCount, consoleErrors: errors.length }, null, 2))
} catch (error) {
  data.error = String(error.stack || error); data.checks.push({ id: 'instrument', status: 'instrument-invalid', reason: data.error })
  data.finished = new Date().toISOString(); await save('result.json', data); await fs.writeFile(path.join(out, 'README.txt'), `instrument-invalid\n${data.error}\n`)
  console.error(data.error); process.exitCode = 2
} finally {
  if (cdp) try { await ev('__REFERENCE_PROBE?.restore()'); await ev('__MATERIAL_PROBE?.restore()'); await cdp.send('Browser.close') } catch {}
  ws?.close(); browser?.kill()
}
