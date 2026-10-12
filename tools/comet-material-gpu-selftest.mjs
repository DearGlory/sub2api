import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { CDP, connect, launchChrome } from './tail-probe-lib/cdp.mjs'
import { installSpaceProbe } from './space-pursuit-lib/page.mjs'
import { installMaterialProbe } from './comet-material-page.mjs'
import { pixels } from './comet-material-checks.mjs'
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>v.startsWith('--')?[...a,[v.slice(2),s[i+1]]]:a,[]))
for(const k of ['url','out','port','w','h','theme'])if(!args[k])throw Error('required --'+k)
const out=path.resolve(args.out),port=Number(args.port),width=Number(args.w),height=Number(args.h)
await fs.mkdir(out,{recursive:true})
await new Promise((r,j)=>{const s=net.createServer();s.once('error',j);s.listen(port,'127.0.0.1',()=>s.close(r))})
const browser=launchChrome({port,profile:path.join(out,'profile'),chrome:args.chrome||'C:/Program Files/Google/Chrome/Application/chrome.exe',w:width,h:height})
let cdp,ws;const result={scope:'SYNTHETIC GPU judge self-proof only; never product acceptance'}
const ev=async s=>{const r=await cdp.eval(s);if(r?.__error)throw Error(r.__error);return r}
try{
 ws=new WebSocket(await connect(port));await new Promise(r=>ws.addEventListener('open',r,{once:true}));cdp=new CDP(ws)
 await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await cdp.send('Page.navigate',{url:args.url})
 await ev('new Promise((r,j)=>{let n=0;const p=()=>window.__SUB2API_PARTICLE_ENGINE__?.currentBrandSlug?r(true):++n>200?j(Error("no engine")):setTimeout(p,100);p()})')
 await ev('('+installSpaceProbe.toString()+')()');await ev('__SPACE_PROBE.stop()');await ev('('+installMaterialProbe.toString()+')()')
 const source=await (await fetch(new URL('/src/features/home-particle/engine/ParticleEngine.ts',args.url))).text(),module=source.match(/from\s+['"]([^'"]*\/three\.js[^'"]*)['"]/)[1]
 result.created=await ev(`(async()=>{const T=await import(${JSON.stringify(module)}),e=__SPACE_PROBE.engine,s=e.choreography.state;const g=new T.IcosahedronGeometry(.72,4);const p=g.getAttribute('position');for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i),r=1+.08*Math.sin(x*17+y*11);p.setXYZ(i,x*r,y*r*.83,z*r)}g.computeVertexNormals();const m=new T.ShaderMaterial({uniforms:{uLightDirection:{value:new T.Vector3(.6,.5,1).normalize()},uOpacity:{value:1}},vertexShader:'varying vec3 vNormal; void main(){vNormal=normalMatrix*normal;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:'uniform vec3 uLightDirection;uniform float uOpacity;varying vec3 vNormal;void main(){vec3 N=normalize(vNormal),L=normalize(uLightDirection);gl_FragColor=vec4(vec3(.12+.5*max(0.,dot(N, L))),uOpacity);}',transparent:true});const mesh=new T.Mesh(g,m);mesh.position.set(s.headX,s.headY,s.headZ);mesh.position.add(e.points.position);e.scene.add(mesh);window.__JUDGE_SYNTH=mesh;e.renderer.render(e.scene,e.camera);return {uuid:mesh.uuid,head:[s.headX,s.headY,s.headZ]}})()`)
 result.inventory=await ev('__MATERIAL_PROBE.inventory()');const mesh=result.inventory.find(o=>o.uuid===result.created.uuid);assert.equal(mesh.gpuAttributes.status,'pass');assert(mesh.triangles>0&&mesh.normalCount>0)
 const capture=async name=>{const png=Buffer.from(await cdp.shot(),'base64');await fs.writeFile(path.join(out,name+'.png'),png);return png}
 await ev('__MATERIAL_PROBE.isolate([])');const empty=await capture('empty');await ev('__MATERIAL_PROBE.restore()')
 await ev('__MATERIAL_PROBE.isolate(['+JSON.stringify(mesh.uuid)+'])');const positive=await capture('positive');await ev('__MATERIAL_PROBE.lightControl('+JSON.stringify(mesh.uuid)+',true)');const reversed=await capture('reversed');await ev('__MATERIAL_PROBE.lightControl('+JSON.stringify(mesh.uuid)+',false)');await ev('__MATERIAL_PROBE.restore()')
 result.positive=pixels(positive,empty);result.lightDifference=pixels(reversed,positive);assert(result.positive.count>=12);assert(result.lightDifference.count>=12)
 await ev('__JUDGE_SYNTH.material.uniforms.uOpacity.value=0');await ev('__MATERIAL_PROBE.isolate(['+JSON.stringify(mesh.uuid)+'])');const zero=await capture('opacity-zero');await ev('__MATERIAL_PROBE.restore()');result.zero=pixels(zero,empty);assert.equal(result.zero.count,0)
 await ev('__JUDGE_SYNTH.material.uniforms.uOpacity.value=1');result.oldWorldAuditWithMesh=await ev('__SPACE_PROBE.audit()');assert.equal(result.oldWorldAuditWithMesh.length,2);assert(result.oldWorldAuditWithMesh.every(o=>Object.values(o.attributes).every(a=>a.exactGPU)))
 result.pointers=await ev('({body:__SPACE_PROBE.engine.points.geometry.getAttribute("position").array===__SPACE_PROBE.engine.scratch.positions,tail:__SPACE_PROBE.engine.tailPoints.geometry.getAttribute("position").array===__SPACE_PROBE.engine.scratch.emittedTail.positions})');assert(result.pointers.body&&result.pointers.tail)
 result.status='pass'
}catch(error){result.status='instrument-invalid';result.error=String(error.stack);process.exitCode=2}
finally{if(cdp)try{await ev('(()=>{__MATERIAL_PROBE.restore();const m=window.__JUDGE_SYNTH;if(m){m.removeFromParent();m.geometry.dispose();m.material.dispose()}return true})()');await cdp.send('Browser.close')}catch{}ws?.close();browser.kill();await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,positive:result.positive,lightDifference:result.lightDifference,zero:result.zero,error:result.error}))}
