// Independent requirements, copied from this round's frozen specification, not motion code.
export const LIMITS = Object.freeze({ world: 1e-5, shrink: .10, hold: 3, capture: .08, legs: 4, drawCalls: 6, geometryBytes: 3500000 })
export const exitFor = status => ({pass:0,fail:1,'instrument-invalid':2,skip:3})[status] ?? 2
export function summarize(checks) {
  return ['instrument-invalid','fail','skip'].find(s=>checks.some(c=>c.status===s && c.required!==false)) || 'pass'
}
const extent = (rows, fn) => { const a=rows.map(fn); return Math.max(...a)-Math.min(...a) }
const diff = (a,b) => a.map((v,i)=>v-b[i])
export function judge(data) {
  const checks=[], add=(id,ok,detail,status='fail')=>checks.push({id,status:ok?'pass':status,detail})
  const rows=data.samples || [], pairs=data.pairs || []
  const proof=data.meta
  add('actual-source',proof?.headSource==='choreography.state.headX/headY/headZ + points.matrixWorld' && proof?.glyphSource==='scratch.glyphTargets + points.matrixWorld' && proof?.geometrySource==='points.geometry.attributes.position + points.matrixWorld' && proof?.cameraSource==='camera.matrixWorld actual position',proof?.headSource,'instrument-invalid')
  add('gpu-position3-color4-scale',data.gpu?.length===2 && data.gpu.every(x=>Object.values(x.attributes).every(a=>a.exactGPU)) && data.gpu[0].pointScaleOnly,data.gpu?.map(x=>x.attributes),'instrument-invalid')
  add('sample-coverage',rows.length>100 && pairs.length>=4,{samples:rows.length,pairs:pairs.length},'instrument-invalid')
  if(!rows.length) return {checks,status:summarize(checks)}
  const bodyRows=rows.filter(r=>r.phase==='travel' || r.phase==='scatter'&&r.progress>.62)
  add('head-final-geometry-agreement',bodyRows.length>0 && bodyRows.every(r=>Number.isFinite(r.headGeometryMaxError) && r.headGeometryMaxError<=1e-4),{maxError:Math.max(...bodyRows.map(r=>r.headGeometryMaxError??Infinity)),source:'every final position minus actual body offset, transformed by actual matrix; no curve model'})
  add('finite',rows.every(r=>[r.t,r.fitGap,...r.head,...r.camera,...r.geometry.min,...r.geometry.max,...r.glyph.min,...r.glyph.max].every(Number.isFinite)),'all actual world observations')
  const cameraViolations=[]
  for(let i=1;i<rows.length;i++) if(rows[i].t>rows[i-1].t+1e-9 && rows[i].camera[2]<=rows[i-1].camera[2]) cameraViolations.push({a:rows[i-1].t,b:rows[i].t,dz:rows[i].camera[2]-rows[i-1].camera[2]})
  add('camera-always-plus-Z',!cameraViolations.length,cameraViolations.slice(0,12))
  const wrap=data.cameraBoundary || [], wrapOK=wrap.length>=6 && wrap.some(r=>r.t<150) && wrap.some(r=>r.t>152.2)
  add('camera-150-152.2',wrapOK && wrap.every((r,i)=>!i || r.camera[2]>wrap[i-1].camera[2]),wrap)
  const holds=[]
  for(const pair of pairs) {
    const {start:a,end:b}=pair, h=rows.filter(r=>r.leg===a.leg && r.phase==='hold')
    const worldDelta=diff(b.head,a.head), camDelta=diff(b.camera,a.camera)
    const anchorDelta=diff(b.glyph.center,a.glyph.center), sizeDelta=diff(b.glyph.size,a.glyph.size)
    const ratio=b.glyphProjected.size[0]/a.glyphProjected.size[0]
    const ratioY=b.glyphProjected.size[1]/a.glyphProjected.size[1]
    const actualRatio=b.projected.size[0]/a.projected.size[0]
    const same=a.phase==='hold' && b.phase==='hold' && a.brand===b.brand && a.leg===b.leg
    const duration=pair.exit.t-pair.enter.t
    const fixed=same && [0,2].every(j=>Math.abs(worldDelta[j])<=LIMITS.world && extent(h,r=>r.head[j])<=LIMITS.world && Math.abs(anchorDelta[j])<=LIMITS.world) && sizeDelta.every(v=>Math.abs(v)<=LIMITS.world)
    const value={leg:a.leg,brand:a.brand,worldDelta,anchorDelta,camDelta,sizeDelta,ratio,ratioY,actualRatio,holdSeconds:duration,startTime:a.t,endTime:b.t,geometryCenterDrift:diff(b.geometry.center,a.geometry.center),png:pair.png}
    holds.push(value)
    add('hold-world-freeze-'+a.leg,fixed,value)
    add('hold-perspective-shrink-'+a.leg,same && camDelta[2]>0 && ratio<=1-LIMITS.shrink && ratioY<=1-LIMITS.shrink,value)
    add('hold-three-seconds-'+a.leg,same && pair.enter.phase==='hold' && pair.exit.phase==='scatter' && Math.abs(duration-3)<=.0003 && b.t-a.t>=2.999, {duration,span:b.t-a.t,entry:pair.enter.phase,exit:pair.exit.phase})
    // Internal flow is not the reference center. Bbox confirms geometry stayed near anchors.
    const centered=[a,b].every(r=>[0,2].every(j=>Math.abs(r.geometry.center[j]-r.glyph.center[j])<=Math.max(.1,r.glyph.size[j]*.1)))
    add('glyph-final-geometry-'+a.leg,centered && actualRatio<=.90,{actualRatio,anchorRatio:ratio,centered})
    add('paired-PNG-'+a.leg,!!pair.png?.start && !!pair.png?.end && pair.png?.aligned===true,pair.png,'instrument-invalid')
  }
  const rests=rows.filter(r=>r.phase==='gather'||r.phase==='hold'||r.phase==='scatter'&&r.progress<=.62)
  const restFindings=[]
  for(const leg of new Set(rests.map(r=>r.leg))) {
    const group=rests.filter(r=>r.leg===leg)
    for(const j of [0,2]) if(extent(group,r=>r.head[j])>LIMITS.world) restFindings.push({leg,axis:j,range:extent(group,r=>r.head[j])})
  }
  add('gather-hold-early-scatter-freeze',!restFindings.length,restFindings)
  const flights=new Map(), supportErrors=[], plusZErrors=[], directionErrors=[]
  for(let i=1;i<rows.length;i++) {
    const a=rows[i-1],b=rows[i],dt=b.t-a.t
    if(dt<=0 || dt>.16) continue
    const leg=b.phase==='scatter'&&b.progress>.62?b.leg+1:b.leg
    const inFlight=r=>r.phase==='travel'||r.phase==='scatter'&&r.progress>.62
    const [dx,,dz]=diff(b.head,a.head)
    const mx=Math.abs(dx)>1e-8,mz=Math.abs(dz)>1e-8
    if(mx!==mz) supportErrors.push({t:b.t,dx,dz,phase:b.phase})
    if(inFlight(a)&&inFlight(b)) {
      if(!mx || !mz || dz<=0) plusZErrors.push({t:b.t,dx,dz})
      const f=flights.get(leg)||{leg,signs:new Set(),start:a.t,end:b.t,dx:0,dz:0,minGap:Infinity}
      if(mx) f.signs.add(Math.sign(dx))
      f.end=b.t;f.dx+=dx;f.dz+=dz;f.minGap=Math.min(f.minGap,b.gap-b.fitGap);flights.set(leg,f)
    }
  }
  const fs=[...flights.values()].filter(f=>f.end-f.start>6.5).map(f=>({...f,signs:[...f.signs]}))
  add('four-consecutive-flights',fs.length>=4 && fs.every((f,i)=>!i||f.leg===fs[i-1].leg+1),fs)
  add('XZ-movement-support',!supportErrors.length,supportErrors.slice(0,12))
  add('flight-no-rest-plus-Z',!plusZErrors.length,plusZErrors.slice(0,12))
  for(let i=0;i<fs.length;i++) if(fs[i].signs.length!==1 || i && fs[i].signs[0]===fs[i-1].signs[0]) directionErrors.push(fs[i])
  add('X-one-sign-flip-at-departure',!directionErrors.length && fs.length>=4,directionErrors)
  const arrivals=data.arrivals || []
  add('stop-at-fitGap',arrivals.length>=4 && arrivals.every(r=>r.phase==='gather' && Math.abs(r.gap-r.fitGap)<=LIMITS.capture),arrivals.map(r=>({t:r.t,gap:r.gap,fitGap:r.fitGap,phase:r.phase})))
  add('capture-band',fs.length>=4 && fs.every(f=>f.minGap>=-LIMITS.capture),fs.map(f=>({leg:f.leg,minGapOffset:f.minGap})))
  const matrixFixed=rows.every(r=>[r.matrices.body,r.matrices.tail].every(m=>Math.abs(m[12])<=LIMITS.world && Math.abs(m[13])<=LIMITS.world && Math.abs(m[14]+6)<=LIMITS.world))
  add('fixed-world-subject-groups',matrixFixed,'actual body/tail world origins (0,0,-6); head local Z is never treated as world Z')
  const birthRows=rows.flatMap(r=>r.births.examples), births=rows.reduce((n,r)=>n+r.births.count,0)
  const birthErrors=rows.flatMap(r=>r.births.errors), inertia=rows.flatMap(r=>r.births.inertiaErrors)
  add('tail-real-births',births>0 && !birthErrors.length,{births,errors:birthErrors.slice(0,12),examples:birthRows.slice(0,4)})
  add('tail-world-inertia',births>0 && !inertia.length,inertia.slice(0,12))
  const axial= birthRows.filter(b=>b.phase==='travel' && b.progress>.05 && b.progress<.95)
  add('tail-axis-world-plus-Z',axial.length>0 && axial.every(b=>b.emitterVelocity[2]>0 && b.axis[2]<0),axial.slice(0,8))
  add('draw-budget',Math.max(...rows.map(r=>r.drawCalls))<=LIMITS.drawCalls,Math.max(...rows.map(r=>r.drawCalls)))
  add('geometry-budget',proof.geometryBytes<=LIMITS.geometryBytes,proof.geometryBytes)
  return {checks,holds,flights:fs,status:summarize(checks)}
}
