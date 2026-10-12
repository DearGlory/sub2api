// Serialized into the dev page. No implementation import, replacement curve or state writes.
export function installCausalProbe(cfg) {
  const e = window.__SUB2API_PARTICLE_ENGINE__, L = cfg.limits
  if (!e) throw Error('instrument-invalid: missing __SUB2API_PARTICLE_ENGINE__')
  const get = path => path.split('.').reduce((o, k) => o?.[k], e)
  const fail = s => { throw Error('instrument-invalid: ' + s) }
  const dist = a => {
    if (!a.length) return { n: 0, min: null, p50: null, p95: null, max: null }
    a.sort((x, y) => x - y)
    return { n: a.length, min: a[0], p50: a[Math.floor((a.length - 1) * .5)], p95: a[Math.floor((a.length - 1) * .95)], max: a.at(-1) }
  }
  const state = () => e.choreography.state
  const phaseStart = { travel: 0, gather: L.leg, hold: L.leg + L.gather, scatter: L.leg + L.gather + L.hold }
  const duration = { travel: L.leg, gather: L.gather, hold: L.hold, scatter: L.scatter }
  const cycle = L.leg + L.gather + L.hold + L.scatter
  const clock = () => { const s = state(); return s.legIndex * cycle + phaseStart[s.phase] + s.phaseProgress * duration[s.phase] }
  const departure = leg => leg * cycle + phaseStart.scatter + L.scatter * L.coalesce
  const currentDeparture = () => departure(state().phase === 'scatter' ? state().legIndex : state().legIndex - 1)
  const allPoints = [], inventory = []
  e.scene.traverse(o => {
    if (!o.isPoints) return
    allPoints.push(o)
    inventory.push({ uuid: o.uuid, name: o.name, count: o.geometry?.getAttribute('position')?.count,
      attributes: Object.fromEntries(Object.entries(o.geometry?.attributes || {}).map(([k, a]) => [k, { itemSize: a.itemSize, count: a.count }])),
      ownerPaths: Object.keys(e).filter(k => e[k] === o), visible: o.visible,
      material: o.material?.type, opacity: o.material?.opacity })
  })
  const meta = { inventory, engineKeys: Object.keys(e), scratchKeys: Object.keys(e.scratch || {}),
    methodSources: Object.fromEntries(['tick', 'advanceClock', 'writeEmissionTable', 'integrate', 'upload'].map(k => [k, String(e[k])])),
    stateHeadPaths: ['choreography.state.headX', 'choreography.state.headY', 'choreography.state.headZ'],
    headSource: null,
    url: location.href, timeOrigin: performance.timeOrigin, light: e.light, reducedMotion: e.reducedMotion,
    viewport: [innerWidth, innerHeight], userAgent: navigator.userAgent }
  let contract = cfg.observe
  if (!contract) {
    const src = String(e.integrate)
    const frozenLegacy = /phase\s*===\s*["']travel["']\s*\?\s*frameStep\s*\/\s*60\s*:\s*0/.test(src)
      && /tailReady\.fill\(0\)/.test(src) && /shapeFrom/.test(src)
    if (frozenLegacy && e.scratch?.positions === e.points?.geometry?.getAttribute('position')?.array) {
      const count = e.points.geometry.getAttribute('position').count, coreEnd = Math.floor(count * .18)
      contract = { kind: 'legacy-unpartitioned-logo-to-tail', main: 'points', background: ['starfield.object'],
        head: ['scratch.tailTable.xyz.0', 'scratch.tailTable.xyz.1', 'scratch.tailTable.xyz.2'],
        headDescription: 'integrate directly consumes table.xyz[0..2]; Float32 actual emitter source, separate from state double precision path',
        pools: [{ id: 'main', points: 'points', start: 0, end: count, core: [0, coreEnd], mode: 'legacy-frozen',
          age: 'scratch.tailAge', life: 'scratch.tailLife', active: 'scratch.tailReady', birthPosition: 'scratch.tailBirthPosition' }] }
    }
  }
  window.__CCP = { meta }
  if (!contract) { meta.invalid = '未知实现：需 --observe 显式最终geometry/核心/生命周期映射'; return meta }
  meta.contract = contract
  const main = get(contract.main || 'points'), background = new Set()
  for (const path of contract.background || []) {
    const o = get(path)
    if (!o?.traverse) fail('background path ' + path)
    o.traverse(x => background.add(x))
  }
  const covered = new Map(), pools = []
  for (const p of contract.pools || []) {
    const o = get(p.points), geometry = o?.geometry, pos = geometry?.getAttribute('position'), color = geometry?.getAttribute('color')
    if (!o?.isPoints || !allPoints.includes(o) || !pos || pos.itemSize !== 3 || !color || color.itemSize !== 4 || pos.count !== color.count || geometry.index) fail('Points requires nonindexed actual position3/color4: ' + p.points)
    if (!o.material?.isPointsMaterial || o.material.onBeforeCompile?.toString().includes('shader.vertexShader')) fail('custom shader displacement/alpha requires dedicated audited adapter')
    const end = p.end === 'all' ? pos.count : p.end
    if (!Number.isInteger(p.start) || !Number.isInteger(end) || p.start < 0 || end <= p.start || end > pos.count) fail('pool range ' + p.id)
    const mask = covered.get(o) || new Uint8Array(pos.count)
    for (let i = p.start; i < end; i++) { if (mask[i]) fail('overlapping pool ranges'); mask[i] = 1 }
    covered.set(o, mask)
    const life = p.mode === 'morph' ? null : get(p.life), age = p.mode === 'morph' ? null : get(p.age)
    if (!['morph', 'emitted', 'legacy-frozen'].includes(p.mode)) fail('unknown lifecycle mode')
    if (p.mode !== 'morph' && (!life || !age || life.length < end || age.length < end || (!p.active && !p.generation))) fail('lifecycle arrays incomplete: ' + p.id)
    for (const key of ['active', 'generation', 'bornAt', 'birthPosition']) if (p[key]) {
      const array = get(p[key])
      if (!ArrayBuffer.isView(array) || array.length < end * (key === 'birthPosition' ? 3 : 1)) fail('missing/short lifecycle array ' + p[key])
    }
    if (p.bornAt && !['clock', 'integrate', 'departure'].includes(p.timeBasis)) fail('bornAt requires timeBasis')
    if (p.core && (!Number.isInteger(p.core[0]) || !Number.isInteger(p.core[1]) || p.core[0] < p.start || p.core[1] > end || p.core[1] <= p.core[0])) fail('core range invalid')
    pools.push({ ...p, end, o, pos, color, age, life, activeArray: p.active ? get(p.active) : null,
      genArray: p.generation ? get(p.generation) : null, bornArray: p.bornAt ? get(p.bornAt) : null,
      birthPosArray: p.birthPosition ? get(p.birthPosition) : null, prev: new Array(end),
      actualBorn: new Float64Array(end).fill(NaN), generationObserved: new Uint32Array(end), matrix: null })
  }
  const unknown = allPoints.filter(o => !background.has(o) && !covered.has(o))
  const gaps = [...covered].filter(([, mask]) => mask.some(v => !v))
  if (unknown.length || gaps.length || !covered.has(main) || !pools.some(p => p.core)) {
    meta.invalid = '未覆盖Points/主geometry/核心范围；禁止只测旧geometry'
    meta.unknownPoints = unknown.map(o => o.uuid); meta.gaps = gaps.map(([o]) => o.uuid)
    return meta
  }
  meta.poolSeparation = pools.some(p => p.mode === 'emitted') ?
    (new Set(pools.map(p => p.o)).size > 1 ? 'independent-tail-Points' : 'partitioned-buffer') : 'legacy-unpartitioned'
  if (!Array.isArray(contract.head) || contract.head.length !== 3 || !contract.headDescription) fail('explicit actual head paths + headDescription required; no theoretical fallback')
  meta.headSource = contract.head
  const head = () => contract.head.map(p => Number(get(p)))
  const stateHead = () => meta.stateHeadPaths.map(p => Number(get(p)))
  if (!head().every(Number.isFinite) || !stateHead().every(Number.isFinite)) fail('actual/state head source missing')
  for (const k of ['stop', 'advanceClock', 'writeEmissionTable', 'integrate', 'upload', 'advanceCamera']) if (typeof e[k] !== 'function') fail('missing true update method ' + k)
  if (e.reducedMotion) fail('reduced motion active; normal motion probe cannot certify')
  const visible = o => { for (let a = o; a; a = a.parent) if (!a.visible) return false; return true }
  function transform(p, xyz) {
    if (!p.matrix) return xyz
    const m = p.matrix.elements, [x, y, z] = xyz
    return [m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14]]
  }
  function read(p, i) {
    const xyz = transform(p, [p.pos.getX(i), p.pos.getY(i), p.pos.getZ(i)])
    const range = p.o.geometry.drawRange, drawn = i >= range.start && i < range.start + range.count
    const a = p.color.getW(i) * p.o.material.opacity * (drawn && visible(p.o) ? 1 : 0)
    if (![...xyz, a].every(Number.isFinite)) fail('nonfinite final geometry')
    const life = p.life?.[i] ?? 0, age = p.age?.[i] ?? null
    return { xyz, a, rawAlpha: p.color.getW(i), age, active: life > 0 && (p.activeArray ? !!p.activeArray[i] : age >= 0 && age < life),
      gen: p.genArray?.[i] ?? null, stamp: p.bornArray?.[i] ?? null }
  }
  function matrices() {
    e.scene.updateMatrixWorld(true)
    e.camera.updateMatrixWorld(true)
    for (const p of pools) p.matrix = p.o === main ? null : main.matrixWorld.clone().invert().multiply(p.o.matrixWorld)
  }
  function livePerf(seconds) {
    return new Promise(resolve => {
      const frames = [], longtasks = [], resources = [], visibility = [], start = performance.now()
      let previous = null, stopped = false
      const observers = []
      for (const type of ['longtask', 'resource']) {
        if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue
        const observer = new PerformanceObserver(list => {
          for (const t of list.getEntries()) (type === 'longtask' ? longtasks : resources).push({ start: t.startTime, duration: t.duration,
            type: t.entryType, name: type === 'resource' ? new URL(t.name, location.href).pathname : t.name,
            attribution: type === 'longtask' ? Array.from(t.attribution || [], a => ({ name: a.name, containerType: a.containerType })) : undefined })
        })
        observer.observe({ type, buffered: false }); observers.push(observer)
      }
      const visibilityHandler = () => visibility.push({ now: performance.now(), state: document.visibilityState })
      document.addEventListener('visibilitychange', visibilityHandler); visibilityHandler()
      const end = () => {
        if (stopped) return
        stopped = true; observers.forEach(o => o.disconnect()); document.removeEventListener('visibilitychange', visibilityHandler)
        resolve({ frames, longtasks, resources, visibility, start, end: performance.now(),
          longtaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask'),
          originUnchanged: performance.timeOrigin === meta.timeOrigin, engineUnchanged: window.__SUB2API_PARTICLE_ENGINE__ === e,
          running: e.running, navigation: performance.getEntriesByType('navigation').map(t => ({ type: t.type, start: t.startTime, duration: t.duration })),
          note: '独立正常run，无截图/geometry批量读回/手动integrate。observerCost仅是探针回调自耗时，不含浏览器调度。' })
      }
      function tick(now) {
        if (stopped) return
        const costStart = performance.now(), s = state(), progress = s.phaseProgress
        const windowName = s.phase === 'scatter' ? (progress < L.coalesce ? 'scatter-coalesce' : 'scatter-departure') :
          s.phase === 'travel' && progress * L.leg <= .2 ? 'travel-first-0.2s' : s.phase
        const row = { now, dt: previous === null ? 0 : now - previous, phase: s.phase, progress, leg: s.legIndex,
          window: windowName, observerCost: 0, hidden: document.hidden }
        if (previous !== null) frames.push(row)
        previous = now; row.observerCost = performance.now() - costStart
        if (now - start >= seconds * 1000) end(); else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick); setTimeout(end, seconds * 1000 + 2000)
    })
  }
  const world = xyz => transform({ matrix: main.matrixWorld }, xyz)
  const projected = xyz => {
    if (!xyz) return null
    const v = e.camera.position.clone().set(...world(xyz)).project(e.camera)
    return [v.x, v.y, v.z]
  }
  let begun = false, firstLeg, endClock, integrateTime, n = 0, targets = [], ti = 0, previousPhase = null
  const checks = [], transitions = [], lifecycle = { births: 0, premature: 0, legacyRelatches: 0, recycled: 0, unobserved: 0, bornFar: 0, leftCensoredAtStart: 0, preDepartureFarTailFrames: 0, preDepartureFarTailMaximum: 0 }
  let lastState = null
  function begin() {
    e.stop(); matrices()
    firstLeg = state().legIndex + 1
    endClock = (firstLeg + 2) * cycle + .85
    if (Math.abs(clock()) > 1e-10) fail('deterministic run requires fresh engine at clock zero')
    integrateTime = 0
    for (let leg = firstLeg; leg < firstLeg + 2; leg++) {
      const add = (clock, label) => targets.push({ clock, label, leg })
      for (const progress of [0, .25, .5, .62, .8, .95, 1]) add(leg * cycle + phaseStart.scatter + progress * L.scatter, 'scatter-' + progress)
      for (const progress of [0, .03, .1]) add((leg + 1) * cycle + progress * L.leg, 'travel-' + progress)
      for (const elapsed of [0, .1, .3, .8]) add(departure(leg) + elapsed, 'departure+' + elapsed)
      for (let ms = 0; ms <= 1900; ms += 100) add(leg * cycle + phaseStart.scatter + ms / 1000, 'sequence+' + ms + 'ms')
    }
    targets.sort((a, b) => a.clock - b.clock)
    for (const p of pools) for (let i = p.start; i < p.end; i++) {
      p.prev[i] = read(p, i); lifecycle.leftCensoredAtStart += +p.prev[i].active
    }
    previousPhase = state().phase; begun = true
    return { firstLeg, endClock, startClock: clock(), dt: L.dt, targetCount: targets.length,
      chain: 'advanceClock -> writeEmissionTable -> integrate -> upload -> advanceCamera; renderer at snapshot only; no state seek/reset',
      fixedStep: true, approximateEndpoint: 'phase 1 is sampled at final actual frame before crossing; phase 0 is first frame after crossing; errors <=dt' }
  }
  function capture(labels) {
    const s = state(), h = head(), all = [], retained = [], tail = [], summaries = [], raw = []
    for (const p of pools) {
      const distances = [], ages = [], xyz = [], rgba = [], born = [], active = [], gen = []
      for (let i = p.start; i < p.end; i++) {
        const r = read(p, i), d = Math.hypot(...r.xyz.map((v, j) => v - h[j]))
        const certified = Number.isFinite(p.actualBorn[i]) && p.actualBorn[i] >= currentDeparture() - L.dt
        xyz.push(...r.xyz); rgba.push(p.color.getX(i), p.color.getY(i), p.color.getZ(i), r.rawAlpha)
        born.push(Number.isFinite(p.actualBorn[i]) ? p.actualBorn[i] : null); active.push(+r.active); gen.push(p.generationObserved[i])
        if (r.age !== null) ages.push(r.age)
        if (r.a >= L.alpha) {
          all.push(d); distances.push(d)
          if (p.mode === 'emitted' || (p.mode === 'legacy-frozen' && certified)) tail.push(d)
          if (!certified || p.mode === 'morph') retained.push(d)
        }
      }
      summaries.push({ id: p.id, visible: { ...dist(distances), far3: distances.filter(v => v > L.far).length },
        tailAge: dist([...ages]), agesFrozenDiagnostic: p.mode === 'legacy-frozen', objectMatrixWorld: Array.from(p.o.matrixWorld.elements), materialOpacity: p.o.material.opacity })
      raw.push({ id: p.id, start: p.start, end: p.end, actualPositionsMainLocal: xyz, actualColorsRGBA: rgba,
        tailAge: ages, observedBirthClock: born, active, observedGeneration: gen })
    }
    const summary = { clock: clock(), phase: s.phase, progress: s.phaseProgress, leg: s.legIndex, labels,
      headSource: h, stateHead: stateHead(), actualHeadWorld: world(h), actualHeadNDC: projected(h),
      mainMatrixWorld: Array.from(main.matrixWorld.elements), cameraMatrixWorld: Array.from(e.camera.matrixWorld.elements),
      cameraProjection: Array.from(e.camera.projectionMatrix.elements), fromX: s.fromX, toX: s.toX,
      direction: (s.phase === 'scatter' ? s.fromX - s.toX : s.toX - s.fromX) > 0 ? 'right' : 'left',
      allVisible: { ...dist(all), far3: all.filter(v => v > L.far).length },
      retainedMorph: { ...dist(retained), far3: retained.filter(v => v > L.far).length },
      emittedVisible: { ...dist(tail), far3: tail.filter(v => v > L.far).length }, pools: summaries }
    const compactTarget = labels.some(t => t.label === 'scatter-0.62' || t.label === 'departure+0')
    if (compactTarget) checks.push({ criterion: 'C1-coalesce', ...summary.allVisible, clock: summary.clock, leg: s.legIndex })
    if ((s.phase === 'scatter' && s.phaseProgress >= L.coalesce) || (s.phase === 'travel' && s.phaseProgress <= .1)) {
      checks.push({ criterion: 'C1-retained-morph-after-coalesce', ...summary.retainedMorph, clock: summary.clock, leg: s.legIndex })
    }
    e.renderer.render(e.scene, e.camera)
    return { summary, raw }
  }
  function stepBatch(maxSteps = 60) {
    if (!begun) fail('call begin first')
    const events = [], rows = []
    for (let step = 0; step < maxSteps && clock() < endClock; step++) {
      // A phase=1 request means the last real scatter frame, not an invented state at progress=1.
      if (targets[ti]?.label === 'scatter-1' && targets[ti].clock > clock() && targets[ti].clock <= clock() + L.dt) {
        const labels = [targets[ti++]]
        return { done: false, events, rows, snapshot: capture(labels) }
      }
      const oldMainMatrix = main.matrixWorld.clone()
      const before = clock(); integrateTime += L.dt
      e.advanceClock(L.dt); e.writeEmissionTable(); e.integrate(L.dt * 60, integrateTime); e.upload(); e.advanceCamera(); matrices(); n++
      const s = state(), now = clock(), h = head(), inScope = s.legIndex >= firstLeg
      if (Math.abs(now - before - L.dt) > 1e-7) fail('clock timing differs from frozen timing contract')
      if (window.__SUB2API_PARTICLE_ENGINE__ !== e || e.running) fail('HMR/remount or rAF restarted during deterministic sampling')
      if (s.phase !== previousPhase) { transitions.push({ clock: now, from: previousPhase, to: s.phase, leg: s.legIndex }); previousPhase = s.phase }
      const coreSum = [0, 0, 0], corePlain = [0, 0, 0], coreStep = [0, 0, 0], coreWorldStep = [0, 0, 0]
      let weight = 0, stepWeight = 0, coreCount = 0, preDepartureFarTail = 0
      const displacements = [], relatchAges = []; let worst = null
      for (const p of pools) for (let i = p.start; i < p.end; i++) {
        const r = read(p, i), old = p.prev[i], oldBorn = p.actualBorn[i], isCore = p.core && i >= p.core[0] && i < p.core[1]
        if (inScope && p.mode === 'emitted' && s.phase === 'scatter' && s.phaseProgress < L.coalesce && r.a >= L.alpha && Math.hypot(...r.xyz.map((v, j) => v - h[j])) > L.far) preDepartureFarTail++
        const legacyRelatch = p.mode === 'legacy-frozen' && s.phase === 'scatter' && lastState?.phase !== 'scatter' && p.life[i] > 0
        const changed = r.active && (!old.active || (r.gen !== null && r.gen !== old.gen) ||
          (r.stamp !== null && r.stamp !== old.stamp) || r.age < old.age - 1e-6)
        if (legacyRelatch || changed) {
          p.generationObserved[i]++
          const trueEmission = !legacyRelatch && r.age >= 0 && r.age <= L.dt + 1e-5
          const inferredBorn = trueEmission ? now - r.age : null
          const metadataBorn = r.stamp === null ? null : p.timeBasis === 'clock' ? r.stamp : p.timeBasis === 'integrate' ? now + r.stamp - integrateTime : currentDeparture() + r.stamp
          p.actualBorn[i] = trueEmission ? inferredBorn : NaN
          const premature = trueEmission && (inferredBorn < currentDeparture() - L.dt - 1e-6 || (metadataBorn !== null && metadataBorn < currentDeparture() - L.dt - 1e-6))
          const d = Math.hypot(...r.xyz.map((v, j) => v - h[j]))
          if (inScope) {
            lifecycle.legacyRelatches += +legacyRelatch; lifecycle.births += +trueEmission; lifecycle.premature += +premature
            lifecycle.recycled += +(old.active && changed); lifecycle.unobserved += +(!legacyRelatch && !trueEmission)
            lifecycle.bornFar += +(trueEmission && d > L.p95)
            if (legacyRelatch) relatchAges.push(r.age)
            events.push({ type: legacyRelatch ? 'legacy-relatch-NOT-birth' : trueEmission ? 'birth' : 'unresolved-lifecycle',
              pool: p.id, particle: i, generation: p.generationObserved[i], clock: now, phase: s.phase, progress: s.phaseProgress,
              departure: currentDeparture(), observedBirthInterval: trueEmission ? [now - L.dt, now] : null,
              inferredBirthClock: inferredBorn, metadataBirthClock: metadataBorn, age: r.age, premature,
              actualPosition: r.xyz, actualAlpha: r.a, headSource: h, distanceToHead: d,
              declaredBirthPosition: p.birthPosArray ? Array.from(p.birthPosArray.slice(i * 3, i * 3 + 3)) : null,
              previous: { position: old.xyz, alpha: old.a, age: old.age },
              recycled: !!(old.active && changed), disappearance: old.a < L.alpha ? 'already-invisible' : 'visible-before-recycle',
              reappearance: r.a >= L.alpha ? 'visible-now' : 'not-yet-visible' })
          }
        }
        if (inScope && (old.a >= L.alpha && r.a < L.alpha || old.active && !r.active || changed) && Number.isFinite(oldBorn)) events.push({ type: 'disappearance', pool: p.id, particle: i, clock: now, birthClock: oldBorn, previousAlpha: old.a, alpha: r.a, previousPosition: old.xyz, position: r.xyz, died: old.active && !r.active, recycled: changed })
        if (!r.active) p.actualBorn[i] = NaN
        if (inScope && old.a < L.alpha && r.a >= L.alpha && Number.isFinite(p.actualBorn[i])) events.push({ type: 'reappearance', pool: p.id, particle: i, clock: now, birthClock: p.actualBorn[i], alpha: r.a, position: r.xyz })
        // Only genuine same-generation emitted points enter continuity. Recycling never creates a teleport statistic.
        if (inScope && !changed && !legacyRelatch && r.active && old.active && Number.isFinite(p.actualBorn[i]) && old.a >= L.alpha && r.a >= L.alpha && (s.phase === 'travel' || s.phase === 'scatter')) {
          const d = Math.hypot(...r.xyz.map((v, j) => v - old.xyz[j])); displacements.push(d)
          if (!worst || d > worst.distance) worst = { pool: p.id, particle: i, distance: d, previous: old.xyz, current: r.xyz, alpha: [old.a, r.a] }
        }
        if (isCore) {
          coreCount++; r.xyz.forEach((v, j) => { corePlain[j] += v; coreSum[j] += v * r.a })
          weight += r.a
          if (old.a >= L.alpha && r.a >= L.alpha) {
            stepWeight += old.a
            r.xyz.forEach((v, j) => { coreStep[j] += (v - old.xyz[j]) * old.a })
            const oldWorld = transform({ matrix: oldMainMatrix }, old.xyz), newWorld = world(r.xyz)
            newWorld.forEach((v, j) => { coreWorldStep[j] += (v - oldWorld[j]) * old.a })
          }
        }
        p.prev[i] = r
      }
      if (inScope) {
        lifecycle.preDepartureFarTailFrames += +(preDepartureFarTail > 0)
        lifecycle.preDepartureFarTailMaximum = Math.max(lifecycle.preDepartureFarTailMaximum, preDepartureFarTail)
        const row = { clock: now, phase: s.phase, progress: s.phaseProgress, leg: s.legIndex,
          headSource: h, stateHead: stateHead(), actualHeadWorld: world(h), actualHeadNDC: projected(h),
          coreWeightedCentroid: weight ? coreSum.map(v => v / weight) : null,
          coreWeightedCentroidNDC: weight ? projected(coreSum.map(v => v / weight)) : null,
          coreUnweightedCentroid: coreCount ? corePlain.map(v => v / coreCount) : null,
          corePositionOnlyStep: stepWeight ? coreStep.map(v => v / stepWeight) : null,
          coreWorldPositionOnlyStep: stepWeight ? coreWorldStep.map(v => v / stepWeight) : null,
          coreAlphaSum: weight, coreCount, actualEmittedContinuity: dist(displacements), worstEmittedStep: worst,
          legacyRelatchAges: relatchAges.length ? dist(relatchAges) : null }
        rows.push(row)
      }
      lastState = { phase: s.phase, leg: s.legIndex }
      const reached = target => {
        if (!target || now < target.clock - 1e-8) return false
        if (target.label === 'scatter-0' || target.label === 'sequence+0ms') return s.phase === 'scatter' && s.legIndex === target.leg
        if (target.label === 'travel-0' || target.label === 'sequence+1100ms') return s.phase === 'travel' && s.legIndex === target.leg + 1
        return true
      }
      if (reached(targets[ti])) {
        const labels = []
        while (reached(targets[ti])) labels.push(targets[ti++])
        return { done: false, events, rows, snapshot: capture(labels) }
      }
    }
    const done = clock() >= endClock
    return { done, events, rows, final: done ? { steps: n, firstLeg, endClock: clock(), lifecycle, checks, transitions,
      missingTargets: targets.slice(ti), boundaryClocks: [(firstLeg + 1) * cycle, (firstLeg + 2) * cycle],
      readbackNegativeControl: { intentional13uTailFails: (() => { const values = pools[0].pos.array.slice(); values[0] = head()[0] + 13; return Math.abs(values[0] - head()[0]) > L.far })(),
        note: '仅复制实际position buffer注入13u，未修改geometry；速度停顿负控在Node判据层。' } } : undefined }
  }
  window.__CCP = { meta, livePerf, begin, stepBatch }
  return meta
}
