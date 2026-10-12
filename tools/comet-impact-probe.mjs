import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { CDP, connect, launchChrome } from './tail-probe-lib/cdp.mjs'
import { installSpaceProbe } from './space-pursuit-lib/page.mjs'
import { installMaterialProbe } from './comet-material-page.mjs'
import { installImpactProbe } from './comet-impact-page.mjs'
import { createCapture } from './comet-impact-capture.mjs'
import { volumeProvenance } from './comet-material-volume.mjs'
import { PHASES, judgeImpact, resultStatus } from './comet-impact-checks.mjs'
import { loadBaseline, motionEvidence, hash, original, FROZEN, git } from './comet-impact-baseline.mjs'
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>v.startsWith('--')?[...a,[v.slice(2),s[i+1]]]:a,[]))
for(const k of ['url','out','port','w','h','theme','baseline'])if(!args[k])throw Error('required --'+k)
if(!['light','dark'].includes(args.theme))throw Error('theme must be light/dark')
const out=path.resolve(args.out),port=Number(args.port),width=Number(args.w),height=Number(args.h)
if(![10431,10432].includes(port))throw Error('C owns only CDP 10431/10432')
if(!out.replaceAll('\\','/').startsWith('E:/Global-session/xiao-20261013-025234/evidence/judge/'))throw Error('output must be under this run evidence/judge')
await fs.mkdir(out,{recursive:true})
const data={schema:1,toolSHA:git('rev-parse','HEAD').trim(),scope:'independent impact observations; original world/material regressions remain separate',url:args.url,width,height,theme:args.theme,started:new Date().toISOString(),travel:[],phases:[],errors:[],checks:[]}
const save=()=>fs.writeFile(path.join(out,'result.json'),JSON.stringify(data,null,2))
const modules=[...FROZEN,'ParticleEngine','cometVisualContract','cometVisual','cometSurface','cometVolume','cometTransition','cometEventField']
async function sources(label){await fs.mkdir(path.join(out,label),{recursive:true});return Promise.all(modules.map(async name=>{const response=await fetch(new URL('/src/features/home-particle/engine/'+name+'.ts',args.url)),text=await response.text(),raw=original(text),module=response.ok&&!text.trimStart().startsWith('<');await fs.writeFile(path.join(out,label,name+'.js'),text);if(raw!==null)await fs.writeFile(path.join(out,label,name+'.original.ts'),raw);return {name,status:response.status,module,sha256:hash(text),originalSha256:raw===null?null:hash(raw),erased:module&&text.length===0}}))}
let browser,ws,cdp
const ev=async s=>{const r=await cdp.eval(s);if(r?.__error)throw Error(r.__error);return r}
async function install(){await cdp.send('Page.navigate',{url:args.url});await ev('new Promise((r,j)=>{let n=0;const tick=()=>window.__SUB2API_PARTICLE_ENGINE__?.currentBrandSlug?r(true):++n>200?j(Error("missing dev engine")):setTimeout(tick,100);tick()})');await ev('('+installSpaceProbe.toString()+')()');await ev('__SPACE_PROBE.stop()');await ev('('+installMaterialProbe.toString()+')()');return ev('('+installImpactProbe.toString()+')()')}
try{
  const baseline=await loadBaseline(args.baseline,out);data.baseline=baseline.provenance
  data.sources=await sources('source-start');const engineSource=data.sources.find(r=>r.name==='ParticleEngine');engineSource.originalText=await fs.readFile(path.join(out,'source-start/ParticleEngine.original.ts'),'utf8');data.motion=await motionEvidence(data.sources,out);delete engineSource.originalText
  data.sourceImplementation=data.sources.find(r=>r.name==='cometEventField').module?'observed':'notimplemented'
  await new Promise((r,j)=>{const s=net.createServer();s.once('error',j);s.listen(port,'127.0.0.1',()=>s.close(r))})
  browser=launchChrome({port,profile:path.join(out,'profile'),chrome:args.chrome||'C:/Program Files/Google/Chrome/Application/chrome.exe',w:width,h:height,extra:['--disable-background-timer-throttling','--disable-renderer-backgrounding']})
  ws=new WebSocket(await connect(port));await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});cdp=new CDP(ws)
  const loaded=[];ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown'||m.method==='Log.entryAdded'&&m.params.entry.level==='error'||m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')data.errors.push(m);if(m.method==='Network.responseReceived'&&/\/engine\//.test(m.params.response.url))loaded.push({requestId:m.params.requestId,url:m.params.response.url})})
  for(const domain of ['Page','Runtime','Log','Network'])await cdp.send(domain+'.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600})
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:args.theme},{name:'prefers-reduced-motion',value:'no-preference'}]})
  data.meta=await install();data.actualTheme=await ev('({engineLight:__SPACE_PROBE.engine.light,className:document.documentElement.className})');data.worldGPU=await ev('__SPACE_PROBE.audit()')
  const capture=createCapture({ev,cdp,out})
  for(const base of baseline.travel){
    if(data.meta.pose.t>base.pose.t)throw Error('page started after fixed baseline target')
    await ev('__SPACE_PROBE.advance('+base.pose.t+',[1/60])')
    const row=await capture.capture(base.label,'travel',base.pose.p)
    const tail=row.inventory.find(o=>o.materials.some(m=>/#define IS_COMA 0\b/.test(m.fragment||'')))
    row.tailProvenance=tail?volumeProvenance(tail,{tail:{births:await ev('__IMPACT_PROBE.births()')}}):{status:'fail',reason:'explicit IS_COMA 0 tail absent'}
    data.travel.push(row);await save();console.log('captured',row.label)
  }
  data.phaseMeta=await install();const leg=Math.floor(data.phaseMeta.pose.t/12)+1
  for(const kind of ['gather','hold','scatter','late-scatter']){
    const qs=PHASES[kind]||(kind==='hold'?[0,1]:[.7,.85,1])
    for(const q of qs){
      const t=leg*12+(kind==='gather'?6.5+Math.min(1.4-1e-7,q*1.4)+1e-8:kind==='hold'?7.9+q*(3-1e-7)+1e-8:kind==='scatter'?10.9+q*1.1*.62+1e-9:10.9+Math.min(1.1-1e-7,q*1.1)+1e-8)
      await ev('__SPACE_PROBE.advance('+t+',[1/60])')
      const row=await capture.capture(kind+'-q'+q,kind,q,{depthTest:kind==='gather'&&q===.25||kind==='scatter'&&q===.5})
      data.phases.push(row);await save();console.log('captured',row.label,row.eventPixels.count,'event pixels',row.shadow.shadowPixels,'shadow pixels')
    }
  }
  data.loaded=[]
  for(const row of loaded){try{const r=await cdp.send('Network.getResponseBody',{requestId:row.requestId}),text=r.base64Encoded?Buffer.from(r.body,'base64').toString():r.body,file='loaded-'+data.loaded.length+'.js';await fs.writeFile(path.join(out,file),text);data.loaded.push({...row,file,sha256:hash(text),originalSha256:original(text)===null?null:hash(original(text))})}catch(error){data.loaded.push({...row,error:String(error)})}}
  if(Number(args['record-seconds'])>=36){const {recordNormal}=await import('./space-pursuit-lib/record.mjs');data.normalRAF=await recordNormal({cdp,ws,evaluate:ev,out,seconds:Number(args['record-seconds'])})}
  data.sourcesEnd=await sources('source-end');data.sourceStable=data.sources.every((r,i)=>r.sha256===data.sourcesEnd[i].sha256)
  data.checks=judgeImpact(data,baseline);data.status=resultStatus(data.checks)
}catch(error){data.error=String(error.stack);data.checks.push({id:'instrument',status:'instrument-invalid',detail:data.error});data.status='instrument-invalid'}
finally{if(cdp)try{await ev('__IMPACT_PROBE?.restore()');await cdp.send('Browser.close')}catch{}ws?.close();browser?.kill();data.finished=new Date().toISOString();data.exitCode={pass:0,fail:1,'instrument-invalid':2,skip:3}[data.status]??2;await save();const summary=[`status: ${data.status}`,`implementation: ${data.sourceImplementation}`,...data.checks.map(c=>`${c.status}: ${c.id}`),data.error||''].join('\n');await fs.writeFile(path.join(out,'summary.txt'),summary);console.log(summary);process.exitCode=data.exitCode}
