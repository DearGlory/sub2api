/**
 * Live framing instrument controls. No engine/rAF stop.
 * node tools/framing-isolation-selfcheck.mjs --url=http://127.0.0.1:5210/home
 *   --port=10161 --out=E:/path/to/evidence
 * Requires an existing Chrome CDP target. --legacy reproduces the old tail leak.
 * The real probe's snippets, pixel primitive and calibration are evaluated here;
 * expected INSTRUMENT INVALID results are successes only in the fault arms.
 */
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { CDP, connect, sleep } from './tail-probe-lib/cdp.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(s => {
  const [key, ...value] = s.replace(/^--/, '').split('=')
  return [key, value.join('=') || true]
}))
const out = resolve(args.out)
mkdirSync(out, { recursive: true })
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'framing-probe.mjs'), 'utf8').replace(/\r\n/g, '\n')
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
const sandbox = { Buffer, zlib: await import('node:zlib'), sleep, measurements: {}, checks: [],
  record: (criterion, name, pass, detail) => sandbox.checks.push({ criterion, name, pass, detail }),
  instrumentInvalid: reason => { throw new Error('INSTRUMENT INVALID: ' + reason) },
}
vm.createContext(sandbox)
vm.runInContext(section('function decodePng(', '// ---------------------------------------------------------------------------\n// Page-side snippets') +
  section('const ISOLATE =', '/**\n * The exclusion mask') +
  section('const MARKER =', '/**\n * Project the cloud') +
  section('async function calibrate(cdp)', '// ---------------------------------------------------------------------------\n// CRITERION 3') +
  '\nthis.api = { decodePng, toLum, litBbox, ISOLATE, RESTORE, MARKER, SET_VIS, withSceneVisibility, calibrate };', sandbox)
const api = sandbox.api
const ws = new WebSocket(await connect(Number(args.port || 10161)))
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
const cdp = new CDP(ws)
const evaluate = async expression => {
  const value = await cdp.eval(expression)
  assert.ok(!value?.__error && !value?.error, JSON.stringify(value))
  return value
}
const rows = []
const capture = async (name, expected = null) => {
  await sleep(180)
  const png = Buffer.from(await cdp.shot(), 'base64')
  writeFileSync(join(out, name + '.png'), png)
  const img = api.decodePng(png), lum = api.toLum(img)
  const bbox = api.litBbox(lum, img.w, img.h, expected ? 128 : 1)
  const error = expected ? Math.max(...['x0', 'y0', 'w', 'h'].map(k => Math.abs(bbox[k] - expected[k]))) : null
  const state = await evaluate(`(() => { const e=window.__SUB2API_PARTICLE_ENGINE__; return {phase:window.__SUB2API_PARTICLE_STATS__.phase,camZ:e.debugScene.camera.position.z,points:e.debugScene.points.visible,tail:e.tailPoints?.visible ?? null,stars:e.debugScene.scene.getObjectByName('starfield').visible}; })()`)
  const row = { name, bbox, error, state }; rows.push(row); console.log(JSON.stringify(row)); return row
}
try {
  await cdp.send('Page.enable')
  await cdp.send('Page.navigate', { url: args.url || 'http://127.0.0.1:5210/home' })
  await evaluate(`new Promise((resolve,reject)=>{ const end=performance.now()+30000; const tick=()=>{ if(window.__SUB2API_PARTICLE_ENGINE__) return resolve(true); if(performance.now()>end) return reject(new Error('engine absent')); requestAnimationFrame(tick); }; tick(); })`)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await evaluate(api.ISOLATE)
  await evaluate(`new Promise((resolve,reject)=>{ const end=performance.now()+30000; const tick=()=>{ const s=window.__SUB2API_PARTICLE_STATS__; if(s?.phase==='travel') return resolve(true); if(performance.now()>end) return reject(new Error('travel absent')); requestAnimationFrame(tick); }; tick(); })`)
  await sleep(500)
  if (args.legacy) {
    await evaluate(`(() => { const e=window.__SUB2API_PARTICLE_ENGINE__; e.debugScene.points.visible=false; e.debugScene.scene.getObjectByName('starfield').visible=false; return true; })()`)
    const dirty = await capture('legacy-negative')
    assert.ok(dirty.bbox.lit > 0, 'legacy control must reproduce contamination')
    await evaluate(api.MARKER(37, 53, 199, 61, true))
    const marker = await capture('legacy-marker', { x0: 37, y0: 53, w: 199, h: 61 })
    assert.ok(marker.error > 2, 'legacy marker must fail unchanged tolerance')
    await evaluate(`(() => { const t=window.__SUB2API_PARTICLE_ENGINE__.tailPoints; window.__controlTailVisible=t.visible; t.visible=false; return true; })()`)
    const fixed = await capture('tail-hidden-marker', { x0: 37, y0: 53, w: 199, h: 61 })
    assert.equal(fixed.error, 0)
    await evaluate(api.MARKER(0, 0, 0, 0, false))
    assert.equal((await capture('tail-hidden-negative')).bbox.lit, 0)
  } else {
    // Exercise the real calibration, including its fail-closed decision branches.
    let fault = null
    sandbox.shoot = async (_cdp, name) => {
      if (fault === 'pollution') await evaluate(`(() => {
        let d=document.getElementById('framing-control-pollution');
        if(!d) { d=document.createElement('div'); d.id='framing-control-pollution'; document.body.appendChild(d); }
        d.style.cssText='position:fixed;left:700px;top:400px;width:20px;height:20px;background:white;visibility:visible!important;z-index:2147483647';
        return true;
      })()`)
      const png = Buffer.from(await cdp.shot(), 'base64')
      if (name) writeFileSync(join(out, (fault || 'clean') + '-' + name), png)
      const img = api.decodePng(png)
      return { img, lum: api.toLum(img) }
    }
    await api.calibrate(cdp)
    assert.ok(sandbox.checks.every(c => c.pass === true), 'clean calibration must pass')
    const calibrationArms = [{ arm: 'clean', checks: [...sandbox.checks] }]
    for (const arm of ['pollution', 'wrong-bbox']) {
      sandbox.checks.length = 0
      fault = arm
      if (arm === 'wrong-bbox') vm.runInContext(`const originalLitBbox = litBbox; litBbox = (...a) => { const b=originalLitBbox(...a); return b.lit ? {...b, w:b.w+9} : b; };`, sandbox)
      await assert.rejects(() => api.calibrate(cdp), /INSTRUMENT INVALID/)
      assert.ok(sandbox.checks.some(c => c.name === (arm === 'pollution' ? 'negative-control black' : 'marker bbox accuracy') && c.pass === false))
      assert.equal(await evaluate(`!!window.__FRAMING_VIS_GATE__`), false, 'failed calibration must release gate')
      calibrationArms.push({ arm, checks: [...sandbox.checks] })
      await evaluate(`(() => { document.getElementById('framing-control-pollution')?.remove(); return true; })()`)
    }
    fault = null
    vm.runInContext('litBbox = originalLitBbox;', sandbox)

    const assertRestored = async () => assert.equal(await evaluate(`(() => {
      const e=window.__SUB2API_PARTICLE_ENGINE__;
      return !window.__FRAMING_VIS_GATE__ && [e.debugScene.points,e.tailPoints,e.debugScene.scene.getObjectByName('starfield')].filter(Boolean).every(o => 'value' in Object.getOwnPropertyDescriptor(o,'visible'));
    })()`), true)
    await assert.rejects(() => api.withSceneVisibility(cdp, false, false, async () => { throw new Error('capture failure'); }), /capture failure/)
    await assertRestored()
    await api.withSceneVisibility(cdp, false, false, async () => {
      // Emulate a phase writing visibility on every rAF. The gate must win while
      // remembering the latest engine request for restoration.
      const start = await evaluate(`(() => {
        const e=window.__SUB2API_PARTICLE_ENGINE__;
        window.__controlFrames=0; window.__controlPhases=[]; window.__controlWrite=true;
        const tick=()=>{ if(!window.__controlWrite) return; window.__controlFrames++;
          const phase=window.__SUB2API_PARTICLE_STATS__.phase;
          if(!window.__controlPhases.includes(phase)) window.__controlPhases.push(phase);
          for(const o of [e.debugScene.points,e.tailPoints,e.debugScene.scene.getObjectByName('starfield')].filter(Boolean)) o.visible=true;
          requestAnimationFrame(tick);
        }; requestAnimationFrame(tick); return e.debugScene.camera.position.z;
      })()`)
      assert.equal((await capture('phase-start-black')).bbox.lit, 0)
      await evaluate(`new Promise((resolve,reject)=>{ const end=performance.now()+16000; const tick=()=>{ if(window.__controlPhases.length>=3) return resolve(true); if(performance.now()>end) return reject(new Error('phases stalled')); requestAnimationFrame(tick); }; tick(); })`)
      assert.equal((await capture('phase-end-black')).bbox.lit, 0)
      for (const r of [{x:0,y:0,w:120,h:90},{x:240,y:180,w:300,h:200},{x:37,y:53,w:199,h:61}]) {
        await evaluate(api.MARKER(r.x,r.y,r.w,r.h,true))
        assert.equal((await capture('live-marker-' + r.w, {x0:r.x,y0:r.y,w:r.w,h:r.h})).error, 0)
      }
      await evaluate(api.MARKER(0,0,0,0,false))
      assert.equal((await capture('marker-removed-black')).bbox.lit, 0)
      const liveness = await evaluate(`(() => { window.__controlWrite=false; const e=window.__SUB2API_PARTICLE_ENGINE__; return {frames:window.__controlFrames,phases:window.__controlPhases,camZ:e.debugScene.camera.position.z}; })()`)
      assert.ok(liveness.frames > 0 && liveness.camZ > start)
      rows.push({ name: 'rAF-and-phase-liveness', ...liveness })
    })
    await assertRestored()
    for (const [name, points, stars] of [['glyph-only',true,false],['star-only',false,true]]) {
      await api.withSceneVisibility(cdp, points, stars, async () => {
        const state = await evaluate(`(() => { const e=window.__SUB2API_PARTICLE_ENGINE__; if(e.tailPoints) e.tailPoints.visible=true; return {points:e.debugScene.points.visible,tail:e.tailPoints?.visible ?? null,stars:e.debugScene.scene.getObjectByName('starfield').visible}; })()`)
        assert.equal(state.points, points); assert.equal(state.stars, stars)
        assert.ok(state.tail === null || state.tail === false)
        const shot = await capture(name)
        assert.ok(shot.bbox.lit > 0)
      })
      await assertRestored()
    }
    // Restoring must preserve false as well as true, including a phase's last write.
    await api.withSceneVisibility(cdp, false, false, async () => {
      await evaluate(`(() => { window.__SUB2API_PARTICLE_ENGINE__.debugScene.points.visible=false; return true; })()`)
    })
    assert.equal(await evaluate('window.__SUB2API_PARTICLE_ENGINE__.debugScene.points.visible'), false)
    await evaluate('window.__SUB2API_PARTICLE_ENGINE__.debugScene.points.visible=true')
    rows.push({ name: 'calibration-failure-controls', arms: calibrationArms })
  }
  writeFileSync(join(out, 'control.json'), JSON.stringify({ url: args.url, legacy: !!args.legacy, rows, verdict: 'expected controls confirmed' }, null, 2))
} finally {
  await evaluate(`(() => { window.__controlWrite=false; document.getElementById('framing-control-pollution')?.remove(); return true; })()`)
  await evaluate(api.SET_VIS(true, true))
  await evaluate(`(() => { const e=window.__SUB2API_PARTICLE_ENGINE__; if(e?.tailPoints && window.__controlTailVisible !== undefined) e.tailPoints.visible=window.__controlTailVisible; if(${!!args.legacy} && e) { e.debugScene.points.visible=true; e.debugScene.scene.getObjectByName('starfield').visible=true; } delete window.__controlTailVisible; return true; })()`)
  await evaluate(api.RESTORE)
  ws.close()
}
