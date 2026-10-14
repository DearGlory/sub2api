import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { encodePng } from './tail-probe-lib/png.mjs'
import { pixels,sizeExposure,eventChecks,eventObjects,shaderEvidence } from './comet-impact-checks.mjs'
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>v.startsWith('--')?[...a,[v.slice(2),s[i+1]]]:a,[]))
if(!args.out)throw Error('required --out')
await fs.mkdir(args.out,{recursive:true})
const result={scope:'synthetic unit fixtures only; never product evidence',cases:[]}
function image(radius,value){const rgb=Buffer.alloc(128*128*3);for(let y=0;y<128;y++)for(let x=0;x<128;x++)if(Math.hypot(x-64,y-64)<=radius)rgb.fill(value,(y*128+x)*3,(y*128+x)*3+3);return encodePng(128,128,rgb)}
const empty=image(0,0),baseline=image(20,80),positive=image(24,60)
for(const [name,png]of Object.entries({empty,baseline,positive,bright:image(24,160),small:image(17,60)}))await fs.writeFile(path.join(args.out,name+'.png'),png)
const bp=pixels(baseline,empty),pp=pixels(positive,empty)
const record=(name,fn)=>{fn();result.cases.push({name,status:'pass'})}
record('bigger-darker-positive',()=>assert(sizeExposure(pp,bp).every(c=>c.status==='pass')))
record('overbright-negative',()=>assert.equal(sizeExposure(pixels(image(24,160),empty),bp)[1].status,'fail'))
record('smaller-negative',()=>assert.equal(sizeExposure(pixels(image(17,60),empty),bp)[0].status,'fail'))
record('light-is-not-brightness',()=>assert.equal(sizeExposure(pp,bp,true,'light')[1].status,'skip'))
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],matrix=[2,0,0,0,0,2,0,0,0,0,2,0,0,0,0,1]
const fragment=`uniform vec3 uHead;uniform vec3 uCameraFrame;
float density(vec3 p) {
 return exp(-length(p-uHead));
}
void main(){vec3 ray=normalize(vFrame-uCameraFrame);float opacity=0.0;for(int i=0;i<24;i++){vec3 p=uCameraFrame+ray*(enter+(float(i)+.5)*stepLength);float d=density(p);float a=1.0-exp(-d*stepLength);opacity+=(1.0-opacity)*a;}gl_FragColor=vec4(vec3(.5),opacity);}`
const uniforms={uEventMode:1,uEventProgress:.25,uEventStrength:.8,uHead:[0,0,0],uRadius:1}
const row={label:'synthetic',kind:'gather',q:.25,pose:{head:[0,0,0],bodyMatrix:identity},inventory:[{isMesh:true,uuid:'test',visible:true,geometryType:'BoxGeometry',span:[1,1,1],triangles:12,matrix,parentMatrix:identity,worldCenter:[0,0,0],gpuAttributes:{attributes:{position:{exact:true}}},materials:[{linked:true,uniforms,gpuUniforms:structuredClone(uniforms),vertex:'modelViewMatrix',fragment}]}],eventPixels:pp,pageDelta:pp,depth:{status:'observed',near:pp,far:pp,difference:pp,rotate:pp,translate:pp,frozen:true}}
row.eventGPU={uniforms:{...structuredClone(uniforms),modelViewMatrix:matrix},expectedModelView:matrix}
record('event-positive-fixture',()=>assert(eventChecks(row).every(c=>c.status==='pass'),JSON.stringify(eventChecks(row))))
const neg=(name,mutate,id)=>record(name,()=>{const r=structuredClone(row);mutate(r);const checks=eventChecks(r);assert(checks.some(c=>c.status==='fail'&&c.id.endsWith(id)),JSON.stringify(checks))})
neg('noevent-negative',r=>r.inventory=[],'event-implemented')
neg('zeroOpacity-negative',r=>{r.eventPixels=pixels(empty,empty);r.pageDelta=r.eventPixels},'event-visible-contribution')
neg('always-on-phase-negative',r=>{r.kind='hold';r.q=.5},'event-hidden-zero')
neg('2D-board-negative',r=>{r.inventory[0].matrix[10]=.00001},'event-local-box')
neg('CPU-unlinked-negative',r=>{r.inventory[0].materials[0].uniforms.uHead[0]=3},'event-linked-GPU')
neg('head-unanchored-negative',r=>{r.eventGPU.uniforms.uHead[0]=3},'event-world-head')
neg('empty-depth-negative',r=>{r.depth.far=pixels(empty,empty)},'event-image-depth')
record('comments-names-not-3D-proof',()=>assert.equal(shaderEvidence('modelViewMatrix','// density(vec3 p) for(int i=0;i<24;i++)\nvoid main(){gl_FragColor=vec4(1.0);}').status,'instrument-invalid'))
record('tail-is-not-event',()=>assert.equal(eventObjects([{isMesh:true,name:'comet-event-field',materials:[{uniforms:{uBins:[],uDensities:[]},fragment}]}]).length,0))
result.status='pass';await fs.writeFile(path.join(args.out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
