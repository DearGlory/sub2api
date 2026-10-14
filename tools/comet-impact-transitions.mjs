// Re-score the ORIGINAL full transition criterion from preserved full raw geometries.
// Never substitutes bounded impact samples or changes the old acceleration/motion limits.
import fs from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { hash } from './comet-impact-baseline.mjs'
import { transitions, resultStatus } from './comet-material-checks.mjs'
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>v.startsWith('--')?[...a,[v.slice(2),s[i+1]]]:a,[]))
for(const k of ['input','out'])if(!args[k])throw Error('required --'+k)
await fs.mkdir(args.out,{recursive:true})
const result={scope:'original complete material transition checks only; does not supersede full material result or impact/world checks',checks:[]}
try{
  const bytes=await fs.readFile(args.input),data=JSON.parse(bytes),dir=path.dirname(path.resolve(args.input));result.input={file:path.resolve(args.input),sha256:hash(bytes),originalStatus:data.status};result.runs=[]
  for(const run of data.runs||[]){const rows=[],raw=[];for(const row of run.rows){const b=await fs.readFile(path.join(dir,row.raw.file));if(hash(b)!==row.raw.sha256)throw Error('raw hash mismatch '+row.raw.file);const r=JSON.parse(gunzipSync(b));if(r.positions.length!==row.positions.count)throw Error('full geometry count mismatch');rows.push({...r,kind:row.kind,q:row.q});raw.push({...row.raw,count:r.positions.length})}result.runs.push({name:run.name,cadence:run.cadence,raw});result.checks.push(...transitions(rows).map(c=>({...c,id:run.name+'-'+c.id})))}
  if(!result.runs.length)throw Error('no complete transition runs')
  result.status=resultStatus(result.checks)
}catch(error){result.status='instrument-invalid';result.error=String(error.stack)}
result.exitCode={pass:0,fail:1,'instrument-invalid':2,skip:3}[result.status];await fs.writeFile(path.join(args.out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,runs:result.runs?.length,checks:result.checks.length,error:result.error}));process.exitCode=result.exitCode
