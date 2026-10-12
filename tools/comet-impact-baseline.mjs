import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { pixels, sizeExposure, eventObjects, resultStatus } from './comet-impact-checks.mjs'
export const hash=b=>crypto.createHash('sha256').update(b).digest('hex')
export const FROZEN=['spaceMotion','spaceMotionContract','flightPath','flightTiming','choreography','constants','types']
export const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
export const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',maxBuffer:8*1024*1024})
export const original=text=>{const m=text.match(/sourceMappingURL=data:application\/json;base64,([^\s]+)/);if(!m)return null;const map=JSON.parse(Buffer.from(m[1],'base64'));return map.sourcesContent?.length===1?map.sourcesContent[0]:null}
export async function loadBaseline(file,out) {
  const dir=path.dirname(path.resolve(file)),bytes=await fs.readFile(file),data=JSON.parse(bytes),artifacts=[],sources=[]
  const revision=git('rev-parse','2acd2457e').trim()
  const verifiedRead=async(ref)=>{const b=await fs.readFile(path.join(dir,ref.file));const actual=hash(b);if(actual!==ref.sha256)throw Error('baseline hash mismatch: '+ref.file);artifacts.push({file:path.join(dir,ref.file),sha256:actual,bytes:b.length});return b}
  for(const row of data.travel){
    const body=row.files.find(f=>f.file===row.label+'-body.png'),empty=row.files.find(f=>f.file===row.label+'-empty.png')
    const png=await verifiedRead(body),black=await verifiedRead(empty)
    row.recordedBodyPixels=row.bodyPixels;row.bodyPixels=pixels(png,black)
    if(JSON.stringify(row.recordedBodyPixels)!==JSON.stringify(row.bodyPixels))throw Error('baseline PNG metric mismatch '+row.label)
    // Reused immutable raw remains outside this run; no huge decompressed JSON copies.
    const raw=JSON.parse(gunzipSync(await verifiedRead(row.geometry.raw)))
    if(raw.t!==row.pose.t)throw Error('baseline raw/pose mismatch')
  }
  for(const row of data.sources){
    const served=await verifiedRead({file:'source-start/'+row.name+'.js',sha256:row.sha256})
    const raw=original(served.toString()),gitFile='frontend/src/features/home-particle/engine/'+row.name+'.ts',expected=git('show',revision+':'+gitFile)
    // Vite erases a type-only module entirely. Preserve git's original as a separate
    // attribution, never claim the empty served response proves erased TypeScript.
    const erased=raw===null&&served.length===0
    if(!erased&&raw!==expected)throw Error('baseline source is not '+revision+': '+row.name)
    sources.push({name:row.name,gitFile,revision,servedSha256:row.sha256,originalSha256:hash(expected),mappedOriginalSha256:raw===null?null:hash(raw),erased,verified:!erased})
    if(out){await fs.mkdir(path.join(out,'baseline-original'),{recursive:true});await fs.writeFile(path.join(out,'baseline-original',row.name+'.ts'),expected)}
  }
  const visual=git('show',revision+':frontend/src/features/home-particle/engine/cometVisual.ts')
  const absent=eventObjects(data.meta.inventory).length===0&&!/createCometEventField|cometEventField/.test(visual)
  data.verified=true;data.provenance={path:path.resolve(file),sha256:hash(bytes),revision,artifacts,sources,eventImplementation:absent?'notimplemented':'observed',attribution:'original source map equals git 2acd2457e; erased types explicitly attributed to git only; no live 5210 used'}
  return data
}
export async function motionEvidence(sources,out) {
  const rows=[]
  for(const name of FROZEN){
    const r=sources.find(r=>r.name===name),expected=git('show','2acd2457e:frontend/src/features/home-particle/engine/'+name+'.ts')
    const row={name,baselineOriginalHash:hash(expected),servedHash:r?.sha256,originalHash:r?.originalSha256,erased:r?.erased===true}
    row.status=r?.originalSha256===row.baselineOriginalHash?'pass':row.erased?'instrument-invalid':'fail'
    // Erased type code has no runtime execution. The frozen local git source is recorded,
    // while the erased response remains explicit rather than being fabricated from it.
    if(row.erased){row.localHash=hash(await fs.readFile(path.join(repo,'frontend/src/features/home-particle/engine',name+'.ts')));row.status=row.localHash===row.baselineOriginalHash?'pass':'fail';row.attribution='local frozen source + erased runtime module, not remote source proof'}
    rows.push(row)
  }
  const engine=sources.find(r=>r.name==='ParticleEngine'),current=engine?.originalText,baseline=git('show','2acd2457e:frontend/src/features/home-particle/engine/ParticleEngine.ts')
  for(const name of ['advanceCamera','updateCameraFit','resize','applyViewportSway']){
    const re=new RegExp('^  (?:private )?'+name+'\\([^\\n]*\\{[\\s\\S]*?^  \\}', 'm'),a=current?.match(re)?.[0],b=baseline.match(re)?.[0]
    rows.push({name:'ParticleEngine.'+name,status:a&&b&&a===b?'pass':'instrument-invalid',originalHash:a?hash(a):null,baselineOriginalHash:b?hash(b):null})
  }
  const cameraLines=s=>s?.split('\n').filter(line=>/this\.camera\.|new PerspectiveCamera|CAMERA_(?:FOV|NEAR|FAR)/.test(line)).join('\n')
  rows.push({name:'ParticleEngine.camera-access-lines',status:current&&cameraLines(current)===cameraLines(baseline)?'pass':'instrument-invalid',originalHash:current?hash(cameraLines(current)):null,baselineOriginalHash:hash(cameraLines(baseline))})
  const result={status:resultStatus(rows),rows,contractExcluded:'cometVisualContract authorized geometry only; no motion source exclusion'}
  if(out)await fs.writeFile(path.join(out,'frozen-motion.json'),JSON.stringify(result,null,2))
  return result
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>v.startsWith('--')?[...a,[v.slice(2),s[i+1]]]:a,[]))
  if(!args.baseline||!args.out)throw Error('required --baseline result.json --out directory')
  await fs.mkdir(args.out,{recursive:true});const result={scope:'immutable 2acd2457e scored against new impact contract; expected FAIL'}
  try{const base=await loadBaseline(args.baseline,args.out);result.provenance=base.provenance;result.width=base.width;result.height=base.height;result.theme=base.theme;result.checks=base.travel.flatMap(r=>sizeExposure(r.bodyPixels,r.bodyPixels,true,base.theme).map(c=>({...c,id:r.label+'-'+c.id})));result.checks.push({id:'event-implemented',status:base.provenance.eventImplementation==='notimplemented'?'fail':'pass',detail:base.provenance.eventImplementation});result.normalRAF=base.normalRAF;result.status=resultStatus(result.checks)}catch(error){result.status='instrument-invalid';result.error=String(error.stack)}
  result.exitCode={pass:0,fail:1,'instrument-invalid':2,skip:3}[result.status];await fs.writeFile(path.join(args.out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,exitCode:result.exitCode,checks:result.checks?.map(c=>({id:c.id,status:c.status})),error:result.error}));process.exitCode=result.exitCode
}
