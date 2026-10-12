import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { CDP, connect, launchChrome } from './tail-probe-lib/cdp.mjs'
import { installSpaceProbe } from './space-pursuit-lib/page.mjs'
import { installMaterialProbe } from './comet-material-page.mjs'
import { judgeMaterial, resultStatus, pixels, LIMITS } from './comet-material-checks.mjs'
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>v.startsWith('--')?[...a,[v.slice(2),s[i+1]]]:a,[]))
for(const k of ['url','out','port','w','h','theme'])if(!args[k])throw Error('required --'+k)
if(!['light','dark'].includes(args.theme))throw Error('theme must be light/dark')
const out=path.resolve(args.out),port=Number(args.port),width=Number(args.w),height=Number(args.h)
await fs.mkdir(out,{recursive:true})
const save=(name,v)=>fs.writeFile(path.join(out,name),JSON.stringify(v,null,2)),hash=b=>crypto.createHash('sha256').update(b).digest('hex')
const data={schema:1,url:args.url,width,height,theme:args.theme,limits:LIMITS,started:new Date().toISOString(),travel:[],runs:[],hold:[],errors:[],checks:[]}
const modules=['ParticleEngine','emittedTail','cometVisualContract','cometVisual','cometSurface','cometVolume','cometTransition','spaceMotion','spaceMotionContract','flightPath','flightTiming','choreography','constants','types']
async function sources(label){const rows=[];await fs.mkdir(path.join(out,label),{recursive:true});for(const name of modules){const r=await fetch(new URL('/src/features/home-particle/engine/'+name+'.ts',args.url));const text=await r.text();await fs.writeFile(path.join(out,label,name+'.js'),text);rows.push({name,status:r.status,sha256:hash(text),module:r.ok&&!text.trimStart().startsWith('<')})}return rows}
let browser,ws,cdp
const ev=async s=>{const r=await cdp.eval(s);if(r?.__error)throw Error(r.__error);return r}
async function install(){await cdp.send('Page.navigate',{url:args.url});if(!await ev('new Promise(r=>{let n=0;const p=()=>window.__SUB2API_PARTICLE_ENGINE__?.currentBrandSlug?r(true):++n>200?r(false):setTimeout(p,100);p()})'))throw Error('missing dev handle');await ev('('+installSpaceProbe.toString()+')()');await ev('__SPACE_PROBE.stop()');return ev('('+installMaterialProbe.toString()+')()')}
async function shot(name,ids){const frozen=await ev('__MATERIAL_PROBE.isolate('+JSON.stringify(ids)+')');try{const png=Buffer.from(await cdp.shot(),'base64');await fs.writeFile(path.join(out,name+'.png'),png);return {png,frozen,file:name+'.png',sha256:hash(png)}}finally{if(!await ev('__MATERIAL_PROBE.restore()'))throw Error('scene restoration/pointers failed')}}
const step=(t,dt)=>ev('__SPACE_PROBE.advance('+t+','+JSON.stringify(dt)+')')
try{
  await new Promise((r,j)=>{const s=net.createServer();s.once('error',j);s.listen(port,'127.0.0.1',()=>s.close(r))})
  data.sources=await sources('source-start')
  browser=launchChrome({port,profile:path.join(out,'profile'),chrome:args.chrome||'C:/Program Files/Google/Chrome/Application/chrome.exe',w:width,h:height,extra:['--disable-background-timer-throttling','--disable-renderer-backgrounding']})
  ws=new WebSocket(await connect(port));await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});cdp=new CDP(ws)
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Log.enable');await cdp.send('Network.enable')
  const loaded=[]
  ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown'||m.method==='Log.entryAdded'&&m.params.entry.level==='error'||m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')data.errors.push(m);if(m.method==='Network.responseReceived'&&/\/engine\//.test(m.params.response.url))loaded.push({requestId:m.params.requestId,url:m.params.response.url})})
  await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600})
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:args.theme},{name:'prefers-reduced-motion',value:'no-preference'}]})
  data.meta=await install()
  data.actualTheme=await ev('({engineLight:__SPACE_PROBE.engine.light,className:document.documentElement.className})')
  data.worldGPU=await ev('__SPACE_PROBE.audit()')
  const first=Math.floor(data.meta.pose.t/12)+1
  for(const leg of [first,first+1])for(const p of [.45,.7]){
    await step(leg*12+6.5*p,[1/60])
    const inventory=await ev('__MATERIAL_PROBE.inventory()'),pose=await ev('__MATERIAL_PROBE.pose()'),label='travel-leg'+(leg-first+1)+'-p'+p
    const empty=await shot(label+'-empty',[]),contributions={},files=[{file:empty.file,sha256:empty.sha256,frozen:empty.frozen}]
    const subjects=inventory.filter(o=>o.body||o.tail||o.isMesh)
    for(let i=0;i<subjects.length;i++){const o=subjects[i],s=await shot(label+'-object'+i,[o.uuid]);contributions[o.uuid]=pixels(s.png,empty.png);files.push({uuid:o.uuid,file:s.file,sha256:s.sha256,frozen:s.frozen})}
    // Surface + local coma: exclude tail proxy volumes by world span, never by object name.
    const bodyIds=subjects.filter(o=>o.body||o.isMesh&&Math.max(...o.span)<=4).map(o=>o.uuid)
    const body=await shot(label+'-body',bodyIds),all=await shot(label+'-subjects',subjects.map(o=>o.uuid))
    files.push({file:body.file,sha256:body.sha256,frozen:body.frozen},{file:all.file,sha256:all.sha256,frozen:all.frozen})
    data.travel.push({label,pose,inventory,contributions,bodyIds,bodyPixels:pixels(body.png,empty.png),files,geometry:await ev('__MATERIAL_PROBE.geometry()')})
    console.log('captured',label)
  }
  const cadences=args.dt?[args.dt.split(',').map(Number)]:[[1/60],[1/30],[.008,.024,.016]]
  if(!cadences.flat().every(v=>v>0&&v<=.1))throw Error('dt must be positive <= .1')
  for(let ri=0;ri<cadences.length;ri++){
    const meta=await install(),leg=Math.floor(meta.pose.t/12)+1,run={name:'dt'+ri,cadence:cadences[ri],rows:[],files:[]}
    for(const kind of ['gather','hold','scatter']){
      const qs=kind==='gather'?[0,.05,.1,.18,.25,.4,.7,1]:kind==='scatter'?[0,.05,.2,.4,.5,.6,.8,.92,.99,1]:[0,1]
      for(const q of qs){const t=leg*12+(kind==='gather'?6.5+Math.min(1.4-1e-7,q*1.4)+1e-8:kind==='hold'?7.9+q*(3-1e-7)+1e-8:10.9+q*1.1*.62+1e-9)
        await step(t,cadences[ri]);const row=await ev('__MATERIAL_PROBE.geometry()');Object.assign(row,{kind,q})
        if(kind==='hold'){if(ri===0)data.hold.push(row)}else run.rows.push(row)
        if(ri===0){const inv=await ev('__MATERIAL_PROBE.inventory()'),s=await shot(kind+'-q'+q,inv.filter(o=>o.body||o.tail||o.isMesh).map(o=>o.uuid));run.files.push({kind,q,t,file:s.file,sha256:s.sha256,frozen:s.frozen})}
      }
    }
    data.runs.push(run);await save('observations.json',data);console.log('sampled',run.name)
  }
  data.loaded=[]
  for(const row of loaded){try{const r=await cdp.send('Network.getResponseBody',{requestId:row.requestId}),text=r.base64Encoded?Buffer.from(r.body,'base64').toString():r.body,file='loaded-'+data.loaded.length+'.js';await fs.writeFile(path.join(out,file),text);data.loaded.push({...row,file,sha256:hash(text)})}catch{}}
  if(Number(args['record-seconds'])>=36){const {recordNormal}=await import('./space-pursuit-lib/record.mjs');data.normalRAF=await recordNormal({cdp,ws,evaluate:ev,out,seconds:Number(args['record-seconds'])})}
  data.sourcesEnd=await sources('source-end');data.sourceStable=data.sources.every((r,i)=>r.sha256===data.sourcesEnd[i].sha256)
  const baseline=args.baseline?JSON.parse(await fs.readFile(path.resolve(args.baseline),'utf8')):data
  data.baseline=args.baseline||'self-comparison: baseline MUST FAIL size/exposure'
  data.checks=judgeMaterial(data,baseline)
  data.status=resultStatus(data.checks)
}catch(error){data.error=String(error.stack);data.checks.push({id:'instrument',status:'instrument-invalid',detail:data.error});data.status=resultStatus(data.checks)}
finally{if(cdp)try{await ev('__MATERIAL_PROBE?.restore()');await cdp.send('Browser.close')}catch{}ws?.close();browser?.kill();data.finished=new Date().toISOString();await save('result.json',data);const summary=[`status: ${data.status}`,...data.checks.map(c=>`${c.status}: ${c.id}`),data.error||''];await fs.writeFile(path.join(out,'summary.txt'),summary.join('\n'));console.log(summary.join('\n'));process.exitCode={pass:0,fail:1,'instrument-invalid':2,skip:3}[data.status]??2}
