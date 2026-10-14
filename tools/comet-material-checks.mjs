import { decodePng, luminance } from './tail-probe-lib/png.mjs'
import { volumeProvenance } from './comet-material-volume.mjs'
export const LIMITS=Object.freeze({sizeMin:1.35,sizeMax:1.75,acceleration:1.8,world:1e-5,drawCalls:10,geometryBytes:3500000,pixelThreshold:8,minPixels:12,glyphRms:.15})
export const quantile=(a,q)=>{const s=a.slice().sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(q*s.length))]}
const norm=a=>Math.hypot(...a),sub=(a,b)=>a.map((v,i)=>v-b[i])
export function pixels(buffer,empty) {
  const image=decodePng(buffer),background=decodePng(empty)
  if(image.w!==background.w||image.h!==background.h)throw Error('PNG dimension mismatch')
  const {L}=luminance(image),B=luminance(background),values=[];let white=0,x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity
  for(let i=0;i<L.length;i++)if(Math.abs(L[i]-B.L[i])>=LIMITS.pixelThreshold){values.push(Math.abs(L[i]-B.L[i]));const x=i%image.w,y=Math.floor(i/image.w);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);const k=i*image.chans;if(image.data[k]>=250&&image.data[k+1]>=250&&image.data[k+2]>=250)white++}
  return {width:image.w,height:image.h,count:values.length,mean:values.reduce((s,v)=>s+v,0)/values.length||0,p95:quantile(values,.95)||0,p10:quantile(values,.1)||0,whiteFraction:white/(values.length||1),bbox:values.length?[x0,y0,x1,y1]:null,diameter:values.length?Math.sqrt((x1-x0+1)*(y1-y0+1)):0,threshold:LIMITS.pixelThreshold}
}
export const resultStatus=checks=>checks.some(c=>c.status==='fail')?'fail':checks.some(c=>c.status==='instrument-invalid')?'instrument-invalid':checks.some(c=>c.status==='skip')?'skip':'pass'
export function transitions(rows) {
  const checks=[],add=(id,ok,detail,status='fail')=>checks.push({id,status:ok?'pass':status,detail})
  for(const phase of ['gather','scatter']) {
    const group=rows.filter(r=>r.kind===phase).sort((a,b)=>a.q-b.q),first=group[0],last=group.at(-1)
    if(!first||group.length<7){add(phase+'-coverage',false,group.length,'instrument-invalid');continue}
    const stable=group.every(r=>r.brand===first.brand&&r.positions.length===first.positions.length&&r.glyph.every((p,i)=>norm(sub(p,first.glyph[i]))<1e-5)&&r.source.every((p,i)=>norm(sub(p,first.source[i]))<1e-5))
    add(phase+'-same-glyph-source',stable,{brand:first.brand,points:first.positions.length},'instrument-invalid')
    const headDrift=Math.max(...group.map(r=>norm(sub(r.head,first.head))))
    add(phase+'-world-anchor',headDrift<=LIMITS.world,{headDrift})
    const series=group.map(r=>({q:r.q,t:r.t,median:quantile(r.positions.map(p=>norm(sub(p,r.head))),.5),p90:quantile(r.positions.map(p=>norm(sub(p,r.head))),.9),z:quantile(r.positions.map(p=>p[2]-r.head[2]),.9)-quantile(r.positions.map(p=>p[2]-r.head[2]),.1)}))
    if(phase==='gather') {
      const early=group.find(r=>Math.abs(r.q-.1)<1e-6),at=series.find(r=>Math.abs(r.q-.1)<1e-6)
      if(!early){add('gather-internal-explosion',false,'missing q=.1','instrument-invalid');continue}
      const cos=[],radial=[]
      for(let i=0;i<first.positions.length;i++){const a=sub(first.positions[i],first.head),b=sub(early.positions[i],early.head),d=sub(b,a);if(norm(a)>1e-6&&norm(d)>1e-6){cos.push(a.reduce((s,v,j)=>s+v*d[j],0)/(norm(a)*norm(d)));radial.push(norm(b)-norm(a))}}
      const outward=quantile(radial,.5),alignment=quantile(cos,.5),zRatio=at.z/series[0].z
      add('gather-internal-explosion',outward>0&&alignment>.5&&zRatio>1,{outward,alignment,zRatio,series,note:'relative to each frame head; majority radial direction, not every logo point'})
      const rawRms=Math.sqrt(last.positions.reduce((s,p,i)=>s+norm(sub(p,last.glyph[i]))**2,0)/last.positions.length)
      const rms=last.glyphFlow?Math.sqrt(last.positions.reduce((s,p,i)=>s+norm(sub(sub(p,last.glyph[i]),last.glyphFlow[i]))**2,0)/last.positions.length):null
      add('gather-final-glyph',rms!==null&&rms<=LIMITS.glyphRms,{rms,rawRms,t:last.t,q:last.q,note:'subtract actual bounded internal flow; unchanged glyph anchors checked separately'},rms===null?'instrument-invalid':'fail')
    }else{
      const mid=series.find(r=>Math.abs(r.q-.5)<1e-6)
      if(!mid){add('scatter-accelerating-collapse',false,'missing midpoint','instrument-invalid');continue}
      const a=series[0],b=series.at(-1),slow=(a.median-mid.median)/(mid.t-a.t),fast=(mid.median-b.median)/(b.t-mid.t),ratio=fast/slow
      const monotone=series.every((r,i)=>!i||r.median<=series[i-1].median+1e-5)
      add('scatter-accelerating-collapse',monotone&&slow>0&&ratio>=LIMITS.acceleration,{slow,fast,ratio,monotone,series})
      const rms=Math.sqrt(last.positions.reduce((s,p,i)=>s+norm(sub(sub(p,last.head),last.offsets[i]))**2,0)/last.positions.length)
      add('scatter-coalesced-at-.62',rms<1e-4,{rms,p:last.p,t:last.t})
    }
  }
  return checks
}
export function judgeMaterial(data,baseline) {
  const checks=[],add=(id,ok,detail,status='fail')=>checks.push({id,status:ok?'pass':status,detail})
  const baselineMatch=baseline&&baseline!==data&&baseline.width===data.width&&baseline.height===data.height&&baseline.theme===data.theme
  add('baseline-viewport-theme',baseline===data||baselineMatch,{width:data.width,height:data.height,theme:data.theme},'instrument-invalid')
  if(baselineMatch){const frozen=['spaceMotion','spaceMotionContract','flightPath','flightTiming','choreography','constants','types'],comparison=frozen.map(name=>({name,current:data.sources?.find(s=>s.name===name)?.sha256,baseline:baseline.sources?.find(s=>s.name===name)?.sha256}));add('frozen-world-source-hashes',comparison.every(r=>r.current&&r.current===r.baseline),comparison,'instrument-invalid')}
  const travel=data.travel||[]
  if(!travel.length){add('travel-coverage',false,'no observations','instrument-invalid');return checks}
  add('travel-coverage',travel.length===4,travel.map(r=>({leg:r.pose.leg,p:r.pose.p})),'instrument-invalid')
  for(const row of travel) {
    const id=row.label,meshes=row.inventory.filter(o=>o.isMesh&&!o.body&&!o.tail),surfaces=meshes.filter(o=>o.normalCount===o.positionCount&&o.triangles>0&&o.span.every(v=>v>0))
    const surface=surfaces.find(o=>o.materials.some(m=>m.roughness!==undefined||/normal|vNormal/.test(m.fragment||'')))
    add(id+'-mesh-normals-triangles',!!surface,{meshes:meshes.map(o=>({uuid:o.uuid,triangles:o.triangles,span:o.span,normalCount:o.normalCount})),surface:surface?.uuid})
    if(surface){
      const s=row.contributions[surface.uuid],r=surface.radiusQuantiles
      add(id+'-surface-pixel-contribution',s?.count>=LIMITS.minPixels,s,s?'fail':'instrument-invalid')
      add(id+'-surface-nonsphere',r[2]-r[0]>1e-4,{radiusQuantiles:r,normalRange:surface.normalRange})
      add(id+'-surface-linked-shader',surface.materials.every(m=>m.linked),surface.materials.map(m=>({type:m.type,linked:m.linked})))
      add(id+'-surface-actual-GPU-attributes',surface.gpuAttributes?.status==='pass',surface.gpuAttributes,'instrument-invalid')
      add(id+'-surface-lit-dark',s?.p95>s?.p10&&s?.whiteFraction<.01,s,s?'fail':'instrument-invalid')
      const light=row.lighting?.[surface.uuid]
      const normalLight=surface.materials.some(m=>/dot\(N, L\)/.test(m.fragment||''))
      add(id+'-surface-directional-light',light?.difference?.count>=LIMITS.minPixels&&normalLight,{light,shaderUsesNormalDotLight:normalLight},light?.status==='observed'?'fail':'instrument-invalid')
    }
    // Names and opacity of the legacy tail Points never decide whether a volume exists.
    const volumes=meshes.filter(o=>o.materials.some(m=>/for\s*\(/.test(m.fragment||'')&&/(density|Density)/.test(m.fragment||'')&&/vec3/.test(m.fragment||'')&&/#define IS_COMA 0\b/.test(m.fragment||'')))
    add(id+'-volume-draw',volumes.some(o=>row.contributions[o.uuid]?.count>=LIMITS.minPixels),{candidates:volumes.map(o=>({uuid:o.uuid,pixels:row.contributions[o.uuid]}))})
    if(volumes.length){const proofs=volumes.map(o=>({uuid:o.uuid,...volumeProvenance(o,row.geometry)}));add(id+'-volume-actual-tail-provenance',proofs.some(p=>p.status==='pass'),proofs,proofs.some(p=>p.status==='fail')?'fail':'instrument-invalid')}
    const base=baseline?.travel?.find(b=>b.label===row.label),current=row.bodyPixels
    if(!base){add(id+'-size-exposure',false,'matching baseline absent','instrument-invalid');continue}
    const aligned=row.pose.camera.every((v,i)=>Math.abs(v-base.pose.camera[i])<1e-5)&&row.pose.head.every((v,i)=>Math.abs(v-base.pose.head[i])<1e-5)
    add(id+'-same-phase-camera',aligned,{head:row.pose.head,baselineHead:base.pose.head},'instrument-invalid')
    const ratio=current.diameter/base.bodyPixels.diameter
    add(id+'-size',aligned&&ratio>=LIMITS.sizeMin&&ratio<=LIMITS.sizeMax,{ratio,current,baseline:base.bodyPixels},aligned?'fail':'instrument-invalid')
    add(id+'-exposure',aligned&&current.count>=LIMITS.minPixels&&current.mean<base.bodyPixels.mean&&current.p95<base.bodyPixels.p95&&current.whiteFraction<=base.bodyPixels.whiteFraction,{current,baseline:base.bodyPixels},aligned?'fail':'instrument-invalid')
    add(id+'-nucleus-larger',!!surface&&Math.min(...surface.span)>.64,{span:surface?.span,oldNucleusRadius:.32})
    add(id+'-geometry-budget',row.inventory.reduce((s,o)=>s+o.bytes,0)<=LIMITS.geometryBytes,row.inventory.reduce((s,o)=>s+o.bytes,0))
  }
  for(const run of data.runs||[])checks.push(...transitions(run.rows).map(c=>({...c,id:run.name+'-'+c.id})))
  const frameRows=(data.runs||[]).flatMap(r=>r.rows),maxDraw=Math.max(0,...frameRows.map(r=>r.drawCalls||0))
  add('actual-draw-budget',frameRows.length>0&&maxDraw<=LIMITS.drawCalls,{maxDraw},frameRows.length?'fail':'instrument-invalid')
  const shots=data.runs?.[0]?.files||[]
  add('transition-frozen-PNG-pairs',shots.length>=20&&shots.every(s=>s.pixels&&Math.abs(s.frozen.t-s.t)<1e-7),{count:shots.length,files:shots.map(s=>({kind:s.kind,q:s.q,file:s.file,pixels:s.pixels}))},'instrument-invalid')
  add('transition-screen-smoothness',false,'static paired PNGs and geometry do not establish perceived smoothness; parent must review normal-rAF video','skip')
  add('desktop-mobile-light-dark-release-matrix',false,'this invocation verifies one viewport/theme; parent records the four-cell release matrix','skip')
  const hold=data.hold||[]
  if(hold.length>=2){const first=hold[0],last=hold.at(-1),newBirths=last.tail.births.filter(b=>!first.tail.births.some(a=>a.i===b.i&&a.birthTime===b.birthTime));add('hold-no-new-tail-existing-fade',!newBirths.length&&first.tail.active>0&&last.tail.alpha<first.tail.alpha,{startActive:first.tail.active,endActive:last.tail.active,startAlpha:first.tail.alpha,endAlpha:last.tail.alpha,newBirths:newBirths.length});const mass=r=>r.inventory?.filter(o=>o.materials.some(m=>/#define IS_COMA 0\b/.test(m.fragment||''))).map(o=>({uuid:o.uuid,visible:o.visible,density:o.materials.reduce((s,m)=>s+(m.uniforms.uDensities||[]).reduce((a,b)=>a+b,0),0)}));const startMass=mass(first),endMass=mass(last);add('hold-volume-density-fade',startMass?.length>0&&endMass?.length>0&&startMass.some(a=>a.visible&&a.density>0)&&endMass.every(b=>!b.visible&&b.density===0),{startMass,endMass},startMass?.length?'fail':'instrument-invalid')}
  else add('hold-no-new-tail-existing-fade',false,'missing hold observations','instrument-invalid')
  add('requested-theme-observed',data.actualTheme?.engineLight===(data.theme==='light'),data.actualTheme,'instrument-invalid')
  add('normal-raf-36s',data.normalRAF?.status==='pass',data.normalRAF||'not requested',data.normalRAF?.status||'skip')
  add('console-webgl-errors',data.errors?.length===0,data.errors||[],'instrument-invalid')
  add('source-stable',data.sourceStable===true,data.sourceStable,'instrument-invalid')
  return checks
}
