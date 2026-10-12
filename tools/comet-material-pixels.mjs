// Standalone numerical PNG evidence, using the identical threshold as the live probe.
import fs from 'node:fs/promises'
import { pixels } from './comet-material-checks.mjs'
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>v.startsWith('--')?[...a,[v.slice(2),s[i+1]]]:a,[]))
for(const k of ['image','empty','out'])if(!args[k])throw Error('required --'+k)
const current=pixels(await fs.readFile(args.image),await fs.readFile(args.empty))
const result={status:current.count>=12?'observed':'instrument-invalid',current,note:'standalone pixels only; no claim about mesh, timing or smoothness'}
if(args.baseline){if(!args['baseline-empty'])throw Error('required --baseline-empty');result.baseline=pixels(await fs.readFile(args.baseline),await fs.readFile(args['baseline-empty']));result.ratio=current.diameter/result.baseline.diameter}
await fs.writeFile(args.out,JSON.stringify(result,null,2));console.log(JSON.stringify(result))
