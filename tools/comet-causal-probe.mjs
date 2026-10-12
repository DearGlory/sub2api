#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { launchChrome, connect, CDP, sleep, FREEZE_RAF } from './tail-probe-lib/cdp.mjs'
import { installCausalProbe } from './comet-causal-page.mjs'
import { LIMITS, compactVerdict, analyzeMotion, analyzePerf, selfCheck } from './comet-causal-verdicts.mjs'
const HERE = dirname(fileURLToPath(import.meta.url))
const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const [key, ...rest] = process.argv[i].replace(/^--/, '').split('=')
  args[key] = rest.length ? rest.join('=') : process.argv[i + 1]?.startsWith('--') || !process.argv[i + 1] ? true : process.argv[++i]
}
const allowed = ['url', 'out', 'port', 'profile', 'w', 'h', 'theme', 'observe', 'perf-seconds', 'self-check', 'help', 'label']
if (args.help) {
  console.log('node comet-causal-probe.mjs --url URL --out ABS_DIR --port 10131 --profile ABS_DIR --w 1440 --h 900 --theme dark|light [--observe ABS_JSON] [--perf-seconds 32] [--label baseline-f110b9ffc] [--self-check]')
  process.exit(0)
}
for (const key of Object.keys(args)) if (!allowed.includes(key)) throw Error('Unknown option --' + key)
const out = resolve(args.out || join(HERE, '../../evidence/judge/baseline'))
const port = Number(args.port || 10131), w = Number(args.w || 1440), h = Number(args.h || 900)
const theme = args.theme || 'dark', seconds = Number(args['perf-seconds'] || 32)
if (![10131, 10132].includes(port) || !['dark', 'light'].includes(theme) || !(w > 0 && h > 0) || seconds < 26) throw Error('port must be 10131/10132; theme dark/light; positive viewport; perf-seconds >=26')
mkdirSync(out, { recursive: true })
const save = (file, value) => writeFileSync(join(out, file), JSON.stringify(value, null, 2))
const self = selfCheck(); save('self-check.json', self)
if (args['self-check']) { console.log(JSON.stringify(self, null, 2)); process.exit(self.pass ? 0 : 2) }
const url = args.url || 'http://127.0.0.1:5321/home'
const profile = resolve(args.profile || join(out, 'chrome-' + port))
const result = { schema: 'comet-causal-probe/v1', started: new Date().toISOString(), label: args.label || 'unverified-target',
  command: [process.execPath, ...process.argv.slice(1)], url, out, profile, port, viewport: [w, h], theme,
  thresholds: LIMITS, selfCheck: self, observations: [], verdicts: [], status: 'instrument-invalid', exitCode: 2,
  boundaries: ['geometry alpha proxy, not pixel visibility', 'no C3 aesthetic auto-pass', 'no movie/full-release acceptance',
    'deterministic integration is NOT FPS; normal rAF run measured separately', 'target commit supplied by operator, not inferred from URL'] }
let chrome, ws
const verdict = (criterion, status, evidence) => result.verdicts.push({ criterion, status, evidence })
try {
  let occupied = false
  try { occupied = (await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1000) })).ok } catch { /* free */ }
  if (occupied) throw Error('instrument-invalid: exclusive CDP port already occupied; not attaching to another browser')
  chrome = launchChrome({ chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe', port, profile, w, h })
  chrome.on('error', error => { result.launchError = String(error) })
  const wsUrl = await connect(port)
  ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
  const cdp = new CDP(ws)
  const evaluate = async expression => { const r = await cdp.eval(expression); if (r?.__error) throw Error(r.__error); return r }
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'no-preference' }] })
  await cdp.send('Page.navigate', { url })
  let ready = false
  for (let i = 0; i < 90; i++) {
    ready = await evaluate('!!window.__SUB2API_PARTICLE_ENGINE__?.running')
    if (ready) break
    await sleep(400)
  }
  if (!ready) throw Error('instrument-invalid: debug engine unavailable/running=false')
  // Public theme API only; no scratch, state, geometry or lifecycle writes.
  await evaluate(`(() => { const e=window.__SUB2API_PARTICLE_ENGINE__; e.setTheme(${theme === 'light'}); document.documentElement.classList.toggle('dark', ${theme === 'dark'}); return true })()`)
  const observe = args.observe ? JSON.parse(readFileSync(resolve(args.observe), 'utf8')) : null
  const meta = await evaluate(`(${installCausalProbe.toString()})(${JSON.stringify({ limits: LIMITS, observe })})`)
  result.instrument = meta; save('instrument.json', meta)
  result.implementationFingerprints = Object.fromEntries(Object.entries(meta.methodSources).map(([k, v]) => [k, createHash('sha256').update(v).digest('hex')]))
  if (meta.invalid) throw Error('instrument-invalid: ' + meta.invalid)
  console.log('观测池：' + meta.poolSeparation + '；先测正常rAF ' + seconds + '秒（不截屏、不批量读geometry）')
  const perf = await evaluate(`window.__CCP.livePerf(${seconds})`)
  save('normal-raf.json', perf)
  result.performance = analyzePerf(perf)
  if (!perf.originUnchanged || !perf.engineUnchanged || perf.visibility.some(v => v.state !== 'visible') || !perf.longtaskSupported) verdict('C4-instrument', 'instrument-invalid', '导航/HMR/隐藏页面/longtask不支持')
  verdict('C4-normal-run', 'manual-review', result.performance)
  console.log('正常rAF：' + Object.entries(result.performance.windows).map(([k, v]) => k + '=' + v.fps.toFixed(2) + 'fps').join(', '))
  // A fresh engine behind a preinstalled rAF queue gives an exact, repeatable clock origin.
  // This reload is AFTER the normal-run measurement and is never charged to C4.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE_RAF })
  await cdp.send('Page.reload', { ignoreCache: false })
  let fresh = false
  for (let i = 0; i < 90; i++) {
    fresh = await evaluate('!!window.__TP_FROZEN && !!window.__SUB2API_PARTICLE_ENGINE__?.running')
    if (fresh) break
    await sleep(400)
  }
  if (!fresh) throw Error('instrument-invalid: deterministic fresh engine did not mount')
  await evaluate(`(async () => { await document.fonts.ready; const e=window.__SUB2API_PARTICLE_ENGINE__; e.setTheme(${theme === 'light'}); document.documentElement.classList.toggle('dark', ${theme === 'dark'}); return true })()`)
  const deterministicMeta = await evaluate(`(${installCausalProbe.toString()})(${JSON.stringify({ limits: LIMITS, observe })})`)
  save('deterministic-instrument.json', deterministicMeta)
  if (deterministicMeta.invalid || JSON.stringify(deterministicMeta.methodSources) !== JSON.stringify(meta.methodSources)) throw Error('instrument-invalid: fresh engine unknown/implementation changed between runs')
  result.deterministic = await evaluate('window.__CCP.begin()')
  save('deterministic-start.json', result.deterministic)
  writeFileSync(join(out, 'birth-events.jsonl'), '')
  writeFileSync(join(out, 'motion.jsonl'), '')
  const motion = []; let snapshotId = 0, final
  for (let batches = 0; batches < 2000; batches++) {
    const batch = await evaluate('window.__CCP.stepBatch(60)')
    if (batch.events.length) appendFileSync(join(out, 'birth-events.jsonl'), batch.events.map(e => JSON.stringify(e)).join('\n') + '\n')
    if (batch.rows.length) { appendFileSync(join(out, 'motion.jsonl'), batch.rows.map(e => JSON.stringify(e)).join('\n') + '\n'); motion.push(...batch.rows) }
    if (batch.snapshot) {
      const id = String(++snapshotId).padStart(3, '0'), snap = batch.snapshot
      const rawFile = 'frame-' + id + '.json.gz', imageFile = 'frame-' + id + '.png'
      writeFileSync(join(out, rawFile), gzipSync(JSON.stringify(snap), { level: 3 }))
      writeFileSync(join(out, imageFile), Buffer.from(await cdp.shot(), 'base64'))
      const observation = { ...snap.summary, rawFile, imageFile }
      result.observations.push(observation)
      console.log(`帧${id} ${observation.direction} ${observation.labels.map(t => t.label).join('/')} actual=${observation.phase}:${observation.progress.toFixed(5)} P95=${observation.allVisible.p95?.toFixed(4)}u >3u=${observation.allVisible.far3}`)
    }
    if (batch.done) { final = batch.final; break }
  }
  if (!final) throw Error('instrument-invalid: sampling did not complete')
  result.deterministic.final = final
  const coalesces = final.checks.filter(c => c.criterion === 'C1-coalesce')
  if (coalesces.length !== 2 || final.missingTargets.length) verdict('C1-coverage', 'instrument-invalid', { coalesces: coalesces.length, missing: final.missingTargets })
  for (const check of final.checks) verdict(check.criterion, compactVerdict(check) ? 'pass' : 'fail', check)
  result.phaseBoundaries = final.transitions.filter(t => t.clock >= result.deterministic.firstLeg * 12 + .3)
    .map(t => {
      const measurement = analyzeMotion(motion, t.clock, LIMITS.dt, t.to)
      measurement.status = 'manual-review:phase-specific-no-generic-zero-speed-rule'
      return { transition: t, measurement }
    })
  result.growthSeries = result.observations.filter(o => o.labels.some(l => l.label.startsWith('departure+')))
    .map(o => ({ labels: o.labels, direction: o.direction, allVisible: o.allVisible, emittedVisible: o.emittedVisible, retainedMorph: o.retainedMorph }))
  const life = final.lifecycle
  verdict('C1-pre-departure-tail', result.instrument.poolSeparation === 'legacy-unpartitioned' ? 'manual-review' : life.preDepartureFarTailFrames ? 'fail' : 'pass',
    { frames: life.preDepartureFarTailFrames, maximum: life.preDepartureFarTailMaximum, note: '旧混池早期的大logo点不能当独立远尾；旧基线由收拢终态/重锁定否决。' })
  verdict('C1-birth-causality', life.premature || life.legacyRelatches ? 'fail' : life.unobserved || !life.births ? 'instrument-invalid' : 'pass', life)
  verdict('C1-birth-position', life.bornFar ? 'fail' : life.births ? 'pass' : 'instrument-invalid', { births: life.births, firstObservedBirthFartherThan1_5u: life.bornFar, resolution: LIMITS.dt, note: '真实出生首个integrate最终位置；非理想birthPosition。超过半径需核查首帧积分漂移。' })
  result.motion = final.boundaryClocks.map(boundary => analyzeMotion(motion, boundary, LIMITS.dt))
  for (const m of result.motion) verdict('C2-scatter-travel', m.status.startsWith('fail:') ? 'fail' : m.status === 'instrument-invalid' ? m.status : 'manual-review', m)
  const holds = []
  for (let i = 0; i < final.transitions.length; i++) {
    const t = final.transitions[i]
    if (t.to === 'hold') { const end = final.transitions.slice(i + 1).find(v => v.from === 'hold'); if (end) holds.push({ leg: t.leg, seconds: end.clock - t.clock }) }
  }
  verdict('C2-hold-3s', holds.length < 2 ? 'instrument-invalid' : holds.some(t => Math.abs(t.seconds - 3) > LIMITS.dt + 1e-7) ? 'fail' : 'pass', holds)
  verdict('C3-shape-and-growth', 'manual-review', { snapshots: snapshotId, note: '完整页面实际合成器截图；0/.1/.3/.8s尾长和两方向已保存。此工具不伪造隔离画面或完整视频；父助手须视觉验收。' })
  verdict('self-check', self.pass && final.readbackNegativeControl.intentional13uTailFails ? 'pass' : 'instrument-invalid', final.readbackNegativeControl)
  const invalid = result.verdicts.some(v => v.status === 'instrument-invalid'), failed = result.verdicts.some(v => v.status === 'fail')
  result.exitCode = invalid ? 2 : failed ? 1 : 0
  result.status = invalid ? 'instrument-invalid' : failed ? 'FAIL' : 'numeric-pass-manual-review-required'
  await cdp.send('Browser.close').catch(() => {})
} catch (error) {
  result.error = String(error.stack || error); result.status = 'instrument-invalid'; result.exitCode = 2
  console.error(result.error)
} finally {
  ws?.close(); chrome?.kill()
  result.finished = new Date().toISOString()
  save('result.json', result)
  writeFileSync(join(out, 'exit-code.txt'), String(result.exitCode) + '\n')
  console.log(`裁判 ${result.status}；exit=${result.exitCode}；结果 ${join(out, 'result.json')}`)
  for (const v of result.verdicts.filter(v => v.status === 'fail')) console.log(v.criterion + ': ' + JSON.stringify(v.evidence).slice(0, 550))
  process.exitCode = result.exitCode
}
