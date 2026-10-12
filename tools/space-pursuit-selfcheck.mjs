import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import {judge,exitFor,summarize} from './space-pursuit-lib/checks.mjs'
import {positiveFixture} from './space-pursuit-lib/fixtures.mjs'
const out=process.argv[2]||'E:/Global-session/xiao-20261012-231246/evidence/judge/controls.json'
const tests=[]
const allRows=d=>[...d.samples,...d.arrivals,...d.pairs.flatMap(p=>[p.before,p.enter,p.start,p.end,p.exit])]
function test(name,mutate,expected,gate) {
  const d=positiveFixture();mutate?.(d)
  const result=judge(d)
  const matched=gate?result.checks.filter(c=>c.id.startsWith(gate)):[]
  const ok=result.status===expected && (!gate||matched.some(c=>c.status===expected))
  tests.push({name,ok,expected,actual:result.status,gate,matched,failed:result.checks.filter(c=>c.status!=='pass').map(c=>c.id)})
}
test('synthetic valid XZ and perspective (checker positive only)',null,'pass')
test('copy/model fake synchronous head without geometry',d=>{for(const r of d.samples) if(r.phase==='travel'){r.geometry.center[2]-=10;r.headGeometryMaxError=10}},'fail','head-final-geometry-agreement')
test('declared model as head source',d=>{d.meta.headSource='spaceMotion.sample theoretical copy'},'instrument-invalid','actual-source')
test('constant gap camera ride',d=>{for(const r of allRows(d)) {r.head[2]=r.camera[2]-r.fitGap;r.glyph.center[2]=r.head[2];r.glyphProjected.size[0]=300;r.glyphProjected.size[1]=300}},'fail','hold-perspective-shrink')
test('single axis X moves Z parked',d=>{for(const r of d.samples)if(r.phase==='travel')r.head[2]=0},'fail','XZ-movement-support')
test('single axis Z moves X parked',d=>{for(const r of d.samples)if(r.phase==='travel')r.head[0]=0},'fail','XZ-movement-support')
test('hold shortened to two seconds',d=>{for(const p of d.pairs)p.exit.t=p.enter.t+2},'fail','hold-three-seconds')
test('camera reversal',d=>{d.cameraBoundary[2].camera[2]-=1},'fail','camera-150-152.2')
test('mid-flight X reversal',d=>{const r=d.samples.find(r=>r.t===14);r.head[0]+=3},'fail','X-one-sign')
test('different logo screenshot pair',d=>{d.pairs[0].end.brand='different-logo'},'fail','hold-perspective-shrink')
test('shrink only nine percent (floor unchanged)',d=>{const p=d.pairs[0];p.end.glyphProjected=structuredClone(p.end.glyphProjected);p.end.glyphProjected.size=p.start.glyphProjected.size.map(v=>v*.91)},'fail','hold-perspective-shrink')
test('capture outside 0.08',d=>{d.arrivals[0].gap=d.arrivals[0].fitGap-.081},'fail','stop-at-fitGap')
test('GPU geometry copy mismatch',d=>{d.gpu[0].attributes.position.exactGPU=false},'instrument-invalid','gpu-position3')
const baseline=JSON.parse(await fs.readFile('E:/Global-session/xiao-20261012-231246/evidence/judge/baseline/result.json','utf8'))
const old=judge(baseline)
tests.push({name:'actual served old 5210 rejected',ok:old.status==='fail',expected:'fail',actual:old.status,failed:old.checks.filter(c=>c.status==='fail').map(c=>c.id)})
for(const [status,code] of [['pass',0],['fail',1],['instrument-invalid',2],['skip',3]]) assert.equal(exitFor(status),code)
assert.equal(summarize([{status:'skip'}]),'skip')
assert.equal(summarize([{status:'fail'},{status:'skip'}]),'fail')
assert.equal(summarize([{status:'fail'},{status:'instrument-invalid'}]),'instrument-invalid')
await fs.writeFile(out,JSON.stringify({kind:'checker-only fixtures; never production acceptance',status:tests.every(t=>t.ok)?'pass':'fail',tests},null,2))
for(const t of tests) console.log((t.ok?'PASS':'FAIL')+' '+t.name+' => '+t.actual+(t.ok?'':' '+t.failed.join(',')))
process.exitCode=tests.every(t=>t.ok)?0:1
