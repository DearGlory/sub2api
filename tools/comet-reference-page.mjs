// Injected only into an isolated diagnostic browser; no product source edits.
export function installReferenceProbe() {
  const e = window.__SPACE_PROBE?.engine
  if (!e || !window.__MATERIAL_PROBE) throw Error('instrument-invalid: missing verified engine adapters')
  const pool = e.scratch.emittedTail, body = e.points, tail = e.tailPoints
  const v = e.scratch.vecA.clone(), xyz = (a, i) => Array.from(a.subarray(i * 3, i * 3 + 3))
  const world = (p, o) => { v.set(...p); o.localToWorld(v); return v.toArray() }
  const screen = p => { v.set(...p).project(e.camera); const r = e.renderer.domElement.getBoundingClientRect(); return [r.x + (v.x + 1) * r.width / 2, r.y + (1 - v.y) * r.height / 2, v.z] }
  const head = () => world([e.choreography.state.headX, e.choreography.state.headY, e.choreography.state.headZ], body)
  const liveVisible = o => { for (let p = o; p; p = p.parent) if (!p.visible) return false; return o.material.visible }
  const plain = x => ArrayBuffer.isView(x) ? Array.from(x) : x?.toArray ? x.toArray() : x
  function gpu(o) {
    const visibility = []; e.scene.traverse(x => { if (x.geometry) { visibility.push([x, x.visible]); x.visible = x === o } })
    try {
      e.renderer.render(e.scene, e.camera)
      const gl = e.renderer.getContext(), pr = e.renderer.properties.get(o.material).currentProgram, program = pr?.program
      if (!program || !gl.getBufferSubData) return { status: 'instrument-invalid', reason: 'no linked program or WebGL2 buffer readback' }
      const attributes = {}, uniforms = {}
      for (const name of ['position', 'color']) {
        const a = o.geometry.getAttribute(name), loc = gl.getAttribLocation(program, name)
        if (!a || loc < 0 || gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_SIZE) !== a.itemSize || gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_TYPE) !== gl.FLOAT) return { status: 'instrument-invalid', reason: 'unmapped GPU attribute ' + name }
        const buf = gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING), old = gl.getParameter(gl.COPY_READ_BUFFER_BINDING), values = new Float32Array(a.array.length)
        try { gl.bindBuffer(gl.COPY_READ_BUFFER, buf); gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, values) } finally { gl.bindBuffer(gl.COPY_READ_BUFFER, old) }
        attributes[name] = { itemSize: a.itemSize, count: a.count, exact: values.every((x, i) => Number.isFinite(x) && x === a.array[i]), values: Array.from(values) }
      }
      for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
        const u = gl.getActiveUniform(program, i)
        if (u.size === 1) uniforms[u.name] = plain(gl.getUniform(program, gl.getUniformLocation(program, u.name)))
      }
      return { status: Object.values(attributes).every(a => a.exact) ? 'observed' : 'instrument-invalid', attributes, uniforms, vertex: gl.getShaderSource(pr.vertexShader), fragment: gl.getShaderSource(pr.fragmentShader) }
    } finally { for (const [x, visible] of visibility) x.visible = visible; e.renderer.render(e.scene, e.camera) }
  }
  function points(o, audit) {
    const p = o.geometry.getAttribute('position'), c = o.geometry.getAttribute('color'), positions = [], projected = []
    for (let i = 0; i < p.count; i++) { const w = world(xyz(p.array, i), o); positions.push(w); projected.push(screen(w)) }
    return { uuid: o.uuid, visible: liveVisible(o), material: { type: o.material.type, opacity: o.material.opacity, size: o.material.size, transparent: o.material.transparent }, positions, projected, color4: Array.from(c.array), gpu: audit ? gpu(o) : { status: 'skip', reason: 'CPU raw frame between GPU audits' } }
  }
  function sample(audit = false) {
    e.scene.updateMatrixWorld(true); e.renderer.render(e.scene, e.camera)
    const s = e.choreography.state, h = head(), meshes = [], geometries = new Set(); let bytes = 0
    e.scene.traverse(o => { if (o.geometry && !geometries.has(o.geometry)) { geometries.add(o.geometry); bytes += Object.values(o.geometry.attributes).reduce((n, a) => n + a.array.byteLength, 0) + (o.geometry.index?.array.byteLength || 0) }
      if (o.isMesh) meshes.push({ uuid: o.uuid, visible: liveVisible(o), triangles: (o.geometry.index?.count || o.geometry.getAttribute('position')?.count || 0) / 3, uniforms: Object.fromEntries(Object.entries(o.material.uniforms || {}).map(([k, u]) => [k, plain(u.value)])), materialType: o.material.type }) })
    const drawCalls = e.renderer.info.render.calls
    return { t: e.dollySeconds, phase: s.phase, q: s.phaseProgress, leg: s.legIndex, head: h, headPixel: screen(h), camera: e.camera.matrixWorld.toArray(), projection: e.camera.projectionMatrix.toArray(), axis: Array.from(e.scratch.tailTable.axis.subarray(0, 3)), body: points(body, audit), tail: { ...points(tail, audit), active: Array.from(pool.active), birthTime: Array.from(pool.birthTime), birthPosition: Array.from(pool.birthPosition), birthVelocity: Array.from(pool.birthVelocity), age: Array.from(pool.age), life: Array.from(pool.life) }, meshes, drawCalls, geometryBytes: bytes }
  }
  const history = { steps: 0, births: [], bins: [], trajectories: [], retirements: [] }, tracked = new Map()
  const stamps = new Float64Array(pool.count).fill(NaN), previousState = new Uint8Array(pool.count)
  async function advance(target) {
    let n = 0
    while (e.dollySeconds < target - 1e-10) {
      const dt = Math.min(1 / 60, target - e.dollySeconds)
      e.advanceClock(dt); e.writeEmissionTable(); e.integrate(Math.min(dt * 60, 2), e.dollySeconds, dt); e.upload(); e.advanceCamera(); e.scene.updateMatrixWorld(true)
      const h = head(), s = e.choreography.state, bin = { t: e.dollySeconds, phase: s.phase, births: 0, speedSum: 0, alpha: 0, alive: 0 }
      for (let i = 0; i < pool.count; i++) {
        if (pool.active[i] === 1) {
          bin.alive++; bin.alpha += pool.colors[i * 4 + 3]
          if (stamps[i] !== pool.birthTime[i] && pool.age[i] <= dt * 1.01) {
            stamps[i] = pool.birthTime[i]; bin.births++
            const birth = { i, stamp: stamps[i], t: e.dollySeconds, head: h, source: world(xyz(pool.birthPosition, i), tail), velocity: xyz(pool.birthVelocity, i), age: pool.age[i], life: pool.life[i], leg: s.legIndex }
            bin.speedSum += Math.hypot(...birth.velocity)
            if (history.births.length < 120000) history.births.push(birth)
            if (tracked.size < 64) tracked.set(i, birth)
          }
          if (tracked.has(i) && n % 6 === 0) history.trajectories.push({ i, stamp: stamps[i], t: e.dollySeconds, age: pool.age[i], position: world(xyz(pool.positions, i), tail), alpha: pool.colors[i * 4 + 3] })
        }
        if (pool.active[i] === 2 && previousState[i] === 1) {
          if (history.retirements.length < 120000) history.retirements.push({ i, stamp: stamps[i], t: e.dollySeconds, age: pool.age[i], life: pool.life[i], alpha: pool.colors[i * 4 + 3], position: world(xyz(pool.positions, i), tail), source: world(xyz(pool.birthPosition, i), tail) })
          tracked.delete(i)
        }
        previousState[i] = pool.active[i]
      }
      history.steps++; history.bins.push(bin)
      if (++n % 120 === 0) await new Promise(r => setTimeout(r, 0))
    }
    e.renderer.render(e.scene, e.camera)
    return { t: e.dollySeconds, steps: n, phase: e.choreography.state.phase }
  }
  let saved = null
  function mutate(kind) {
    if (saved) restore()
    saved = { kind, opacity: tail.material.opacity, positions: tail.geometry.getAttribute('position').array.slice(), mesh: null }
    if (kind === 'alpha0') tail.material.opacity = 0
    else if (kind === 'flat') { const a = tail.geometry.getAttribute('position'); for (let i = 0; i < a.count; i++) a.array[i * 3 + 2] = a.array[2]; a.needsUpdate = true }
    else if (kind === 'disc') {
      // A real scene mesh made from an actual existing mesh, not a renamed fixture.
      let template; e.scene.traverse(o => { if (o.isMesh && !template) template = o })
      if (!template) throw Error('instrument-invalid: disc control requires mesh constructor source')
      const m = template.clone(), g = template.geometry.clone(), a = g.getAttribute('position'), count = a.count
      for (let i = 0; i < count; i++) { const angle = (i % 3 === 0 ? 0 : Math.floor(i / 3) + (i % 3 === 2 ? 1 : 0)) / Math.ceil(count / 3) * Math.PI * 2; const r = i % 3 === 0 ? 0 : 3; a.setXYZ(i, r * Math.cos(angle), r * Math.sin(angle), 0) }
      g.setIndex(null); g.deleteAttribute('normal'); a.needsUpdate = true; g.computeBoundingSphere()
      m.geometry = g; m.material = template.material.clone(); m.material.onBeforeCompile = shader => { shader.vertexShader = 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}'; shader.fragmentShader = 'void main(){gl_FragColor=vec4(1.0,1.0,1.0,1.0);}' }; m.material.customProgramCacheKey = () => 'reference-disc-destruction'; m.material.needsUpdate = true; m.visible = true; m.frustumCulled = false; m.position.copy(v.set(...head())); m.rotation.set(0,0,0); m.scale.set(1,1,1); e.scene.add(m); saved.mesh = m
    } else if (kind !== 'static') throw Error('unknown destructive control')
    e.renderer.render(e.scene, e.camera)
    return { kind, mesh: saved.mesh?.uuid }
  }
  function restore() { if (!saved) return true; tail.material.opacity = saved.opacity; tail.geometry.getAttribute('position').array.set(saved.positions); tail.geometry.getAttribute('position').needsUpdate = true; if (saved.mesh) { saved.mesh.removeFromParent(); saved.mesh.geometry.dispose(); saved.mesh.material.dispose() } saved = null; e.renderer.render(e.scene, e.camera); return true }
  function staticStep(dt) {
    if (saved?.kind !== 'static') throw Error('static control not armed')
    e.advanceClock(dt); e.writeEmissionTable(); e.integrate(dt * 60, e.dollySeconds, dt); e.upload(); e.advanceCamera()
    tail.geometry.getAttribute('position').array.set(saved.positions); tail.geometry.getAttribute('position').needsUpdate = true; e.renderer.render(e.scene, e.camera)
  }
  window.__REFERENCE_PROBE = { sample, advance, history, mutate, restore, staticStep }
  return { t: e.dollySeconds, phase: e.choreography.state.phase, theme: e.light ? 'light' : 'dark', bodyCount: body.geometry.getAttribute('position').count, tailCount: pool.count }
}
