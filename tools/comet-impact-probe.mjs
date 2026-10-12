import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { CDP, connect, launchChrome } from './tail-probe-lib/cdp.mjs'
import { createSourceCapture, fetchImpactSources, installImpactWithSources } from './comet-impact-sources.mjs'
import { createCapture } from './comet-impact-capture.mjs'
import { volumeProvenance } from './comet-material-volume.mjs'
import { PHASES, judgeImpact, resultStatus } from './comet-impact-checks.mjs'
import { loadBaseline, motionEvidence, git } from './comet-impact-baseline.mjs'
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>v.startsWith('--')?[...a,[v.slice(2),s[i+1]]]:a,[]))
for(const k of ['url','out','port','w','h','theme','baseline'])if(!args[k])throw Error('required --'+k)
if(!['light','dark'].includes(args.theme))throw Error('theme must be light/dark')
const out=path.resolve(args.out),port=Number(args.port),width=Number(args.w),height=Number(args.h)
if(![10431,10432].includes(port))throw Error('C owns only CDP 10431/10432')
if(!out.replaceAll('\\','/').startsWith('E:/Global-session/xiao-20261013-025234/evidence/judge/'))throw Error('output must be under this run evidence/judge')
await fs.mkdir(out,{recursive:true})
const data={schema:1,toolSHA:git('rev-parse','HEAD').trim(),scope:'independent impact observations; original world/material regressions remain separate',url:args.url,width,height,theme:args.theme,started:new Date().toISOString(),travel:[],phases:[],errors:[],checks:[]}
const save=()=>fs.writeFile(path.join(out,'result.json'),JSON.stringify(data,null,2))
const sources=label=>fetchImpactSources({url:args.url,out,label})
let browser,ws,cdp,sourceCapture
const ev=async s=>{const r=await cdp.eval(s);if(r?.__error)throw Error(r.__error);return r}
const install=()=>installImpactWithSources({capture:sourceCapture,ev,url:args.url})
try{
  const baseline=await loadBaseline(args.baseline,out);data.baseline=baseline.provenance
  data.sources=await sources('source-start');const engineSource=data.sources.find(r=>r.name==='ParticleEngine');engineSource.originalText=await fs.readFile(path.join(out,'source-start/ParticleEngine.original.ts'),'utf8');data.motion=await motionEvidence(data.sources,out);delete engineSource.originalText
  data.sourceImplementation=data.sources.find(r=>r.name==='cometEventField').module?'observed':'notimplemented'
  await new Promise((r,j)=>{const s=net.createServer();s.once('error',j);s.listen(port,'127.0.0.1',()=>s.close(r))})
  browser=launchChrome({port,profile:path.join(out,'profile'),chrome:args.chrome||'C:/Program Files/Google/Chrome/Application/chrome.exe',w:width,h:height,extra:['--disable-background-timer-throttling','--disable-renderer-backgrounding']})
  ws=new WebSocket(await connect(port));await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});cdp=new CDP(ws)
  ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown'||m.method==='Log.entryAdded'&&m.params.entry.level==='error'||m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')data.errors.push(m)})
  sourceCapture=createSourceCapture({cdp,ws,out,data})
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
  await sourceCapture.checkpoint('after-captures')
  if(Number(args['record-seconds'])>=36){const {recordNormal}=await import('./space-pursuit-lib/record.mjs');data.normalRAF=await recordNormal({cdp,ws,evaluate:ev,out,seconds:Number(args['record-seconds'])})}
  data.sourcesEnd=await sources('source-end');data.sourceStable=data.sources.every((r,i)=>r.sha256===data.sourcesEnd[i].sha256)
  await sourceCapture.close();sourceCapture=null
  data.checks=judgeImpact(data,baseline);data.status=resultStatus(data.checks)
}catch(error){data.error=String(error.stack);data.checks.push({id:'instrument',status:'instrument-invalid',detail:data.error});data.status='instrument-invalid'}
finally{
  if(sourceCapture)try{await sourceCapture.close()}catch(error){data.checks.push({id:'source-capture-close',status:'instrument-invalid',detail:String(error)});data.status='instrument-invalid'}
  if(cdp){try{await ev('window.__IMPACT_PROBE?.restore()')}catch{}try{await cdp.send('Browser.close')}catch{}}
  ws?.close();browser?.kill();data.finished=new Date().toISOString();data.exitCode={pass:0,fail:1,'instrument-invalid':2,skip:3}[data.status]??2;await save();const summary=[`status: ${data.status}`,`implementation: ${data.sourceImplementation}`,...data.checks.map(c=>`${c.status}: ${c.id}`),data.error||''].join('\n');await fs.writeFile(path.join(out,'summary.txt'),summary);console.log(summary);process.exitCode=data.exitCode
}
