import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createSourceCapture, closeSourcesBeforeRecording } from './comet-impact-sources.mjs'
import { AUXILIARY_SCOPE, isKnownDedicatedWorker, loadedSourceCheck } from './comet-impact-source-checks.mjs'
import { hash } from './comet-impact-baseline.mjs'

const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>v.startsWith('--')?[...a,[v.slice(2),s[i+1]]]:a,[]))
if(!args.out||!args.evidence)throw Error('required --out directory --evidence original result.json')
const out=path.resolve(args.out)
await fs.mkdir(out,{recursive:true})
const bytes=await fs.readFile(args.evidence),old=JSON.parse(bytes),tests=[]
const test=async(name,run)=>{await run();tests.push({name,status:'pass'})}
const epoch=old.loadEpochs[1],worker=old.loaded.find(r=>r.loaderId===''&&r.url.endsWith('/brandTargets.worker.ts?worker_file&type=module'))
assert(worker,'real evidence must contain the known worker request')
const prefix=new URL('/src/features/home-particle/engine/',epoch.url).href
await test('old-real-evidence-still-invalid',()=>assert.equal(loadedSourceCheck(old).status,'instrument-invalid'))
await test('exact-real-worker-classified',()=>assert.equal(isKnownDedicatedWorker(worker,epoch),true))
const variants=[
  ['ParticleEngine-disguised-as-worker',{url:prefix+'ParticleEngine.ts?worker_file&type=module'}],
  ['other-worker',{url:prefix+'other.worker.ts?worker_file&type=module'}],
  ['wrapper-not-worker-entry',{url:prefix+'brandTargets.worker.ts?worker&type=module'}],
  ['missing-worker-file',{url:prefix+'brandTargets.worker.ts?type=module'}],
  ['wrong-worker-type',{url:prefix+'brandTargets.worker.ts?worker_file&type=classic'}],
  ['nonempty-worker-file',{url:prefix+'brandTargets.worker.ts?worker_file=1&type=module'}],
  ['extra-query',{url:worker.url+'&extra=1'}],
  ['duplicate-query',{url:worker.url+'&type=module'}],
  ['foreign-origin',{url:worker.url.replace(new URL(epoch.url).origin,'https://example.invalid')}],
  ['nonempty-loader',{loaderId:epoch.loaderId}],
  ['missing-loader',{loaderId:undefined}],
  ['wrong-frame',{frameId:'other-frame'}],
]
for(const [name,change] of variants)await test('reject-'+name,()=>assert.equal(isKnownDedicatedWorker({...worker,...change},epoch),false))

// A unit fixture derived from the real two document rows, not a rewritten run.
// Invented close checkpoints here only exercise gate branches; the live controls
// separately establish that production capture writes those boundaries itself.
const fixture=structuredClone(old)
fixture.loaded=fixture.loaded.filter(r=>fixture.loadEpochs.some(e=>e.id===r.epoch&&e.loaderId===r.loaderId))
fixture.auxiliaryRequests=[{...worker,scope:AUXILIARY_SCOPE}]
fixture.sourceCapture={closed:true}
for(const e of fixture.loadEpochs){
  e.closed=true
  const n=fixture.loaded.filter(r=>r.epoch===e.id).length
  e.checkpoints.push({label:e.id===1?'epoch-closed':'capture-close',requests:n,finished:n,persisted:n})
}
await test('unit-fixture-page-rows-and-worker-pass',()=>assert.equal(loadedSourceCheck(fixture).status,'pass'))
const invalid=(name,mutate)=>test(name,()=>{const d=structuredClone(fixture);mutate(d);assert.equal(loadedSourceCheck(d).status,'instrument-invalid')})
for(const [name,change] of variants)await invalid('gate-rejects-auxiliary-'+name,d=>Object.assign(d.auxiliaryRequests[0],change))
await invalid('gate-rejects-unknown-document-loader',d=>d.loaded.push({...d.loaded[0],epoch:2,loaderId:'third-document'}))
await invalid('gate-rejects-unfinished-nonworker',d=>d.loaded.push({...worker,url:prefix+'unknown.ts'}))
await invalid('gate-rejects-unfinished-ParticleEngine-worker-disguise',d=>d.loaded.push({...worker,url:prefix+'ParticleEngine.ts?worker_file&type=module'}))
await invalid('gate-rejects-failed-page-request',d=>d.loaded[0].failed=true)
await invalid('gate-rejects-failed-known-worker',d=>d.auxiliaryRequests[0].failed=true)
await invalid('gate-rejects-hash-drift',d=>d.sources.find(r=>r.name==='ParticleEngine').originalSha256=hash('wrong'))
await invalid('gate-rejects-body-loss',d=>d.loaded.find(r=>r.url.includes('/ParticleEngine.ts')).persisted=false)
await invalid('gate-rejects-unclosed-capture',d=>d.sourceCapture.closed=false)
await invalid('gate-rejects-unclosed-second-epoch',d=>d.loadEpochs[1].closed=false)

await test('capture-retains-worker-and-freezes-before-record-reload',async()=>{
  const ws=new EventTarget(),data={},body='unit test response',calls=[]
  let loaderId,release,requested
  const bodyRequested=new Promise(r=>{requested=r})
  const bodyReply=new Promise(r=>{release=r})
  const cdp={eval:async()=>true,send:async(method,params)=>{
    if(method==='Page.navigate'){loaderId='unit-loader-'+(data.loadEpochs.length);return {loaderId,frameId:'unit-frame'}}
    if(method==='Page.getFrameTree')return {frameTree:{frame:{loaderId}}}
    if(method==='Network.getResponseBody'){calls.push(params.requestId);requested();return bodyReply}
    throw Error('unexpected method '+method)
  }}
  const emit=(method,params)=>ws.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({method,params:{timestamp:1,...params}})}))
  const request=(requestId,url,loader=loaderId)=>emit('Network.requestWillBeSent',{requestId,loaderId:loader,frameId:'unit-frame',request:{url}})
  const capture=createSourceCapture({cdp,ws,out,data})
  await capture.navigate(epoch.url);await capture.ready()
  await capture.navigate(epoch.url);await capture.ready()
  request('worker',worker.url,'')
  assert.equal(data.auxiliaryRequests.length,1);assert.equal(data.loaded.length,0)
  assert.equal(data.auxiliaryRequests[0].scope,AUXILIARY_SCOPE)
  request('imposter',prefix+'ParticleEngine.ts?worker_file&type=module','')
  request('unknown-document',prefix+'unknown.ts','third-document')
  assert.equal(data.loaded.length,2)
  request('pending-body',prefix+'ParticleEngine.ts')
  emit('Network.responseReceived',{requestId:'pending-body',response:{url:prefix+'ParticleEngine.ts',status:200}})
  emit('Network.loadingFinished',{requestId:'pending-body'})
  await bodyRequested
  let recorded=false
  const completion=closeSourcesBeforeRecording({capture,data,record:async()=>{
    recorded=true
    assert.equal(data.sourceCapture.closed,true)
    assert(data.loadEpochs.every(e=>e.closed))
    assert.equal(data.loaded.find(r=>r.requestId==='pending-body').persisted,true)
    const before=JSON.stringify({loaded:data.loaded,auxiliary:data.auxiliaryRequests,epochs:data.loadEpochs})
    request('recording-runtime',prefix+'ParticleEngine.ts','recording-loader')
    request('recording-worker',worker.url,'')
    emit('Network.loadingFailed',{requestId:'pending-body',errorText:'late event'})
    assert.equal(JSON.stringify({loaded:data.loaded,auxiliary:data.auxiliaryRequests,epochs:data.loadEpochs}),before)
    return {status:'unit-recording-callback'}
  }})
  await Promise.resolve();assert.equal(recorded,false,'recording must wait for outstanding persistence')
  release({body,base64Encoded:false});await completion
  assert.equal(recorded,true);assert.deepEqual(calls,['pending-body'])
  assert.equal(data.recordingSourceScope.actualLoadedSourcesMeasured,false)
  assert.equal(hash(await fs.readFile(path.join(out,data.loaded.find(r=>r.requestId==='pending-body').file))),hash(body))
  const manifest=JSON.parse(await fs.readFile(path.join(out,'loaded-sources.json'),'utf8'))
  assert.deepEqual(manifest.loaded,data.loaded);assert.equal(manifest.sourceCapture.closed,true)
  assert.equal(manifest.auxiliaryRequests.length,1)
  await capture.close()
  await assert.rejects(capture.navigate(epoch.url),/already closed/)
})
await fs.writeFile(path.join(out,'result.json'),JSON.stringify({status:'pass',scope:'lightweight unit tests; mock CDP boundaries and explicitly derived fixtures, not live source acceptance',originalEvidence:args.evidence,originalSHA256:hash(bytes),tests},null,2))
console.log(JSON.stringify({status:'pass',tests:tests.length}))
