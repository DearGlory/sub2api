import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { CDP, connect, launchChrome } from './tail-probe-lib/cdp.mjs'
import { createSourceCapture, fetchImpactSources, installImpactWithSources } from './comet-impact-sources.mjs'
import { loadedSourceCheck } from './comet-impact-source-checks.mjs'
import { judgeImpact } from './comet-impact-checks.mjs'
import { hash, git } from './comet-impact-baseline.mjs'

const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>v.startsWith('--')?[...a,[v.slice(2),s[i+1]]]:a,[]))
for(const k of ['url','out','port'])if(!args[k])throw Error('required --'+k)
const out=path.resolve(args.out),port=Number(args.port),fault=args.fault||'none'
if(port!==10432)throw Error('source selftest owns only CDP 10432')
if(!['source-fix','scope-fix'].some(dir=>out.replaceAll('\\','/').startsWith('E:/Global-session/xiao-20261013-025234/evidence/judge/'+dir+'/')))throw Error('output must be under source-fix or scope-fix')
if(!['none','expected-hash','body-loss'].includes(fault))throw Error('unknown fault')
await fs.mkdir(out,{recursive:true})
const data={scope:'two real navigation epochs using production probe source capture; no pixel/performance acceptance',toolSHA:git('rev-parse','HEAD').trim(),url:args.url,fault,errors:[],selftests:[]}
let browser,ws,cdp,capture,injected=false
const ev=async s=>{const r=await cdp.eval(s);if(r?.__error)throw Error(r.__error);return r}
try{
  data.sources=await fetchImpactSources({url:args.url,out,label:'source-start'})
  await new Promise((r,j)=>{const s=net.createServer();s.once('error',j);s.listen(port,'127.0.0.1',()=>s.close(r))})
  browser=launchChrome({port,profile:path.join(out,'profile'),chrome:args.chrome||'C:/Program Files/Google/Chrome/Application/chrome.exe',w:960,h:640})
  ws=new WebSocket(await connect(port));await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});cdp=new CDP(ws)
  // Fault injection changes only the first epoch's CDP body reply. The real listener,
  // persistence, install boundaries and source judge still execute unchanged.
  const sourceCDP={eval:(...a)=>cdp.eval(...a),send:(method,params)=>{
    const row=data.loaded?.find(r=>r.requestId===params?.requestId)
    if(fault==='body-loss'&&!injected&&method==='Network.getResponseBody'&&row?.epoch===1&&new URL(row.url).pathname.endsWith('/ParticleEngine.ts')){
      injected=true;return Promise.reject(Error('injected CDP response loss: No resource with given identifier found'))
    }
    return cdp.send(method,params)
  }}
  capture=createSourceCapture({cdp:sourceCDP,ws,out,data})
  for(const domain of ['Page','Runtime','Network'])await cdp.send(domain+'.enable')
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'},{name:'prefers-reduced-motion',value:'no-preference'}]})
  for(let epoch=1;epoch<=2;epoch++){
    const meta=await installImpactWithSources({capture,ev,url:args.url})
    console.log('installed epoch',epoch,'pose',meta.pose.t,'persisted',data.loaded.filter(r=>r.epoch===epoch&&r.persisted).length)
  }
  await capture.close();capture=null
  data.sourcesEnd=await fetchImpactSources({url:args.url,out,label:'source-end'})
  assert(data.sources.every((r,i)=>r.sha256===data.sourcesEnd[i].sha256),'served sources changed during selftest')
  // Verify the first epoch's files after the second navigation, not just in-memory hashes.
  data.verifiedFiles=0
  for(const row of data.loaded){
    if(row.persisted){assert.equal(hash(await fs.readFile(path.join(out,row.file))),row.sha256);data.verifiedFiles++}
    if(row.originalFile){assert.equal(hash(await fs.readFile(path.join(out,row.originalFile))),row.originalSha256);data.verifiedFiles++}
  }
  if(fault==='expected-hash'){
    const source=data.sources.find(s=>s.name==='ParticleEngine')
    data.injection={name:source.name,originalSha256:source.originalSha256,expectedSha256:hash('deliberately wrong fetched original expectation')}
    source.originalSha256=data.injection.expectedSha256;injected=true
  }
  data.check=loadedSourceCheck(data)
  assert.deepEqual(judgeImpact({...data,travel:[],phases:[]},{travel:[]}).find(c=>c.id===data.check.id),data.check,'production judge must use the same source gate')
  if(fault==='none'){
    assert.equal(data.check.status,'pass',JSON.stringify(data.check))
    const negative=(name,mutate)=>{
      const candidate=structuredClone({sources:data.sources,loaded:data.loaded,loadEpochs:data.loadEpochs,auxiliaryRequests:data.auxiliaryRequests,sourceCapture:data.sourceCapture})
      mutate(candidate)
      const check=loadedSourceCheck(candidate);assert.equal(check.status,'instrument-invalid',name)
      data.selftests.push({name,status:'pass',rejectedAs:check.status,issues:check.detail.issues})
    }
    negative('expected-original-hash-drift',d=>d.sources.find(s=>s.name==='ParticleEngine').originalSha256=hash('wrong'))
    negative('missing-first-epoch',d=>d.loaded=d.loaded.filter(r=>r.epoch!==1))
    negative('missing-second-epoch',d=>d.loaded=d.loaded.filter(r=>r.epoch!==2))
    negative('failed-first-epoch-body',d=>{const r=d.loaded.find(r=>r.epoch===1);r.error='No resource with given identifier found';r.persisted=false})
    negative('missing-one-first-epoch-module',d=>d.loaded=d.loaded.filter(r=>!(r.epoch===1&&new URL(r.url).pathname.endsWith('/ParticleEngine.ts'))))
    negative('erased-runtime-module-cannot-bypass',d=>{const s=d.sources.find(s=>s.name==='ParticleEngine');s.erased=true;s.originalSha256=null;s.sha256=hash('')})
    negative('same-loader-reused',d=>d.loadEpochs[1].loaderId=d.loadEpochs[0].loaderId)
    negative('unfinished-extra-engine-request',d=>d.loaded.push({epoch:1,url:new URL('/src/features/home-particle/engine/unexpected.ts',args.url).href}))
  }else{assert(injected,'fault injection did not execute');assert.equal(data.check.status,'instrument-invalid','negative control accepted')}
  data.status=data.check.status
}catch(error){data.status='instrument-invalid';data.error=String(error.stack)}
finally{
  if(capture)try{await capture.close()}catch(error){data.error=String(error.stack);data.status='instrument-invalid'}
  if(cdp){try{await ev('window.__IMPACT_PROBE?.restore()')}catch{}try{await cdp.send('Browser.close')}catch{}}
  ws?.close();browser?.kill()
  data.exitCode=data.status==='pass'?0:2
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify(data,null,2))
  console.log(JSON.stringify({status:data.status,fault,epochs:data.check?.detail.epochs.map(e=>({id:e.id,loaderId:e.loaderId,requests:e.requests,persisted:e.persisted,modules:e.modules.map(m=>({name:m.name,count:m.count,matches:m.matches,original:m.original,erased:m.erased}))})),selftests:data.selftests,verifiedFiles:data.verifiedFiles,error:data.error}))
  process.exitCode=data.exitCode
}
