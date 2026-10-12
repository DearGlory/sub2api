export const SOURCE_MODULES=['spaceMotion','spaceMotionContract','flightPath','flightTiming','choreography','constants','types','ParticleEngine','cometVisualContract','cometVisual','cometSurface','cometVolume','cometTransition','cometEventField']
const emptyHash='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const moduleName=url=>{try{return new URL(url).pathname.match(/\/src\/features\/home-particle\/engine\/([^/]+)\.ts$/)?.[1]}catch{return null}}

export function loadedSourceCheck(data) {
  const sources=data.sources||[],loaded=data.loaded||[],epochs=data.loadEpochs||[],issues=[]
  if(epochs.length!==2||epochs[0]?.id!==1||epochs[1]?.id!==2)issues.push('exactly two distinct navigation epochs required')
  if(!epochs[0]?.loaderId||!epochs[1]?.loaderId||epochs[0].loaderId===epochs[1].loaderId)issues.push('distinct document loader IDs required')
  const expected=SOURCE_MODULES.map(name=>{
    const candidates=sources.filter(s=>s.name===name),s=candidates[0]
    // Only the known type-only module may be erased. Empty JS proves no original TS;
    // frozen-motion attribution remains the separate local/git check.
    const erased=name==='types'&&s?.erased===true&&s.sha256===emptyHash&&s.originalSha256===null
    const valid=candidates.length===1&&s.module===true&&(erased||s.erased===false&&validHash(s.originalSha256))
    if(!valid)issues.push('missing/invalid fetched original: '+name)
    return {name,original:s?.originalSha256??null,erased,valid}
  })
  const badRows=loaded.filter(row=>row.error||row.finished!==true||row.persisted!==true||!row.file||!validHash(row.sha256)||!row.responseReceived||!(row.status>=200&&row.status<300)||!epochs.some(e=>e.id===row.epoch&&e.loaderId===row.loaderId&&e.frameId===row.frameId))
  if(badRows.length)issues.push('failed, unfinished, unpersisted or unattributed engine requests')
  const detail=epochs.map(epoch=>{
    const rows=loaded.filter(r=>r.epoch===epoch.id)
    const checkpoint=epoch.checkpoints?.find(c=>c.label==='install-persisted')
    if(!epoch.ready||!checkpoint||checkpoint.requests===0||checkpoint.requests!==checkpoint.persisted)issues.push('install boundary did not persist every request: epoch '+epoch.id)
    if(epoch.id===1&&(!epoch.closed||!epoch.checkpoints?.some(c=>c.label==='epoch-closed'&&c.requests===rows.length&&c.persisted===rows.length)))issues.push('first epoch not persisted before next navigation')
    const modules=expected.map(source=>{
      const observations=rows.filter(r=>moduleName(r.url)===source.name)
      const matches=source.valid&&(source.erased
        ? observations.every(r=>!r.error&&r.persisted&&r.sha256===emptyHash&&r.originalSha256===null)
        : observations.length>0&&observations.every(r=>!r.error&&r.persisted&&r.originalFile&&r.originalSha256===source.original))
      return {...source,count:observations.length,matches,observations:observations.map(r=>({requestId:r.requestId,file:r.file,originalFile:r.originalFile,sha256:r.sha256,originalSha256:r.originalSha256,error:r.error})),...(source.erased?{attribution:'type-only module erased by Vite; no runtime original-source proof; local/git attribution is separate'}:{})}
    })
    if(modules.some(m=>!m.matches))issues.push('missing or mismatched originals: epoch '+epoch.id)
    return {id:epoch.id,loaderId:epoch.loaderId,requests:rows.length,persisted:rows.filter(r=>r.persisted).length,modules}
  })
  return {id:'actual-loaded-original-sources',status:issues.length?'instrument-invalid':'pass',detail:{issues,epochs:detail,failedRequests:badRows}}
}
