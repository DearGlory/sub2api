// Preserve the served baseline before any product integration. No product writes.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { CDP, connect, launchChrome } from './tail-probe-lib/cdp.mjs'
import { installSpaceProbe } from './space-pursuit-lib/page.mjs'
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,s)=>v.startsWith('--')?[...a,[v.slice(2),s[i+1]]]:a,[]))
for(const key of ['url','out','port','w','h','theme']) if(!args[key]) throw Error('required --'+key)
const out=path.resolve(args.out),port=Number(args.port),width=Number(args.w),height=Number(args.h)
await fs.mkdir(out,{recursive:true})
const save=(name,value)=>fs.writeFile(path.join(out,name),JSON.stringify(value,null,2))
const hash=s=>crypto.createHash('sha256').update(s).digest('hex')
const data={url:args.url,width,height,theme:args.theme,capturedAt:new Date().toISOString(),sources:[],shots:[]}
for(const name of ['ParticleEngine','emittedTail','cometVisualContract','cometVisual','cometSurface','cometVolume','cometTransition','choreography','spaceMotion','spaceMotionContract','flightPath','flightTiming','constants','types']) {
  const url=new URL('/src/features/home-particle/engine/'+name+'.ts',args.url)
  const r=await fetch(url),text=await r.text()
  const file='source-'+name+'.js';await fs.writeFile(path.join(out,file),text)
  data.sources.push({name,status:r.status,file,sha256:hash(text),isModule:r.ok&&!text.trimStart().startsWith('<')})
}
await save('baseline.json',data)
await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(port,'127.0.0.1',()=>s.close(resolve))})
let ws,cdp
const browser=launchChrome({port,profile:path.join(out,'profile'),chrome:args.chrome||'C:/Program Files/Google/Chrome/Application/chrome.exe',w:width,h:height})
const ev=async s=>{const r=await cdp.eval(s);if(r?.__error)throw Error(r.__error);return r}
try {
  ws=new WebSocket(await connect(port));await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});cdp=new CDP(ws)
  await cdp.send('Page.enable');await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600})
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:args.theme},{name:'prefers-reduced-motion',value:'no-preference'}]})
  await cdp.send('Page.navigate',{url:args.url})
  if(!await ev('new Promise(r=>{let n=0;const p=()=>window.__SUB2API_PARTICLE_ENGINE__?.currentBrandSlug?r(true):++n>200?r(false):setTimeout(p,100);p()})'))throw Error('missing dev engine')
  data.meta=await ev('('+installSpaceProbe.toString()+')()');await ev('__SPACE_PROBE.stop()')
  data.isolation=await ev(`(()=>{const e=__SPACE_PROBE.engine,c=e.renderer.domElement,keep=new Set();for(let p=c;p;p=p.parentElement)keep.add(p);const styles=[];for(const el of document.body.querySelectorAll('*'))if(!keep.has(el)){styles.push([el,el.getAttribute('style')]);el.style.visibility='hidden'}const objects=[];e.scene.traverse(o=>{if(o.geometry){objects.push([o,o.visible]);o.visible=false}});window.__MATERIAL_RESTORE={styles,objects,html:document.documentElement.getAttribute('style'),body:document.body.getAttribute('style'),background:e.scene.background,clear:e.renderer.getClearColor(new e.scratch.vecA.constructor().constructor()).clone?.()};return {hidden:styles.length,objects:objects.length}})()` .replace(",clear:e.renderer.getClearColor(new e.scratch.vecA.constructor().constructor()).clone?.()",''))
  const first=Math.floor(data.meta.initial.t/12)+1
  for(const leg of [first,first+1])for(const p of [.45,.7]) {
    const t=leg*12+6.5*p
    const state=await ev('__SPACE_PROBE.advance('+t+')')
    const label='travel-leg'+leg+'-p'+p
    for(const mode of ['body','tail','both','empty']) {
      await ev(`(()=>{const e=__SPACE_PROBE.engine;e.points.visible=${mode==='body'||mode==='both'};e.tailPoints.visible=${mode==='tail'||mode==='both'};e.scene.background=null;document.documentElement.style.background='#000';document.body.style.background='#000';e.renderer.render(e.scene,e.camera);return true})()`)
      const png=Buffer.from(await cdp.shot(),'base64');await fs.writeFile(path.join(out,label+'-'+mode+'.png'),png)
      data.shots.push({label,mode,file:label+'-'+mode+'.png',sha256:hash(png),state})
    }
  }
  data.restored=await ev(`(()=>{const e=__SPACE_PROBE.engine,r=__MATERIAL_RESTORE;for(const [o,v]of r.objects)o.visible=v;for(const [el,s]of r.styles)s===null?el.removeAttribute('style'):el.setAttribute('style',s);for(const [el,s]of [[document.documentElement,r.html],[document.body,r.body]])s===null?el.removeAttribute('style'):el.setAttribute('style',s);e.scene.background=r.background;e.renderer.render(e.scene,e.camera);return r.objects.every(([o,v])=>o.visible===v)})()`)
  data.status='captured'
}catch(error){data.status='instrument-invalid';data.error=String(error.stack);process.exitCode=2}
finally{await save('baseline.json',data);if(cdp)try{await cdp.send('Browser.close')}catch{}ws?.close();browser.kill();console.log(JSON.stringify({status:data.status,shots:data.shots.length,error:data.error}))}
