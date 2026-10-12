import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { CDP, connect, launchChrome } from './tail-probe-lib/cdp.mjs'
import { installSpaceProbe } from './space-pursuit-lib/page.mjs'
import { judge, exitFor, LIMITS, summarize } from './space-pursuit-lib/checks.mjs'
import { saveAlignedShot } from './space-pursuit-lib/images.mjs'

const args=Object.fromEntries(process.argv.slice(2).map((s,i,a)=>s.startsWith('--')?[s.slice(2),a[i+1]?.startsWith('--')?true:a[i+1]||true]:null).filter(Boolean))
const url=args.url||'http://127.0.0.1:5210/'
const out=path.resolve(args.out||'E:/Global-session/xiao-20261012-231246/evidence/judge/baseline')
const port=Number(args.port||10231), width=Number(args.width||1440),height=Number(args.height||900)
const profile=path.resolve(args.profile||'E:/Global-session/xiao-20261012-231246/evidence/judge/chrome/'+port)
const chrome=args.chrome||'C:/Program Files/Google/Chrome/Application/chrome.exe'
const cadence=args.dt?String(args.dt).split(',').map(Number):[1/60]
if(!cadence.every(v=>v>0&&v<=.1)) throw Error('--dt requires positive seconds <= .1')
await fs.mkdir(out,{recursive:true})
const data={schema:1,startedAt:new Date().toISOString(),url,out,port,width,height,profile,cadence,limits:LIMITS,checks:[],samples:[],pairs:[],arrivals:[]}
try { data.toolSHA=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim() } catch { data.toolSHA=null }
const save=async(name,value)=>fs.writeFile(path.join(out,name),JSON.stringify(value,null,2))
const hash=s=>crypto.createHash('sha256').update(s).digest('hex')
let browser,cdp,ws
const evaluate=async expression=>{const result=await cdp.eval(expression);if(result?.__error)throw Error(result.__error);return result}
async function sources(label) {
  const dir=path.join(out,label);await fs.mkdir(dir,{recursive:true})
  const names=['ParticleEngine','choreography','spaceMotion','spaceMotionContract','emittedTail','constants','flightTiming']
  const rows=await Promise.all(names.map(async name=>{
    const sourceURL=new URL('/src/features/home-particle/engine/'+name+'.ts',url).href
    const r=await fetch(sourceURL),text=await r.text();await fs.writeFile(path.join(dir,name+'.js'),text)
    return {name,url:sourceURL,status:r.status,sha256:hash(text),oldCameraRide:name==='ParticleEngine'&&/this\.points\.position\.z = cameraZ - this\.fitGap/.test(text),unusedSkeleton:name==='spaceMotion'&&/throw new Error|not implemented|return 0/.test(text)}
  }))
  await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify({capturedAt:new Date().toISOString(),rows},null,2));return rows
}
try {
  // Never attach to an occupied debug port, even if it happens to speak CDP.
  const net=await import('node:net')
  await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',()=>reject(Error('instrument-invalid: CDP port occupied')));s.listen(port,'127.0.0.1',()=>s.close(resolve))})
  data.servedSource=await sources('served-source-start')
  browser=launchChrome({port,profile,chrome,w:width,h:height,extra:['--disable-background-timer-throttling','--disable-renderer-backgrounding']})
  ws=new WebSocket(await connect(port));await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});cdp=new CDP(ws)
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable')
  const loaded=[]
  ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.method==='Network.responseReceived' && /\/engine\//.test(m.params.response.url)) loaded.push({requestId:m.params.requestId,url:m.params.response.url,status:m.params.response.status})})
  await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
  await cdp.send('Page.navigate',{url})
  const ready=await evaluate(`new Promise(resolve=>{const start=performance.now();const poll=()=>{const e=window.__SUB2API_PARTICLE_ENGINE__;if(e?.currentBrandSlug)resolve(true);else if(performance.now()-start>20000)resolve(false);else setTimeout(poll,100)};poll()})`)
  if(!ready) throw Error('instrument-invalid: missing dev handle after 20s; geometry on production cannot be inferred')
  data.meta=await evaluate('('+installSpaceProbe.toString()+')()')
  await evaluate('__SPACE_PROBE.stop()')
  data.gpu=await evaluate('__SPACE_PROBE.audit()')
  data.loadedSources=[]
  for(const row of loaded) {
    try { const response=await cdp.send('Network.getResponseBody',{requestId:row.requestId});const text=response.base64Encoded?Buffer.from(response.body,'base64').toString():response.body;const name='loaded-'+data.loadedSources.length+'.js';await fs.writeFile(path.join(out,name),text);data.loadedSources.push({...row,file:name,sha256:hash(text)}) } catch(error) { data.loadedSources.push({...row,error:String(error)}) }
  }
  await save('meta.json',{...data.meta,gpu:data.gpu,loadedSources:data.loadedSources})
  const start=data.meta.initial.t,firstLeg=Math.floor(start/12)+1,lastLeg=firstLeg+3,end=lastLeg*12+11.7
  const schedule=new Map()
  const put=(t,event)=>{const k=Number(t.toFixed(7));const a=schedule.get(k)||[];if(event)a.push(event);schedule.set(k,a)}
  for(let t=Math.ceil(start*10)/10;t<=end;t+=.1) put(t)
  for(let leg=firstLeg;leg<=lastLeg;leg++) {
    const base=leg*12
    put(base+6.50001,{kind:'arrival',leg})
    put(base+7.8999,{kind:'before',leg})
    put(base+7.90001,{kind:'enter',leg})
    put(base+7.9001,{kind:'start',leg})
    put(base+10.8999,{kind:'end',leg})
    put(base+10.90001,{kind:'exit',leg})
    put(base+11.582-0.0001);put(base+11.582+0.0001)
  }
  const pairMap=new Map()
  const entries=[...schedule].filter(([t])=>t>start).sort((a,b)=>a[0]-b[0])
  for(let index=0;index<entries.length;) {
    const batch=[]
    do { batch.push(entries[index++]) } while(index<entries.length && !batch.at(-1)[1].length && batch.length<20)
    const targets=batch.map(([t])=>t)
    const results=await evaluate(`(async()=>{const out=[];for(const t of ${JSON.stringify(targets)})out.push(await __SPACE_PROBE.advance(t,${JSON.stringify(cadence)}));return out})()`)
    data.samples.push(...results)
    for(let i=0;i<batch.length;i++) for(const event of batch[i][1]) {
      const sample=results[i]
      if(event.kind==='arrival') {data.arrivals.push(sample);continue}
      const pair=pairMap.get(event.leg)||{}
      pairMap.set(event.leg,pair)
      if(['start','end'].includes(event.kind)) {
        const detailed=await evaluate('__SPACE_PROBE.sample(true)')
        if(Math.abs(detailed.t-sample.t)>1e-8) throw Error('instrument-invalid: shot not frozen at sampled time')
        pair[event.kind]=detailed
        pair.png??={aligned:true}
        pair.png[event.kind]=await saveAlignedShot(cdp,detailed,path.join(out,`hold-${event.leg}-${event.kind}.png`))
      } else pair[event.kind]=sample
    }
    if(index%100<20) console.log('space-pursuit sample clock',results.at(-1).t)
  }
  data.pairs=[...pairMap.values()]
  data.cameraBoundary=[]
  for(const t of [149.9,150,150.1,151,152.1,152.2,152.3,153]) {
    const r=await evaluate(`__SPACE_PROBE.advance(${t},${JSON.stringify(cadence)},false)`)
    data.cameraBoundary.push({t:r.t,camera:r.camera,phase:r.phase,head:r.head})
  }
  Object.assign(data,judge(data))
  data.normalRAF={status:'skip',reason:'run --record-seconds 36 for normal-rAF recording; parent owns theme/mobile matrix'}
  if(args['record-seconds']) {
    const {recordNormal}=await import('./space-pursuit-lib/record.mjs')
    data.normalRAF=await recordNormal({cdp,ws,evaluate,out,seconds:Number(args['record-seconds'])})
  }
  data.checks.push({id:'normal-RAF-recording',status:data.normalRAF.status,detail:data.normalRAF})
  data.servedSourceEnd=await sources('served-source-end')
  const same=data.servedSource.every((r,i)=>r.sha256===data.servedSourceEnd[i].sha256)
  data.checks.push({id:'served-source-stable',status:same?'pass':'instrument-invalid',detail:'start/end served modules plus actual loaded Network response bodies'})
  data.status=summarize(data.checks)
} catch(error) {
  data.status='instrument-invalid';data.error=String(error.stack||error)
  data.checks.push({id:'instrument',status:'instrument-invalid',detail:data.error})
} finally {
  if(cdp) {try {await cdp.send('Browser.close')} catch {} }
  ws?.close()
  if(browser && browser.exitCode===null) browser.kill()
  data.finishedAt=new Date().toISOString();data.exitCode=exitFor(data.status)
  await save('result.json',data)
  const lines=[`status: ${data.status}`,`exit: ${data.exitCode}`,`url: ${url}`,`tool SHA: ${data.toolSHA}`,`head source: ${data.meta?.headSource||'unavailable'}`,...(data.holds||[]).map(h=>`leg ${h.leg} ${h.brand}: worldDelta=${JSON.stringify(h.worldDelta)} cameraDeltaZ=${h.camDelta[2]} projectionRatio=${h.ratio} holdSeconds=${h.holdSeconds}`),...data.checks.map(c=>`${c.status}: ${c.id}`),data.error||'']
  await fs.writeFile(path.join(out,'summary.txt'),lines.join('\n')+'\n')
  console.log(lines.join('\n'));process.exitCode=data.exitCode
}
