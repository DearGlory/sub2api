import { pixels, resultStatus } from './comet-material-checks.mjs'
export { pixels, resultStatus }
export const IMPACT = Object.freeze({ sizeMin:1.1, sizeMax:1.3, nucleusRatio:.9/.72, comaRadius:1.836, minPixels:12, world:1e-5, drawCalls:10, geometryBytes:3500000 })
export const PHASES = Object.freeze({gather:[0,.05,.1,.18,.25,.4,.55,.8,1],scatter:[0,.15,.35,.5,.7,.85,1]})
export const EVENT_KEYS=['uEventMode','uEventProgress','uEventStrength','uHead','uRadius']
export const close=(a,b,eps=1e-5)=>typeof a==='number'&&typeof b==='number'&&Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=eps
export const same=(a,b,eps=1e-5)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>close(v,b[i],eps))
export const eventObjects=inventory=>inventory.filter(o=>o.isMesh&&o.materials.some(m=>EVENT_KEYS.some(k=>k in (m.uniforms||{}))))
export const surfaceObject=inventory=>inventory.find(o=>o.isMesh&&o.materials.some(m=>'uLightDirection' in (m.uniforms||{})))
export const comaObject=inventory=>inventory.find(o=>o.isMesh&&o.materials.some(m=>/#define IS_COMA 1\b/.test(m.fragment||'')))
export const transform=(p,m)=>[0,1,2].map(j=>m[j]*p[0]+m[j+4]*p[1]+m[j+8]*p[2]+m[j+12])
export function sizeExposure(current,baseline,aligned=true,theme='dark') {
  const ratio=current?.diameter/baseline?.diameter
  return [
    {id:'size',status:!aligned?'instrument-invalid':ratio>=IMPACT.sizeMin&&ratio<=IMPACT.sizeMax?'pass':'fail',detail:{ratio,current,baseline}},
    {id:'exposure',status:theme!=='dark'?'skip':!aligned?'instrument-invalid':current?.count>=IMPACT.minPixels&&current.mean<=baseline.mean&&current.p95<=baseline.p95&&current.whiteFraction<=baseline.whiteFraction?'pass':'fail',detail:{current,baseline,note:'dark same-viewport contribution only; light contrast is never brightness'}}
  ]
}
// Deliberately fail closed for unknown shader layouts. Names/comments are not evidence.
export function shaderEvidence(vertex,fragment) {
  const s=(fragment||'').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'')
  const sample=s.match(/vec3\s+(\w+)\s*=\s*(\w+)\s*\+\s*(\w+)\s*\*\s*\([^;]+;/g)||[]
  const march=/for\s*\(\s*int\s+\w+\s*=/.test(s)&&sample.length>0&&/1\.0\s*-\s*exp\s*\(/.test(s)
  const cameraRay=/normalize\s*\([^;]*-\s*uCamera\w*/.test(s)
  const spatial=/\b(?:density|sampleField|eventDensity)\s*\(\s*vec3\s+\w+\s*\)/.test(s)
  const body=s.match(/(?:density|sampleField|eventDensity)\s*\(\s*vec3\s+(\w+)\s*\)\s*\{([\s\S]*?)\n\s*\}/)
  const depth=!!body&&new RegExp('\\b'+body[1]+'\\.z\\b|\\b'+body[1]+'\\s*-\\s*uHead|length\\(\\s*'+body[1]+'\\s*\\)').test(body[2])
  const consumed=sample.some(x=>{const p=x.match(/vec3\s+(\w+)/)[1];return new RegExp('(?:density|sampleField|eventDensity)\\s*\\(\\s*'+p+'\\s*\\)').test(s)})
  const inline=/vec3\s+p\s*=\s*origin\s*\+\s*ray\s*\*/.test(s)&&/origin\s*=\s*uCameraFrame\s*-\s*uHead/.test(s)&&/length\(p\)/.test(s)&&/tilted\(p\)/.test(s)&&/height\s*=\s*d\.z/.test(s)&&/extinction\s*=\s*\(dust\+dark\)\s*\*\s*uEventStrength/.test(s)&&/alpha\s*=\s*1\.0-exp\(-extinction\*stepLength\)/.test(s)&&/opacity\s*\+=\s*\(1\.0-opacity\)\*alpha/.test(s)
  return {status:march&&cameraRay&&(spatial&&depth&&consumed||inline)?'pass':'instrument-invalid',march,cameraRay,spatial,depth,consumed,inline,localVertex:/modelViewMatrix|modelMatrix/.test(vertex||''),note:'structural adapter + live slab/camera contributions required; regex alone never certifies 3D'}
}
export function eventChecks(row) {
  const out=[],add=(id,ok,detail,status='fail')=>out.push({id:row.label+'-'+id,status:ok?'pass':status,detail})
  const objects=eventObjects(row.inventory||[])
  add('event-implemented',objects.length===1,{count:objects.length,implementation:objects.length?'observed':'notimplemented'})
  if(objects.length!==1)return out
  const o=objects[0],m=o.materials.find(m=>EVENT_KEYS.every(k=>k in (m.uniforms||{}))),u=m?.uniforms,g=m?.gpuUniforms
  add('event-contract',!!m,{geometryType:o.geometryType,keys:Object.keys(u||{})})
  if(!m)return out
  const hidden=row.kind==='travel'||row.kind==='hold'||row.kind==='scatter'&&row.q>=1||row.kind==='late-scatter'
  const active=!hidden&&row.q>0&&row.q<1&&u.uEventStrength>0
  const required=!hidden&&(row.kind==='gather'&&row.q>=.1&&row.q<=.4||row.kind==='scatter'&&row.q>=.15&&row.q<=.7)
  if(required)add('event-required-window',active,{strength:u.uEventStrength,kind:row.kind,q:row.q})
  // Actual hidden draws retain stale GPU values. Probe also forces a diagnostic draw without
  // changing uniforms, then restores visibility; this distinguishes CPU claims from uploads.
  const gpu=row.eventGPU?.uniforms||g,expectedMode=row.kind==='gather'?1:2
  const p=row.kind==='scatter'?row.q:row.q
  if(hidden){add('event-hidden-zero',o.visible===false&&u.uEventStrength===0&&u.uEventMode===0&&row.eventPixels?.count===0&&row.pageDelta?.count===0,{visible:o.visible,cpu:u,pixels:row.eventPixels,pageDelta:row.pageDelta});add('event-zero-upload',gpu?.uEventStrength===0&&gpu?.uEventMode===0,{gpu,diagnostic:row.eventGPU},gpu?'fail':'instrument-invalid')}
  else if(active){
    add('event-visible-contribution',o.visible===true&&u.uEventStrength>0&&row.eventPixels?.count>=IMPACT.minPixels&&row.pageDelta?.count>=IMPACT.minPixels,{visible:o.visible,strength:u.uEventStrength,eventPixels:row.eventPixels,pageDelta:row.pageDelta})
    add('event-mode-progress',u.uEventMode===expectedMode&&close(u.uEventProgress,p,2e-5),{expectedMode,expectedProgress:p,mode:u.uEventMode,progress:u.uEventProgress})
  }
  add('event-progress-bounds',Number.isFinite(u.uEventProgress)&&u.uEventProgress>=0&&u.uEventProgress<=1,{progress:u.uEventProgress})
  if(active){
    add('event-linked-GPU',m.linked&&EVENT_KEYS.every(k=>Array.isArray(u[k])?same(u[k],gpu?.[k],2e-5):close(u[k],gpu?.[k],2e-5)),{cpu:u,gpu},gpu?'fail':'instrument-invalid')
    add('event-GPU-object-matrix',same(gpu?.modelViewMatrix,row.eventGPU?.expectedModelView,2e-5),{gpu:gpu?.modelViewMatrix,expected:row.eventGPU?.expectedModelView,objectMatrix:o.matrix},'instrument-invalid')
    const worldHead=Array.isArray(gpu?.uHead)&&o.parentMatrix?transform(gpu.uHead,o.parentMatrix):null
    add('event-world-head',same(worldHead,row.pose.head)&&same(o.worldCenter,row.pose.head)&&same(o.parentMatrix,row.pose.bodyMatrix),{sourceHead:row.pose.head,gpuHead:gpu?.uHead,worldHead,objectCenter:o.worldCenter,matrix:o.matrix,parent:o.parentMatrix})
    const axis=[0,1,2].map(j=>Math.hypot(o.matrix[j*4],o.matrix[j*4+1],o.matrix[j*4+2])*o.span[j])
    add('event-local-box',o.geometryType==='BoxGeometry'&&o.triangles===12&&axis.every(v=>v>0)&&gpu?.uRadius>0&&axis.every(v=>close(v,2*gpu.uRadius,2e-4)),{type:o.geometryType,axis,radius:gpu?.uRadius,triangles:o.triangles})
    add('event-GPU-position',o.gpuAttributes?.attributes?.position?.exact===true,o.gpuAttributes,'instrument-invalid')
    const shader=shaderEvidence(m.vertex,m.fragment)
    add('event-raymarch-3D',shader.status==='pass',shader,shader.status)
  }
  if(row.depth){const d=row.depth;add('event-image-depth',d.status==='observed'&&d.near?.count>=IMPACT.minPixels&&d.far?.count>=IMPACT.minPixels&&d.difference?.count>=IMPACT.minPixels&&d.rotate?.count>=IMPACT.minPixels&&d.translate?.count>=IMPACT.minPixels&&d.frozen===true,d,d.status==='observed'?'fail':'instrument-invalid')}
  return out
}
export function judgeImpact(data,baseline) {
  const checks=[],add=(id,ok,detail,status='fail')=>checks.push({id,status:ok?'pass':status,detail})
  add('baseline-artifacts',baseline.verified===true,baseline.provenance,'instrument-invalid')
  add('frozen-original-motion',data.motion?.status==='pass',data.motion,'instrument-invalid')
  add('sources-stable',data.sourceStable===true,data.sourceStable,'instrument-invalid')
  const loaded=data.sources?.filter(s=>s.module&&!s.erased).map(s=>({name:s.name,original:s.originalSha256,matches:data.loaded?.filter(l=>new URL(l.url).pathname.endsWith('/'+s.name+'.ts')).every(l=>l.originalSha256===s.originalSha256),count:data.loaded?.filter(l=>new URL(l.url).pathname.endsWith('/'+s.name+'.ts')).length}))
  add('actual-loaded-original-sources',loaded?.length>0&&loaded.every(s=>s.original&&s.matches&&s.count>0),loaded,'instrument-invalid')
  add('requested-theme',data.actualTheme?.engineLight===(data.theme==='light'),data.actualTheme,'instrument-invalid')
  add('travel-coverage',data.travel?.length===4,data.travel?.map(r=>r.label),'instrument-invalid')
  for(const row of data.travel||[]){
    const base=baseline.travel.find(b=>b.label===row.label),aligned=!!base&&data.width===baseline.width&&data.height===baseline.height&&same(row.pose.camera,base.pose.camera)&&same(row.pose.projection,base.pose.projection)&&same(row.pose.head,base.pose.head)&&row.pose.brand===base.pose.brand&&close(row.pose.p,base.pose.p)
    add(row.label+'-same-pose-viewport',aligned,{candidate:row.pose,baseline:base?.pose},'instrument-invalid')
    checks.push(...sizeExposure(row.bodyPixels,base?.bodyPixels,aligned,data.theme).map(c=>({...c,id:row.label+'-'+c.id})))
    const s=surfaceObject(row.inventory),b=surfaceObject(base?.inventory||[]),ratios=s&&b?s.radiusQuantiles.map((v,i)=>v/b.radiusQuantiles[i]):[]
    add(row.label+'-nucleus-geometry-.72-to-.9',ratios.length===3&&ratios.every(v=>close(v,IMPACT.nucleusRatio,2e-4))&&s.gpuAttributes?.attributes?.position?.exact===true,{ratios,expected:IMPACT.nucleusRatio,gpu:s?.gpuAttributes})
    const coma=comaObject(row.inventory),u=coma?.materials[0]?.gpuUniforms
    add(row.label+'-coma-geometry-1.836',same(u?.uSize,[2*IMPACT.comaRadius,2*IMPACT.comaRadius,2*IMPACT.comaRadius],2e-4),{gpuSize:u?.uSize,expectedRadius:IMPACT.comaRadius})
    add(row.label+'-active-birth-tail',row.tailProvenance?.status==='pass',row.tailProvenance,row.tailProvenance?.status||'instrument-invalid')
  }
  const rows=[...(data.travel||[]),...(data.phases||[])]
  for(const kind of ['gather','scatter'])add(kind+'-phase-matrix',PHASES[kind].every(q=>data.phases?.some(r=>r.kind===kind&&r.q===q)),PHASES[kind],'instrument-invalid')
  for(const row of rows){checks.push(...eventChecks(row));add(row.label+'-budget',row.drawCalls<=IMPACT.drawCalls&&row.geometryBytes<=IMPACT.geometryBytes,{drawCalls:row.drawCalls,geometryBytes:row.geometryBytes});add(row.label+'-frozen-restored',row.frozen===true,row.frozen,'instrument-invalid');add(row.label+'-page-repeat-stable',row.pageStability?.count===0,row.pageStability,'instrument-invalid');const unknown=row.inventory.filter(o=>o.isMesh&&!o.materials.some(m=>m.uniforms?.uLightDirection||'uEventMode' in (m.uniforms||{})||/#define IS_COMA [01]\b/.test(m.fragment||'')));add(row.label+'-unclassified-meshes',unknown.length===0,unknown.map(o=>({uuid:o.uuid,name:o.name})),'instrument-invalid')}
  for(const kind of ['gather','scatter'])add(kind+'-depth-observed',data.phases?.some(r=>r.kind===kind&&r.depth?.status==='observed'),{kind},'instrument-invalid')
  add('console-webgl-errors',data.errors?.length===0,data.errors,'instrument-invalid')
  add('normal-raf-36s',data.normalRAF?.status==='pass',data.normalRAF||'separate recording not requested',data.normalRAF?.status||'skip')
  if(data.normalRAF?.metrics)add('normal-raf-55fps',1000/data.normalRAF.metrics.meanMs>=55,{fps:1000/data.normalRAF.metrics.meanMs,metrics:data.normalRAF.metrics})
  add('original-world-and-full-transition-regression',false,'Run unchanged space-pursuit-probe and complete comet-material-probe; bounded impact samples do not replace either','skip')
  add('perceived-impact-and-four-cell-review',false,'Static frames cannot certify speed, depth impression or impact; review >=36s native videos and desktop/mobile light/dark matrix','skip')
  return checks
}
