// Rejudge immutable raw geometry and screenshots without another product run.
import fs from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import crypto from 'node:crypto'
import { judgeMaterial, resultStatus } from './comet-material-checks.mjs'
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>v.startsWith('--')?[...a,[v.slice(2),s[i+1]]]:a,[]))
for(const k of ['input','out'])if(!args[k])throw Error('required --'+k)
const input=path.resolve(args.input),dir=path.dirname(input),bytes=await fs.readFile(input),data=JSON.parse(bytes)
async function hydrate(row){if(!row.raw)throw Error('missing raw geometry manifest');const b=await fs.readFile(path.join(dir,row.raw.file));if(crypto.createHash('sha256').update(b).digest('hex')!==row.raw.sha256)throw Error('raw geometry SHA mismatch');return {...row,...JSON.parse(gunzipSync(b))}}
for(const r of data.travel)r.geometry=await hydrate(r.geometry)
for(const run of data.runs)for(let i=0;i<run.rows.length;i++)run.rows[i]=await hydrate(run.rows[i])
for(let i=0;i<data.hold.length;i++)data.hold[i]=await hydrate(data.hold[i])
const baseline=args.baseline?JSON.parse(await fs.readFile(args.baseline)):data,checks=judgeMaterial(data,baseline)
const result={input,observationsSHA256:crypto.createHash('sha256').update(bytes).digest('hex'),status:resultStatus(checks),checks,note:'recomputed from preserved actual observations; no new rendering and no fabricated samples'}
await fs.writeFile(args.out,JSON.stringify(result,null,2));console.log(result.status);for(const c of checks)console.log(c.status+': '+c.id)
process.exitCode={pass:0,fail:1,'instrument-invalid':2,skip:3}[result.status]
