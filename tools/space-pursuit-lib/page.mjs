// Runs only in the newly launched probe browser. All positions come from the live engine.
export function installSpaceProbe() {
  const e = window.__SUB2API_PARTICLE_ENGINE__
  const invalid = message => { throw Error('instrument-invalid: ' + message) }
  if (!e) invalid('missing dev handle; production pixels cannot certify geometry')
  for (const k of ['stop', 'advanceClock', 'writeEmissionTable', 'integrate', 'upload', 'advanceCamera']) {
    if (typeof e[k] !== 'function') invalid('missing engine method ' + k)
  }
  if (e.reducedMotion) invalid('normal motion required')
  const body = e.points, tail = e.tailPoints, pool = e.scratch?.emittedTail
  if (!body?.isPoints || !tail?.isPoints || !pool || !e.scratch.glyphTargets) invalid('unmapped actual body/tail/glyph')
  const position = body.geometry.getAttribute('position')
  if (position.array !== e.scratch.positions || tail.geometry.getAttribute('position').array !== pool.positions) invalid('scratch is not final geometry')
  for (const o of [body, tail]) {
    const p = o.geometry.getAttribute('position'), c = o.geometry.getAttribute('color')
    if (p.itemSize !== 3 || c.itemSize !== 4 || p.count !== c.count) invalid('requires position3/color4')
    for (let parent = o.parent; parent; parent = parent.parent) if (parent === e.camera) invalid('subject parented to camera')
  }
  const scale = body.geometry.getAttribute('cometScale')
  if (scale?.itemSize !== 1 || scale.count !== position.count) invalid('missing cometScale')
  for (const k of ['birthTime', 'birthPosition', 'birthVelocity', 'active', 'age', 'life']) if (!ArrayBuffer.isView(pool[k])) invalid('missing tail ' + k)
  const vec = (p, m) => {
    const [x, y, z] = p, a = m.elements
    const w = a[3]*x + a[7]*y + a[11]*z + a[15]
    return [(a[0]*x+a[4]*y+a[8]*z+a[12])/w, (a[1]*x+a[5]*y+a[9]*z+a[13])/w, (a[2]*x+a[6]*y+a[10]*z+a[14])/w]
  }
  const xyz = (a, i) => Array.from(a.subarray(i*3, i*3+3))
  const rawBounds = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], n: 0 })
  const add = (b, p) => { for (let j=0;j<3;j++) { b.min[j]=Math.min(b.min[j],p[j]); b.max[j]=Math.max(b.max[j],p[j]) } b.n++ }
  const finish = b => ({ ...b, center: b.min.map((v,j)=>(v+b.max[j])/2), size: b.min.map((v,j)=>b.max[j]-v) })
  const matrices = () => { e.scene.updateMatrixWorld(true); e.camera.updateMatrixWorld(true) }
  const worldHead = () => { const s=e.choreography.state; return vec([s.headX,s.headY,s.headZ],body.matrixWorld) }
  const cameraPosition = () => vec([0,0,0],e.camera.matrixWorld)
  const project = p => {
    const q=vec(vec(p,e.camera.matrixWorldInverse),e.camera.projectionMatrix)
    const r=e.renderer.domElement.getBoundingClientRect()
    return [r.x+(q[0]+1)*r.width/2,r.y+(1-q[1])*r.height/2,q[2]]
  }
  const audit = () => {
    e.renderer.render(e.scene,e.camera)
    const gl=e.renderer.getContext(), audits=[]
    if (!gl.getBufferSubData) invalid('WebGL2 readback unavailable')
    for (const o of [body,tail]) {
      const program=e.renderer.properties.get(o.material).currentProgram
      if (!program?.program) invalid('no linked GPU program')
      const vertex=gl.getShaderSource(program.vertexShader), fragment=gl.getShaderSource(program.fragmentShader)
      const stock=o.material.clone(), scene=e.scene.clone(false), point=o.clone(false)
      point.material=stock; scene.add(point)
      let reference
      try {
        e.renderer.render(scene,e.camera)
        const p=e.renderer.properties.get(stock).currentProgram
        reference={vertex:gl.getShaderSource(p.vertexShader),fragment:gl.getShaderSource(p.fragmentShader)}
      } finally { stock.dispose() }
      const expected=reference.vertex
      const stripped=vertex.replace('attribute float cometScale;\n','').replace('gl_PointSize = size * cometScale;','gl_PointSize = size;')
      if (stripped!==expected || fragment!==reference.fragment) invalid('unknown GPU center/fragment modification')
      // Render only this actual object so its VAO is the binding read below.
      point.material=o.material; e.renderer.render(scene,e.camera)
      const attributes={}
      for (const name of o===body ? ['position','color','cometScale'] : ['position','color']) {
        const a=o.geometry.getAttribute(name), loc=gl.getAttribLocation(program.program,name)
        if(loc<0 || gl.getVertexAttrib(loc,gl.VERTEX_ATTRIB_ARRAY_SIZE)!==a.itemSize || gl.getVertexAttrib(loc,gl.VERTEX_ATTRIB_ARRAY_TYPE)!==gl.FLOAT) invalid('GPU binding '+name)
        const buffer=gl.getVertexAttrib(loc,gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING), old=gl.getParameter(gl.COPY_READ_BUFFER_BINDING)
        const values=new Float32Array(a.array.length)
        try { gl.bindBuffer(gl.COPY_READ_BUFFER,buffer); gl.getBufferSubData(gl.COPY_READ_BUFFER,0,values) }
        finally { gl.bindBuffer(gl.COPY_READ_BUFFER,old) }
        for(let i=0;i<values.length;i++) if(!Number.isFinite(values[i]) || values[i]!==a.array[i]) invalid('GPU differs from actual '+name)
        attributes[name]={itemSize:a.itemSize,count:a.count,bytes:a.array.byteLength,exactGPU:true}
      }
      audits.push({uuid:o.uuid,attributes,vertex,fragment,pointScaleOnly:o===body})
    }
    e.renderer.render(e.scene,e.camera)
    return audits
  }
  const previousBirth=new Float64Array(pool.count).fill(NaN)
  let births=[], birthCount=0, previous=null, birthErrors=[], inertiaErrors=[], tracked=new Map()
  function observeTail() {
    matrices()
    const h=worldHead(), m=tail.matrixWorld
    for(let i=0;i<pool.count;i++) {
      if(pool.active[i]!==1) { tracked.delete(i); continue }
      const stamp=pool.birthTime[i], age=pool.age[i]
      if(stamp!==previousBirth[i] || age===0) {
        previousBirth[i]=stamp
        if(age>1e-8) continue // already alive when attached: never invent its birth
        const b=vec(xyz(pool.birthPosition,i),m), p=vec(xyz(pool.positions,i),m)
        const velocity=vec(xyz(pool.birthVelocity,i),m).map((v,j)=>v-vec([0,0,0],m)[j])
        const event={i,bornAt:stamp,clock:e.dollySeconds,phase:e.choreography.state.phase,progress:e.choreography.state.phaseProgress,head:h,world:b,actual:p,velocity,axis:vec(xyz(e.scratch.tailTable.axis,0),m).map((v,j)=>v-vec([0,0,0],m)[j]),emitterVelocity:vec(xyz(e.scratch.tailTable.vel,0),m).map((v,j)=>v-vec([0,0,0],m)[j])}
        birthCount++
        if(births.length<12) births.push(event)
        if(Math.hypot(...b.map((v,j)=>v-h[j]))>.191 || Math.hypot(...b.map((v,j)=>v-p[j]))>1e-5) birthErrors.push(event)
        if(e.choreography.state.phase==='hold' || e.choreography.state.phase==='scatter' && e.choreography.state.phaseProgress<=.62) birthErrors.push(event)
        if(tracked.size<32) tracked.set(i,{stamp,b,velocity})
      } else if(tracked.has(i)) {
        const t=tracked.get(i), p=vec(xyz(pool.positions,i),m)
        const error=Math.hypot(...p.map((v,j)=>v-t.b[j]-t.velocity[j]*age))
        if(t.stamp===stamp && error>1e-4 && inertiaErrors.length<12) inertiaErrors.push({i,clock:e.dollySeconds,error,world:p,birth:t.b,age})
      }
    }
  }
  function sample(detail=false) {
    matrices()
    const s=e.choreography.state, h=worldHead(), cam=cameraPosition()
    const wb=rawBounds(), pb=rawBounds(), gb=rawBounds(), gp=rawBounds(), anchors=[], geometry=[]
    let headGeometryMaxError=0
    const bodyPhase=s.phase==='travel' || s.phase==='scatter' && s.phaseProgress>.62
    const offsets=e.scratch.body?.offsets
    if(bodyPhase && !offsets) invalid('missing actual body offsets for head/geometry cross-check')
    const glyph=e.scratch.glyphTargets, stride=Math.max(1,Math.floor(position.count/48))
    for(let i=0;i<position.count;i++) {
      const p=vec(xyz(position.array,i),body.matrixWorld), a=vec(xyz(glyph,i),body.matrixWorld)
      if(!p.every(Number.isFinite)||!a.every(Number.isFinite)) invalid('nonfinite geometry/glyph')
      add(wb,p); add(gb,a)
      if(bodyPhase) {
        const inferred=vec(xyz(position.array,i).map((v,j)=>v-offsets[i*3+j]),body.matrixWorld)
        headGeometryMaxError=Math.max(headGeometryMaxError,...inferred.map((v,j)=>Math.abs(v-h[j])))
      }
      if(detail || s.phase==='hold') { add(pb,project(p)); add(gp,project(a)) }
      if(detail && i%stride===0) { anchors.push({i,world:a,screen:project(a)}); geometry.push({i,world:p,screen:project(p)}) }
    }
    const result={t:e.dollySeconds,phase:s.phase,progress:s.phaseProgress,leg:s.legIndex,brand:e.currentBrandSlug,head:h,localHead:[s.headX,s.headY,s.headZ],camera:cam,gap:cam[2]-h[2],fitGap:e.fitGap,
      geometry:finish(wb),headGeometryMaxError:bodyPhase?headGeometryMaxError:null,glyph:finish(gb),projected:pb.n?finish(pb):null,glyphProjected:gp.n?finish(gp):null,
      matrices:{body:Array.from(body.matrixWorld.elements),tail:Array.from(tail.matrixWorld.elements),camera:Array.from(e.camera.matrixWorld.elements),projection:Array.from(e.camera.projectionMatrix.elements)},
      births:{count:birthCount,examples:births,errors:birthErrors.slice(0,12),inertiaErrors},drawCalls:e.renderer.info.render.calls}
    if(detail) Object.assign(result,{anchors,geometryPoints:geometry,gpu:audit(),viewport:[innerWidth,innerHeight],canvasRect:e.renderer.domElement.getBoundingClientRect().toJSON()})
    births=[]; birthCount=0; birthErrors=[]; inertiaErrors=[]
    previous=result
    return result
  }
  function step(dt) {
    e.advanceClock(dt); e.writeEmissionTable(); e.integrate(Math.min(dt*60,2),e.dollySeconds,dt); e.upload(); e.advanceCamera(); observeTail()
  }
  async function advance(target, cadence=[1/60], full=true) {
    let n=0
    while(e.dollySeconds<target-1e-10) {
      const dt=Math.min(cadence[n%cadence.length],target-e.dollySeconds)
      if(full) step(dt)
      else { e.advanceClock(dt); e.advanceCamera() }
      if(++n%120===0) await new Promise(r=>setTimeout(r,0))
    }
    if(full) e.renderer.render(e.scene,e.camera)
    return sample(false)
  }
  let geometryBytes=0
  e.scene.traverse(o=>{if(o.geometry) for(const a of Object.values(o.geometry.attributes)) geometryBytes+=a.array.byteLength})
  const meta={url:location.href,headSource:'choreography.state.headX/headY/headZ + points.matrixWorld',glyphSource:'scratch.glyphTargets + points.matrixWorld',geometrySource:'points.geometry.attributes.position + points.matrixWorld',cameraSource:'camera.matrixWorld actual position',tailSource:'scratch.emittedTail.birthTime/birthPosition/birthVelocity + tailPoints.matrixWorld',geometryBytes,
    inventory:[body,tail].map(o=>({uuid:o.uuid,parent:o.parent?.uuid,attributes:Object.fromEntries(Object.entries(o.geometry.attributes).map(([k,a])=>[k,{itemSize:a.itemSize,count:a.count}]))})),
    methods:Object.fromEntries(['tick','advanceClock','advanceCamera','integrate','syncGlyph'].map(k=>[k,String(e[k])])),initial:sample(false)}
  window.__SPACE_PROBE={meta,sample,advance,audit,stop:()=>e.stop(),engine:e}
  return meta
}
