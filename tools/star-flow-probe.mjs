/** Short V5 audit. Reuses the original detector, mask and CDP; no production edits. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { CDP, connect, sleep, freezeAndSettle, RESUME_RAF } from './tail-probe-lib/cdp.mjs'
import { decodePng, luminance } from './tail-probe-lib/png.mjs'
import { INSTALL_TRACKER, CONTROL } from './star-flow-page.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(a => { const i=a.indexOf('='); return [a.slice(2,i<0?undefined:i),i<0?'true':a.slice(i+1)] }))
const out=resolve(args.out||'evidence/starflow/run'), port=Number(args.port||10161)
const mode=args.control||'baseline', url=args.url||'http://127.0.0.1:5210/'
if(!['baseline','stopped','outward','dark'].includes(mode)) throw Error('unknown control: '+mode)
mkdirSync(out,{recursive:true})
const hash=x=>createHash('sha256').update(x).digest('hex')
const src=readFileSync(new URL('./framing-probe.mjs',import.meta.url),'utf8').replace(/\r\n/g,'\n')
const fn=name=>{const start=src.indexOf('function '+name+'(');if(start<0)throw Error(name);return src.slice(start,src.indexOf('\n}',start)+2)}
const expr=name=>{const start=src.indexOf('const '+name+' = ');if(start<0)throw Error(name);return src.slice(start,src.indexOf('`\n',start)+1)}
// Deliberately evaluate only pure helpers, never the old probe's top-level runner.
const old=new Function([
  'const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:NaN; const round=(v,d=4)=>Number.isFinite(v)?Number(v.toFixed(d)):v; const SPRITE_WORLD_RADIUS=0.0625;',
  ...['components','exclusionMask','buildFlowMask','median','detectStars'].map(fn),
  fn('radialFlow').replace('peak: p.peak })','peak: p.peak, p, q: best })').replace('sample: moves.slice(0, 12)','sample: moves'),
  ...['ISOLATE','SET_VIS','GEOMETRY'].map(expr),
  'return {detectStars,radialFlow,buildFlowMask,ISOLATE,SET_VIS,GEOMETRY};',
].join('\n'))()
const med=a=>{a=[...a].sort((x,y)=>x-y);return a.length?(a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2:NaN}
function stats(values){const median=med(values),mad=med(values.map(v=>Math.abs(v-median))),sigma=1.4826*mad;return {n:values.length,median,sigma,se:1.253*sigma/Math.sqrt(values.length),inward:values.filter(x=>x<0).length,outward:values.filter(x=>x>0).length}}
function identify(frame,exclude){
  const detections=old.detectStars(frame.lum,frame.img,60,200,{minSize:2,exclude}).pts
  const stars=frame.state.layers.slice(0,3).flatMap(l=>l.rows).filter(s=>s.onscreen&&s.lit)
  const tagged=detections.map(p=>{
    const near=stars.map(s=>({s,d:Math.hypot(p.x+.5-s.x,p.y+.5-s.y)})).sort((a,b)=>a.d-b.d)
    const ok=near[0]?.d<=1.5&&(!near[1]||near[1].d>2.5)
    return {...p,star:ok?near[0].s:null,error:near[0]?.d,ambiguous:!ok}
  })
  // A component and a star must both have a unique owner.
  const counts=new Map();for(const p of tagged)if(p.star)counts.set(p.star.id,(counts.get(p.star.id)||0)+1)
  for(const p of tagged)if(p.star&&counts.get(p.star.id)!==1){p.star=null;p.ambiguous=true}
  return tagged
}
function compare(a,b,noise=0){
 const mask=old.buildFlowMask([a,b],[a.geom,b.geom]);
 const A=identify(a,mask.exclude),B=identify(b,mask.exclude),byId=new Map(B.filter(p=>p.star).map(p=>[p.star.id,p]));
 const rows=[];let recycled=0;
 const minR=.35*Math.hypot(a.img.w/2,a.img.h/2)
 for(const p of A){if(!p.star)continue;const q=byId.get(p.star.id);if(!q)continue;if(p.star.generation!==q.star.generation){recycled++;continue}
   const ra=Math.hypot(p.x+.5-a.img.w/2,p.y+.5-a.img.h/2),rb=Math.hypot(q.x+.5-b.img.w/2,q.y+.5-b.img.h/2);if(ra<minR)continue;
   rows.push({id:p.star.id,layer:p.star.layer,a:[p.x+.5,p.y+.5],b:[q.x+.5,q.y+.5],errorA:p.error,errorB:q.error,pixelDr:rb-ra,projectedDr:q.star.r-p.star.r,travel:Math.hypot(q.x-p.x,q.y-p.y)})
 }
 const s=stats(rows.map(r=>r.pixelDr)),projected=stats(rows.map(r=>r.projectedDr)),dz=b.state.camZ-a.state.camZ;
 const floor=Math.max(noise,2*s.se),resolved=s.n>=8&&dz>.2&&Number.isFinite(s.median)&&Math.abs(s.median)>floor;
 const legacy=old.radialFlow(a,b,{thr:60,minSize:2,maxSize:200,matchRadius:7,exclude:mask.exclude,boxes:mask.boxes});
 const lookup=(ps,p)=>ps.find(q=>Math.abs(q.x-p.x)<1e-6&&Math.abs(q.y-p.y)<1e-6)
 const mismatches=legacy.sample.map(m=>{const p=lookup(A,m.p),q=lookup(B,m.q),trueQ=p?.star?byId.get(p.star.id):null;return {a:m.p,b:m.q,radial:m.radial,idA:p?.star?.id,idB:q?.star?.id,sameId:!!p?.star&&!!q?.star&&p.star.id===q.star.id,truePartnerB:trueQ?[trueQ.x,trueQ.y]:null,truePartnerDistance:trueQ?Math.hypot(trueQ.x-m.p.x,trueQ.y-m.p.y):null}})
 return {phase:a.state.phase,toPhase:b.state.phase,elapsedMs:b.state.t-a.state.t,dz,maskFrac:mask.frameFrac,maskBoxes:mask.boxes,candidates:[A.length,B.length],identified:[A.filter(p=>p.star).length,B.filter(p=>p.star).length],recycled,pixels:s,projected,noise,floor,resolved,pass:resolved&&s.median<0&&s.inward>s.n/2,rows,legacy:{...legacy,sample:undefined,identifiable:mismatches.filter(m=>m.idA&&m.idB).length,wrongIds:mismatches.filter(m=>m.idA&&m.idB&&!m.sameId).length,matches:mismatches}}
}
const ws=new WebSocket(await connect(port));await new Promise(r=>ws.addEventListener('open',r));const c=new CDP(ws)
const ev=async x=>{const v=await c.eval(x);if(v?.__error||v?.error)throw Error(JSON.stringify(v));return v}
const report={mode,url,methodHash:hash(readFileSync(new URL(import.meta.url))),pageMethodHash:hash(readFileSync(new URL('./star-flow-page.mjs',import.meta.url))),legacyHash:hash(src),started:new Date().toISOString(),runs:[]}
const runtimeMethods = `(() => {const e=window.__SUB2API_PARTICLE_ENGINE__;return {starfieldUpdate:e.starfield.update.toString(),advanceCamera:e.advanceCamera.toString(),tick:e.tick.toString(),render:e.renderer.render.toString()}})()`
const methodHashes = methods => Object.fromEntries(Object.entries(methods).map(([k,v])=>[k,hash(v)]))
async function sourceHashes(){const o={};for(const file of ['starfield.ts','ParticleEngine.ts']){const r=await fetch(url+'src/features/home-particle/engine/'+file);if(!r.ok)throw Error('source '+r.status);o[file]=hash(await r.text())}return o}
async function capture(name){
 const frozen=await freezeAndSettle(c,sleep);
 try{
  const state=await ev('window.__STAR_FLOW__.snapshot()'),geom=await ev(old.GEOMETRY),png=Buffer.from(await c.shot(),'base64');
  const after=await ev('window.__STAR_FLOW__.snapshot()');
  if(JSON.stringify({...state,t:0})!==JSON.stringify({...after,t:0}))throw Error('snapshot moved during capture');
  writeFileSync(join(out,name+'.png'),png);writeFileSync(join(out,name+'.state.json'),JSON.stringify({state,geom,frozen}));
  const img=decodePng(png);if(img.w!==1440||img.h!==900)throw Error('wrong screenshot dimensions');
  return {state,geom,img,lum:luminance(img).L,pngHash:hash(png)}
 }finally{await ev(RESUME_RAF)}
}
try{
 await c.send('Page.enable');await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await c.send('Page.navigate',{url});
 for(let i=0;i<60;i++){if(await ev('!!window.__SUB2API_PARTICLE_ENGINE__'))break;await sleep(250)}
 await ev(old.ISOLATE);await ev(old.SET_VIS(false,true));await sleep(400);
 report.sourceBefore=await sourceHashes();
 if(mode!=='baseline')await ev(CONTROL(mode));
 const installed=await ev(INSTALL_TRACKER);report.runtimeHashes=Object.fromEntries(Object.entries(installed.methods).map(([k,v])=>[k,hash(v)]));
 const nA=await capture('noise-a');await sleep(100);const nB=await capture('noise-b');
 const nr=compare(nA,nB);report.noise=nr;const noise=Math.max(Math.abs(nr.pixels.median)||0,Math.abs(nr.legacy.medianRadial)||0);
 for(const phase of (mode==='baseline'?(args.phases||'scatter,travel,gather,hold').split(','):['control'])){
  if(phase!=='control'){
   const wait=await ev(`new Promise(resolve=>{const until=performance.now()+45000;const tick=()=>{const e=window.__SUB2API_PARTICLE_ENGINE__;if(e.choreography.state.phase===${JSON.stringify(phase)}&&e.choreography.state.phaseProgress<.3)return resolve(true);if(performance.now()>until)return resolve(false);requestAnimationFrame(tick)};requestAnimationFrame(tick)})`);
   if(!wait)throw Error('phase timeout '+phase);
  }
  const a=await capture(phase+'-a');await sleep(Number(args['interval-ms']||7000));const b=await capture(phase+'-b');
  const r=compare(a,b,noise);report.runs.push(r);
  console.log(JSON.stringify({mode,phase,dz:r.dz,pixels:r.pixels,projected:r.projected,floor:r.floor,pass:r.pass,legacy:{median:r.legacy.medianRadial,matched:r.legacy.matched,wrong:r.legacy.wrongIds,identified:r.legacy.identifiable}}));
 }
 report.frames=await ev('window.__STAR_FLOW__.frames');
 report.phaseSummary=Object.fromEntries(['scatter','travel','gather','hold'].map(phase=>{
  const f=report.frames.filter(f=>f.phase===phase&&f.fromPhase===phase&&f.dz>0);
  return [phase,{frames:f.length,eligible:f.reduce((s,r)=>s+r.eligible,0),inward:f.reduce((s,r)=>s+r.inward,0),outward:f.reduce((s,r)=>s+r.outward,0),recycled:f.reduce((s,r)=>s+r.recycled,0),offscreen:f.reduce((s,r)=>s+r.offscreen,0),zeroBrightness:f.reduce((s,r)=>s+r.zeroBrightness,0)}]
 }));
 report.sourceAfter=await sourceHashes();report.runtimeHashesAfter=methodHashes(await ev(runtimeMethods));
 report.noHmr=JSON.stringify(report.sourceBefore)===JSON.stringify(report.sourceAfter)&&JSON.stringify(report.runtimeHashes)===JSON.stringify(report.runtimeHashesAfter)&&await ev('window.__STAR_FLOW__.engine===window.__SUB2API_PARTICLE_ENGINE__');
 report.controlEffective=mode==='baseline'||report.runs.every(r=>mode==='stopped' ? Math.abs(r.dz)<1e-8&&r.pixels.n>=8&&Math.abs(r.projected.median)<1e-6 : mode==='outward' ? r.dz>.2&&r.resolved&&r.pixels.median>r.floor&&r.pixels.outward>r.pixels.n/2 : r.dz>.2&&r.candidates.every(n=>n===0));
 report.pass=report.noHmr&&report.controlEffective&&(mode==='baseline'?report.runs.every(r=>r.pass)&&Object.values(report.phaseSummary).every(s=>s.frames>0&&s.inward>s.eligible/2):report.runs.every(r=>!r.pass));
 report.exit=report.pass?0:1;
}catch(e){report.error=String(e.stack||e);report.exit=2;console.error(report.error)}finally{
 try{await ev(RESUME_RAF);await ev('(()=>{if(window.__STAR_FLOW__)window.__STAR_FLOW__.stopped=true;window.__STAR_FLOW_RESTORE__?.();return true})()');await ev(old.SET_VIS(true,true));await c.send('Page.navigate',{url})}catch(e){report.cleanupError=String(e);report.exit=2}
 report.finished=new Date().toISOString();writeFileSync(join(out,'result.json'),JSON.stringify(report,null,2));ws.close();console.log('STAR_FLOW_EXIT='+report.exit);process.exitCode=report.exit;
}
