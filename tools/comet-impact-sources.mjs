import fs from 'node:fs/promises'
import path from 'node:path'
import { hash, original } from './comet-impact-baseline.mjs'
import { SOURCE_MODULES, AUXILIARY_SCOPE, isKnownDedicatedWorker } from './comet-impact-source-checks.mjs'
import { installSpaceProbe } from './space-pursuit-lib/page.mjs'
import { installMaterialProbe } from './comet-material-page.mjs'
import { installImpactProbe } from './comet-impact-page.mjs'
export { SOURCE_MODULES }

export async function installImpactWithSources({capture,ev,url}) {
  await capture.navigate(url)
  await ev('new Promise((r,j)=>{let n=0;const tick=()=>window.__SUB2API_PARTICLE_ENGINE__?.currentBrandSlug?r(true):++n>200?j(Error("missing dev engine")):setTimeout(tick,100);tick()})')
  await ev('('+installSpaceProbe.toString()+')()');await ev('__SPACE_PROBE.stop()')
  await ev('('+installMaterialProbe.toString()+')()')
  const meta=await ev('('+installImpactProbe.toString()+')()')
  await capture.ready()
  return meta
}
const enginePath='/src/features/home-particle/engine/'
const engineURL=url=>{try{return new URL(url).pathname.startsWith(enginePath)}catch{return false}}

export async function fetchImpactSources({url,out,label}) {
  await fs.mkdir(path.join(out,label),{recursive:true})
  return Promise.all(SOURCE_MODULES.map(async name=>{
    const response=await fetch(new URL(enginePath+name+'.ts',url)),text=await response.text(),raw=original(text),module=response.ok&&!text.trimStart().startsWith('<')
    await fs.writeFile(path.join(out,label,name+'.js'),text)
    if(raw!==null)await fs.writeFile(path.join(out,label,name+'.original.ts'),raw)
    return {name,status:response.status,module,sha256:hash(text),originalSha256:raw===null?null:hash(raw),erased:module&&text.length===0}
  }))
}

// The listener starts getResponseBody on loadingFinished, while that document still
// owns the resource. Navigation barriers await both CDP reads and filesystem writes.
export function createSourceCapture({cdp,ws,out,data,timeoutMs=30000}) {
  data.loaded=[];data.loadEpochs=[];data.auxiliaryRequests=[]
  data.sourceCapture={scope:'page runtime sources for travel and fixed phases only; separate recording reload excluded',closed:false}
  const requests=new Map(),loaders=new Map(),pending=new Set()
  let current,closing
  const persist=async row=>{
    try{
      const response=await cdp.send('Network.getResponseBody',{requestId:row.requestId})
      const text=response.base64Encoded?Buffer.from(response.body,'base64').toString('utf8'):response.body
      row.file=`loaded-epoch-${row.epoch}-${row.index}.js`
      await fs.writeFile(path.join(out,row.file),text)
      row.sha256=hash(text)
      const raw=original(text)
      row.originalSha256=raw===null?null:hash(raw)
      if(raw!==null){row.originalFile=`loaded-epoch-${row.epoch}-${row.index}.original.ts`;await fs.writeFile(path.join(out,row.originalFile),raw)}
      row.persisted=true
    }catch(error){row.error=String(error);row.persisted=false}
  }
  const start= row=>{
    if(row.bodyStarted)return
    row.bodyStarted=true
    const task=persist(row);pending.add(task);task.finally(()=>pending.delete(task))
  }
  const listener=event=>{
    const m=JSON.parse(event.data),p=m.params
    if(m.method==='Network.requestWillBeSent'&&engineURL(p.request.url)){
      const epoch=loaders.get(p.loaderId)||current
      const row={index:data.loaded.length,epoch:epoch?.id??null,requestId:p.requestId,loaderId:p.loaderId,frameId:p.frameId,url:p.request.url,requestedAt:p.timestamp}
      if(p.redirectResponse)row.error='redirected engine request; source attribution unavailable'
      if(isKnownDedicatedWorker(row,epoch)){
        row.index=data.auxiliaryRequests.length;row.scope=AUXILIARY_SCOPE
        row.attribution='known dedicated worker entry; response/body belongs to worker target, not part of page runtime source proof'
        data.auxiliaryRequests.push(row)
      }else data.loaded.push(row)
      requests.set(p.requestId,row)
    }else if(m.method==='Network.responseReceived'&&engineURL(p.response.url)){
      let row=requests.get(p.requestId)
      if(!row){row={index:data.loaded.length,epoch:current?.id??null,requestId:p.requestId,loaderId:p.loaderId,url:p.response.url,error:'response without observed request'};data.loaded.push(row);requests.set(p.requestId,row)}
      Object.assign(row,{url:p.response.url,status:p.response.status,responseReceived:true,fromDiskCache:p.response.fromDiskCache===true,fromServiceWorker:p.response.fromServiceWorker===true})
    }else if(m.method==='Network.loadingFinished'){
      const row=requests.get(p.requestId)
      if(row){row.finished=true;row.finishedAt=p.timestamp;if(row.scope!==AUXILIARY_SCOPE)start(row)}
    }else if(m.method==='Network.loadingFailed'){
      const row=requests.get(p.requestId)
      if(row){row.failed=true;row.error='Network.loadingFailed: '+p.errorText}
    }
  }
  ws.addEventListener('message',listener)
  const flush=async()=>{while(pending.size)await Promise.all([...pending])}
  const checkpoint=async label=>{
    // New loadingFinished events can arrive during manifest I/O. Drain those too
    // before allowing the caller to navigate away or close the target.
    do{
      await flush()
      if(current){
        const rows=data.loaded.filter(r=>r.epoch===current.id)
        current.checkpoints??=[]
        current.checkpoints.push({label,requests:rows.length,finished:rows.filter(r=>r.finished).length,persisted:rows.filter(r=>r.persisted).length})
      }
      await fs.writeFile(path.join(out,'loaded-sources.json'),JSON.stringify({loaded:data.loaded,loadEpochs:data.loadEpochs,auxiliaryRequests:data.auxiliaryRequests,sourceCapture:data.sourceCapture},null,2))
    }while(pending.size)
  }
  const navigate=async url=>{
    if(closing)throw Error('source capture already closed')
    await checkpoint('before-navigation')
    if(current){current.closed=true;await checkpoint('epoch-closed')}
    current={id:data.loadEpochs.length+1,url,ready:false,closed:false};data.loadEpochs.push(current)
    const nav=await cdp.send('Page.navigate',{url})
    if(nav.errorText||!nav.loaderId)throw Error('source navigation requires a new document: '+JSON.stringify(nav))
    Object.assign(current,{loaderId:nav.loaderId,frameId:nav.frameId});loaders.set(nav.loaderId,current)
    // Page.navigate may resolve before the old execution context is replaced. Gate
    // installation on the new loader and its complete document, never the old engine.
    const deadline=Date.now()+timeoutMs
    while(Date.now()<deadline){
      const tree=await cdp.send('Page.getFrameTree')
      if(tree.frameTree.frame.loaderId===nav.loaderId){
        try{if(await cdp.eval('document.readyState === "complete"')===true)return current}catch{/* context being replaced */}
      }
      await new Promise(r=>setTimeout(r,25))
    }
    throw Error('source navigation document timeout for epoch '+current.id)
  }
  const ready=async()=>{await checkpoint('install-ready');current.ready=true;await checkpoint('install-persisted')}
  const close=()=>closing??=(async()=>{
    // Detach before draining body/file writes: no recording reload can enter the
    // manifest while it is being finalized. Unfinished requests remain invalid.
    ws.removeEventListener('message',listener)
    if(current)current.closed=true
    await flush()
    Object.assign(data.sourceCapture,{closed:true,closedAt:new Date().toISOString(),epochs:data.loadEpochs.map(e=>e.id)})
    await checkpoint('capture-close')
  })()
  return {navigate,ready,checkpoint,close}
}

// recordNormal reloads the page. Its document is explicitly outside both measured
// source epochs; endpoint hashes after recording are a separate stability proof.
export async function closeSourcesBeforeRecording({capture,data,record}) {
  await capture.close()
  if(!record)return
  data.recordingSourceScope={scope:'separate recording reload; not one of the two measured source epochs',measuredEpochs:data.loadEpochs.map(e=>({id:e.id,loaderId:e.loaderId})),sourceCaptureClosedAt:data.sourceCapture.closedAt,startedAt:new Date().toISOString(),actualLoadedSourcesMeasured:false,sourceEndDirectory:'source-end'}
  data.normalRAF=await record()
}
