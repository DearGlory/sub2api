import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { transitions, judgeMaterial, pixels } from './comet-material-checks.mjs'
import { encodePng } from './tail-probe-lib/png.mjs'
import { volumeProvenance } from './comet-material-volume.mjs'
const out=process.argv[2];if(!out)throw Error('provide evidence output directory')
await fs.mkdir(path.resolve(out),{recursive:true})
const dirs=Array.from({length:96},(_,i)=>{const z=2*(i+.5)/96-1,a=i*2.3999632297,r=Math.sqrt(1-z*z);return [r*Math.cos(a),r*Math.sin(a),z]})
const origin=[3,0,24],point=(d,r)=>d.map((v,j)=>origin[j]+v*r)
const glyph=dirs.map(d=>point(d,3)),offsets=dirs.map(d=>d.map(v=>v*.7))
const make=(kind,q,r,t)=>({kind,q,t,phase:kind,p:kind==='scatter'?q*.62:q,head:origin,brand:'synthetic-only',positions:dirs.map(d=>point(d,r)),glyph,source:dirs.map(d=>point(d,kind==='gather'?.7:3)),offsets,glyphFlow:dirs.map(()=>[0,0,0])})
const rows=[...[0,.05,.1,.18,.25,.4,.7,1].map(q=>make('gather',q,.7+2.3*q,6.5+1.4*q)),...[0,.05,.2,.4,.5,.6,.8,.92,.99,1].map(q=>make('scatter',q,3-2.3*q*q,10.9+.682*q))]
const check=(name,r,id,want)=>{const c=transitions(r).find(c=>c.id===id);assert.equal(c?.status,want,name+': '+JSON.stringify(c));return {name,criterion:id,status:c.status,expected:want,passed:true}}
const tests=[]
for(const c of transitions(rows))assert.equal(c.status,'pass',JSON.stringify(c))
tests.push({name:'synthetic positive',passed:true,note:'judge self-proof only; no product acceptance'})
let bad=structuredClone(rows);for(const r of bad.filter(r=>r.kind==='gather'&&r.q<1))r.positions=dirs.map(d=>point(d,.7));tests.push(check('no explosion',bad,'gather-internal-explosion','fail'))
bad=structuredClone(rows);for(const r of bad.filter(r=>r.kind==='scatter'))r.positions=dirs.map(d=>point(d,3-2.3*r.q));tests.push(check('linear collapse',bad,'scatter-accelerating-collapse','fail'))
bad=structuredClone(rows);for(const r of bad.filter(r=>r.kind==='gather')){r.head=r.head.map((v,j)=>v+(j===0?r.q:0));r.positions=r.positions.map(p=>p.map((v,j)=>v+(j===0?r.q:0)))}tests.push(check('world drift',bad,'gather-world-anchor','fail'))
const image=(radius,intensity)=>{const b=Buffer.alloc(128*128*3);for(let y=0;y<128;y++)for(let x=0;x<128;x++)if(Math.hypot(x-64,y-64)<=radius){const v=Math.round(intensity*(.55+.45*x/128));for(let j=0;j<3;j++)b[(y*128+x)*3+j]=v}return encodePng(128,128,b)}
const empty=encodePng(128,128,Buffer.alloc(128*128*3)),old=pixels(image(20,240),empty),bigger=pixels(image(30,140),empty)
const surface={uuid:'surface',isMesh:true,normalCount:100,positionCount:100,triangles:196,span:[1.44,1.3,1.2],radiusQuantiles:[.55,.68,.78],normalRange:[1,1],bytes:2048,materials:[{linked:true,roughness:.8,fragment:'normal'}]}
const volume={uuid:'tail',isMesh:true,normalCount:0,positionCount:8,triangles:12,span:[3,3,12],bytes:256,materials:[{linked:true,fragment:'vec3 p; for(int i=0;i<24;i++){float density=0.1;}'}]}
const row={label:'synthetic',pose:{head:origin,camera:[1,0,0,1]},inventory:[surface,volume],contributions:{surface:bigger,tail:bigger},bodyPixels:bigger}
const base={travel:[{...row,bodyPixels:old}]}
const material=(name,r,id,want)=>{const c=judgeMaterial({travel:[r],errors:[],sourceStable:true},base).find(c=>c.id==='synthetic-'+id);assert.equal(c?.status,want,name+': '+JSON.stringify(c));tests.push({name,criterion:id,status:c.status,expected:want,passed:true})}
material('pixel size positive',row,'size','pass');material('pixel exposure positive',row,'exposure','pass')
material('no mesh',{...row,inventory:[volume]},'mesh-normals-triangles','fail')
material('only points / no volume',{...row,inventory:[surface]},'volume-draw','fail')
material('opacity zero tail',{...row,contributions:{surface:bigger,tail:pixels(empty,empty)}},'volume-draw','fail')
material('overexposed',{...row,bodyPixels:pixels(image(30,255),empty)},'exposure','fail')
material('shrunken',{...row,bodyPixels:pixels(image(12,140),empty)},'size','fail')
material('same old bright sphere',{...row,bodyPixels:old},'size','fail')
const bins=Array(80).fill(0),densities=Array(20).fill(0),axes=Array(80).fill(0);bins.splice(4,4,1,2,3,.129);densities[1]=.5;axes.splice(4,4,1,0,0,.1935)
const proofObject={materials:[{linked:true,fragment:'#define IS_COMA 0\n uniform vec4 uBinAxes[20]; density(p);uCameraFrame + ray;1.0-exp(-d);p-uBins[j].xyz;uBins[j].w;uBinAxes[j].xyz;uBinAxes[j].w; dot(d,axis);d-axis*along;r2-s*s',uniforms:{uBins:bins,uBinAxes:axes,uDensities:densities},gpuUniforms:{'uBins[0]':Array.from({length:20},(_,i)=>bins.slice(i*4,i*4+4)),'uBinAxes[0]':Array.from({length:20},(_,i)=>axes.slice(i*4,i*4+4)),'uDensities[0]':densities.slice()}}]}
const proofGeometry={tail:{births:[{birthTime:1,age:.2,life:2,position:[1,2,3]}]}}
assert.equal(volumeProvenance(proofObject,proofGeometry).status,'pass');tests.push({name:'synthetic anisotropic pool/GPU mapping positive',passed:true})
const fake=structuredClone(proofObject);fake.materials[0].gpuUniforms['uBinAxes[0]'][1][0]=9;assert.equal(volumeProvenance(fake,proofGeometry).status,'fail');tests.push({name:'axes GPU mismatch',passed:true,expected:'fail'})
const invalidAxis=structuredClone(proofObject);invalidAxis.materials[0].uniforms.uBinAxes[4]=2;invalidAxis.materials[0].gpuUniforms['uBinAxes[0]'][1][0]=2;assert.equal(volumeProvenance(invalidAxis,proofGeometry).status,'fail');tests.push({name:'non-unit axis / invalid radius',passed:true,expected:'fail'})
assert.equal(volumeProvenance(proofObject,{tail:{births:[]}}).status,'fail');tests.push({name:'no births with prelaid density',passed:true,expected:'fail'})
const noBirthField=structuredClone(proofGeometry);delete noBirthField.tail.births;assert.equal(volumeProvenance(proofObject,noBirthField).status,'instrument-invalid');tests.push({name:'missing birth provenance',passed:true,expected:'instrument-invalid'})
const legacy=structuredClone(proofObject);legacy.materials[0].uniforms.uBinAxes=undefined;legacy.materials[0].gpuUniforms['uBinAxes[0]']=undefined;legacy.materials[0].fragment+='\n vec3 d = (p-uBins[j].xyz) / max(uBins[j].w, 0.01);';assert.equal(volumeProvenance(legacy,proofGeometry).status,'fail');tests.push({name:'legacy spherical layout negative baseline',passed:true,expected:'fail'})
const result={status:'pass',scope:'synthetic judge self-proof ONLY, never product evidence',tests}
await fs.writeFile(path.join(out,'selftest.json'),JSON.stringify(result,null,2))
await fs.writeFile(path.join(out,'synthetic-baseline.png'),image(20,240));await fs.writeFile(path.join(out,'synthetic-positive.png'),image(30,140))
console.log(JSON.stringify(result,null,2))
