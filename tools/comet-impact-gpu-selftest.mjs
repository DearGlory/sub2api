import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { CDP, connect, launchChrome } from './tail-probe-lib/cdp.mjs'
import { installSpaceProbe } from './space-pursuit-lib/page.mjs'
import { installMaterialProbe } from './comet-material-page.mjs'
import { installImpactProbe } from './comet-impact-page.mjs'
import { createCapture } from './comet-impact-capture.mjs'
import { eventChecks, pixels, resultStatus } from './comet-impact-checks.mjs'
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>v.startsWith('--')?[...a,[v.slice(2),s[i+1]]]:a,[]))
for(const k of ['url','out','port'])if(!args[k])throw Error('required --'+k)
const out=path.resolve(args.out),port=Number(args.port),width=Number(args.w||1440),height=Number(args.h||900)
await fs.mkdir(out,{recursive:true})
const result={scope:'real WebGL synthetic fixture; judge self-proof ONLY, never product acceptance',cases:[]}
let browser,ws,cdp
const ev=async s=>{const r=await cdp.eval(s);if(r?.__error)throw Error(r.__error);return r}
try{
  await new Promise((r,j)=>{const s=net.createServer();s.once('error',j);s.listen(port,'127.0.0.1',()=>s.close(r))})
  browser=launchChrome({port,profile:path.join(out,'profile'),chrome:args.chrome||'C:/Program Files/Google/Chrome/Application/chrome.exe',w:width,h:height})
  ws=new WebSocket(await connect(port));await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});cdp=new CDP(ws)
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:args.theme||'dark'}]});await cdp.send('Page.navigate',{url:args.url})
  await ev('new Promise((r,j)=>{let n=0;const tick=()=>window.__SUB2API_PARTICLE_ENGINE__?.currentBrandSlug?r(true):++n>200?j(Error("no engine")):setTimeout(tick,100);tick()})')
  await ev('('+installSpaceProbe.toString()+')()');await ev('__SPACE_PROBE.stop()');await ev('('+installMaterialProbe.toString()+')()');await ev('('+installImpactProbe.toString()+')()')
  const source=await (await fetch(new URL('/src/features/home-particle/engine/ParticleEngine.ts',args.url))).text(),module=source.match(/from\s+['"]([^'"]*\/three\.js[^'"]*)['"]/)?.[1]
  if(!module)throw Error('actual served three import missing')
  await ev('__SPACE_PROBE.advance(18.85,[1/60])')
  const vertex='uniform vec3 uHead;uniform float uRadius;varying vec3 vFrame;void main(){vFrame=uHead+position*(2.0*uRadius);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}'
  const fragment=`uniform vec3 uHead;uniform vec3 uCameraFrame;uniform float uRadius;uniform float uEventMode;uniform float uEventProgress;uniform float uEventStrength;uniform float uOpacity;varying vec3 vFrame;
float density(vec3 p) {
 vec3 d=(p-uHead)/uRadius; return exp(-dot(d,d)*4.0)*(0.5+0.4*sin(d.x*5.0+d.z*3.0+uEventProgress))*(1.0+uEventMode*0.05);
}
void main(){vec3 ray=normalize(vFrame-uCameraFrame);vec3 delta=uCameraFrame-uHead;float b=dot(delta,ray),c=dot(delta,delta)-uRadius*uRadius;float disc=b*b-c;if(disc<=0.0)discard;float enter=max(0.0,-b-sqrt(disc)),leave=-b+sqrt(disc);float stepLength=(leave-enter)/32.0;float opacity=0.0;vec3 light=vec3(0.0);for(int i=0;i<32;i++){vec3 p=uCameraFrame+ray*(enter+(float(i)+0.5)*stepLength);float d=density(p);float alpha=1.0-exp(-d*stepLength*uEventStrength*uOpacity);light+=(1.0-opacity)*alpha*vec3(0.2+0.12*sin(p.z-uHead.z),0.45,0.65);opacity+=(1.0-opacity)*alpha;}gl_FragColor=vec4(light/max(opacity,0.0001),opacity);}`
  result.created=await ev(`(async()=>{const T=await import(${JSON.stringify(module)}),e=__SPACE_PROBE.engine,s=e.choreography.state;const displaced=[];e.scene.traverse(o=>{if(o.isMesh&&o.material?.uniforms?.uEventMode)displaced.push([o,o.parent])});for(const [o]of displaced)o.removeFromParent();window.__IMPACT_DISPLACED=displaced;const g=new T.BoxGeometry(1,1,1);g.deleteAttribute('normal');g.deleteAttribute('uv');const m=new T.ShaderMaterial({uniforms:{uHead:{value:new T.Vector3(s.headX,s.headY,s.headZ)},uCameraFrame:{value:new T.Vector3()},uRadius:{value:2},uEventMode:{value:1},uEventProgress:{value:.25},uEventStrength:{value:.8},uOpacity:{value:1}},vertexShader:${JSON.stringify(vertex)},fragmentShader:${JSON.stringify(fragment)},transparent:true,depthWrite:false,side:T.BackSide});const o=new T.Mesh(g,m);o.position.copy(m.uniforms.uHead.value);o.scale.setScalar(4);e.cometVisual.object.add(o);const inverse=new T.Matrix4();o.onBeforeRender=(_r,_s,camera)=>{m.uniforms.uCameraFrame.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverse.copy(o.parent.matrixWorld).invert())};window.__IMPACT_SYNTH=o;e.renderer.render(e.scene,e.camera);return {uuid:o.uuid}})()`)
  const capture=createCapture({ev,cdp,out}),positive=await capture.capture('synthetic-positive','gather',.25,{depthTest:true});result.positive=positive
  const checks=eventChecks(positive);result.positiveChecks=checks;assert(checks.every(c=>c.status==='pass'),JSON.stringify(checks.filter(c=>c.status!=='pass')));result.cases.push({name:'actual GPU raymarch/near-far/camera/page contribution',status:'pass'})
  for(const [name,id]of [['zeroOpacity','event-visible-contribution'],['noevent','event-visible-contribution'],['board2D','event-local-box']]){
    await ev('__IMPACT_PROBE.mutate('+JSON.stringify(name)+','+JSON.stringify(result.created.uuid)+')')
    try{const row=await capture.capture('negative-'+name,'gather',.25);const checks=eventChecks(row);result[name]={row,checks};assert(checks.some(c=>c.id.endsWith(id)&&c.status==='fail'),JSON.stringify(checks));result.cases.push({name,status:'pass',rejectedBy:id})}finally{await ev('__IMPACT_PROBE.mutate("restore")')}
  }
  await ev('__IMPACT_PROBE.mutate("planar-ring",'+JSON.stringify(result.created.uuid)+')')
  try{const row=await capture.capture('negative-planar-ring','gather',.25,{depthTest:true}),checks=eventChecks(row);assert(row.eventPixels.count>=12,'planar ring must actually draw');assert(checks.some(c=>c.id.endsWith('event-linked-GPU')&&c.status==='fail'));assert(checks.some(c=>c.id.endsWith('event-raymarch-3D')&&c.status==='instrument-invalid'));result.planarRing={row,checks};result.cases.push({name:'planar-ring-inside-full-box',status:'pass'})}finally{await ev('__IMPACT_PROBE.mutate("restore")')}
  // Read GPU before any re-render; then observe the changed CPU uniform separately.
  const control=await ev('__IMPACT_PROBE.mutate("cpu-unlinked",'+JSON.stringify(result.created.uuid)+')')
  const cpu=await ev('Object.fromEntries(Object.entries(__IMPACT_SYNTH.material.uniforms).map(([k,u])=>[k,u.value?.toArray?u.value.toArray():u.value]))')
  const unlinked=structuredClone(positive);unlinked.inventory.find(o=>o.uuid===result.created.uuid).materials[0].uniforms=cpu;unlinked.eventGPU={uniforms:control.gpu};const uc=eventChecks(unlinked);assert(uc.some(c=>c.id.endsWith('event-linked-GPU')&&c.status==='fail'));result.cpuUnlinked={cpu,gpu:control.gpu,checks:uc};result.cases.push({name:'cpu-unlinked',status:'pass'});await ev('__IMPACT_PROBE.mutate("restore")')
  await ev('__SPACE_PROBE.advance(20.2,[1/60])')
  // Fixture deliberately has no update callback, so it remains visible during real hold.
  const always=await capture.capture('negative-always-on','hold',.5),ac=eventChecks(always);assert(ac.some(c=>c.id.endsWith('event-hidden-zero')&&c.status==='fail'));result.alwaysOn={row:always,checks:ac};result.cases.push({name:'always-on-real-hold',status:'pass'})
  result.status=resultStatus(result.cases)
}catch(error){result.status='instrument-invalid';result.error=String(error.stack)}
finally{if(cdp)try{await ev('(()=>{__IMPACT_PROBE?.restore();const o=window.__IMPACT_SYNTH;if(o){o.removeFromParent();o.geometry.dispose();o.material.dispose()}for(const [o,p]of window.__IMPACT_DISPLACED||[])p.add(o);return true})()');await cdp.send('Browser.close')}catch{}ws?.close();browser?.kill();result.exitCode=result.status==='pass'?0:2;await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,cases:result.cases,error:result.error}));process.exitCode=result.exitCode}
