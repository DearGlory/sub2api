/** Audit saved real-run evidence; no synthetic images or inferred screenshots. */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import assert from 'node:assert/strict'
import { decodePng } from './tail-probe-lib/png.mjs'

const root=resolve(process.argv[2]||'evidence/starflow')
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex')
const checks=[]
for(const mode of ['baseline','stopped','outward','dark']){
 const dir=join(root,'verified-'+mode), r=JSON.parse(readFileSync(join(dir,'result.json')))
 assert.equal(r.exit,0);assert.equal(r.pass,true);assert.equal(r.noHmr,true);assert.equal(r.controlEffective,true)
 assert.equal(r.methodHash,hash(new URL('./star-flow-probe.mjs',import.meta.url)))
 assert.equal(r.pageMethodHash,hash(new URL('./star-flow-page.mjs',import.meta.url)))
 assert.deepEqual(r.runtimeHashes,r.runtimeHashesAfter);assert.deepEqual(r.sourceBefore,r.sourceAfter)
 for(const run of r.runs){
  const prefix=mode==='baseline'?run.phase:'control'
  for(const side of ['a','b']){
   const png=readFileSync(join(dir,prefix+'-'+side+'.png')),img=decodePng(png)
   assert.equal(img.w,1440);assert.equal(img.h,900)
   const {state}=JSON.parse(readFileSync(join(dir,prefix+'-'+side+'.state.json')))
   assert.equal(state.layers.length,4);assert.equal(state.projection.length,16);assert.equal(state.view.length,16)
   for(const layer of state.layers){assert.equal(layer.matrixWorld.length,16);assert(layer.rows.length>0)}
  }
  if(mode==='baseline'){
   assert(run.pass);assert(run.pixels.n>=8);assert(run.dz>.2);assert(run.pixels.median < -run.floor)
   assert(run.rows.every(row=>row.errorA<=1.5&&row.errorB<=1.5))
   assert(run.pixels.inward>run.pixels.n/2)
  }else assert.equal(run.pass,false)
 }
 if(mode==='baseline')for(const s of Object.values(r.phaseSummary)){assert(s.frames>0);assert(s.inward>s.eligible/2);assert.equal(s.outward,0)}
 if(mode==='stopped'){assert.equal(r.runs[0].dz,0);assert(Math.abs(r.runs[0].projected.median)<1e-6)}
 if(mode==='outward'){assert(r.runs[0].dz>.2);assert(r.runs[0].pixels.median>r.runs[0].floor);assert.equal(r.runs[0].pixels.inward,0)}
 if(mode==='dark'){assert(r.runs[0].dz>.2);assert.equal(r.runs[0].pixels.n,0);assert.deepEqual(r.runs[0].candidates,[0,0])}
 checks.push({mode,exit:r.exit,noHmr:r.noHmr,methodHash:r.methodHash,pairs:r.runs.length})
}
writeFileSync(join(root,'evidence-check.json'),JSON.stringify({pass:true,checks},null,2))
console.log('PASS: actual screenshots, source/runtime hashes, four normal phases and three effective rejection controls. EXIT=0')
