import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'

// Native rAF, no virtual time, no state or geometry assignments. Capture cost is reported.
export function startRecording(seconds) {
  const e=window.__SUB2API_PARTICLE_ENGINE__
  if(!e || !e.running) throw Error('instrument-invalid: normal engine not running')
  const canvas=e.renderer.domElement, stream=canvas.captureStream(30),chunks=[]
  const mime=['video/webm;codecs=vp9','video/webm;codecs=vp8'].find(t=>MediaRecorder.isTypeSupported(t))
  if(!mime) throw Error('instrument-invalid: no canvas recorder')
  const recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:4500000})
  recorder.ondataavailable=event=>{if(event.data.size) chunks.push(event.data)}
  const dt=[],states=[],longtasks=[],start=performance.now();let last=start,lastState=start,done=false
  const observer=new PerformanceObserver(list=>longtasks.push(...list.getEntries().map(x=>({start:x.startTime,duration:x.duration}))))
  observer.observe({type:'longtask',buffered:false})
  const sample=now=>{
    if(done)return
    dt.push(now-last);last=now
    if(now-lastState>=100) {
      const s=e.choreography.state
      states.push({wallMs:now-start,clock:e.dollySeconds,phase:s.phase,progress:s.phaseProgress,leg:s.legIndex,brand:e.currentBrandSlug,cameraZ:e.camera.position.z,drawCalls:e.renderer.info.render.calls})
      lastState=now
    }
    requestAnimationFrame(sample)
  }
  window.__SPACE_RECORD_DONE=new Promise(resolve=>{
    recorder.onstop=async()=>{
      const bytes=new Uint8Array(await new Blob(chunks,{type:mime}).arrayBuffer())
      window.__SPACE_RECORD_BYTES=bytes
      resolve({elapsedMs:performance.now()-start,mime,bytes:bytes.length,dt,states,longtasks,normalRAF:true,clockControlled:false})
    }
    setTimeout(()=>{done=true;observer.disconnect();recorder.stop();stream.getTracks().forEach(t=>t.stop())},seconds*1000)
  })
  recorder.start(1000);requestAnimationFrame(sample)
  return {started:true,seconds,mime}
}
const run=(command,args)=>new Promise((resolve,reject)=>{
  const child=spawn(command,args,{stdio:['ignore','ignore','pipe']});let error=''
  child.stderr.on('data',b=>{error+=b.toString();if(error.length>4000)error=error.slice(-4000)})
  child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(command+' exit '+code+': '+error)))
})
export async function recordNormal({cdp,ws,evaluate,out,seconds}) {
  if(seconds<36) return {status:'skip',reason:'minimum continuous recording is 36 seconds'}
  // Reload discards numerical stepping and restores a clean native frame loop.
  await cdp.send('Page.reload',{ignoreCache:false})
  await evaluate(`new Promise((resolve,reject)=>{const t=performance.now();const tick=()=>{if(window.__SUB2API_PARTICLE_ENGINE__?.running)resolve(true);else if(performance.now()-t>20000)reject(Error('missing running engine'));else setTimeout(tick,100)};tick()})`)
  const framesDir=path.join(out,'normal-frames');await fs.mkdir(framesDir,{recursive:true})
  const frames=[],writes=[]
  const listener=event=>{
    const m=JSON.parse(event.data)
    if(m.method!=='Page.screencastFrame')return
    const f=m.params,n=frames.length,name='frame-'+String(n).padStart(5,'0')+'.jpg'
    frames.push({name,timestamp:f.metadata.timestamp,metadata:f.metadata})
    writes.push(fs.writeFile(path.join(framesDir,name),Buffer.from(f.data,'base64')))
    cdp.send('Page.screencastFrameAck',{sessionId:f.sessionId}).catch(()=>{})
  }
  ws.addEventListener('message',listener)
  await cdp.send('Page.startScreencast',{format:'jpeg',quality:80,everyNthFrame:1})
  let perf
  try {
    await evaluate('('+startRecording.toString()+')('+seconds+')')
    perf=await evaluate('__SPACE_RECORD_DONE')
  } finally {await cdp.send('Page.stopScreencast');ws.removeEventListener('message',listener)}
  await Promise.all(writes)
  const chunks=[]
  for(let offset=0;offset<perf.bytes;offset+=32768) chunks.push(Buffer.from(await evaluate(`btoa(String.fromCharCode(...__SPACE_RECORD_BYTES.subarray(${offset},${Math.min(offset+32768,perf.bytes)})))`),'base64'))
  const canvasVideo=path.join(out,'normal-canvas.webm');await fs.writeFile(canvasVideo,Buffer.concat(chunks))
  const list=frames.map((f,i)=>`file '${f.name}'\nduration ${i+1<frames.length?Math.max(.001,frames[i+1].timestamp-f.timestamp):.033333}\n`).join('')
  const listPath=path.join(framesDir,'frames.ffconcat');await fs.writeFile(listPath,list+`file '${frames.at(-1).name}'\n`)
  const pageVideo=path.join(out,'normal-page.mp4')
  let videoError=null
  try {await run('ffmpeg',['-y','-loglevel','error','-f','concat','-safe','0','-i',listPath,'-vf','fps=30','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',pageVideo])} catch(error) {videoError=String(error)}
  const sorted=perf.dt.slice().sort((a,b)=>a-b)
  const metrics={frames:perf.dt.length,meanMs:perf.dt.reduce((a,b)=>a+b,0)/perf.dt.length,p50Ms:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)],longtaskCount:perf.longtasks.length,longtaskTotalMs:perf.longtasks.reduce((s,t)=>s+t.duration,0)}
  await fs.writeFile(path.join(out,'normal-raf.json'),JSON.stringify({...perf,metrics,screencastFrames:frames},null,2))
  const manifest=frames.map(f=>({name:f.name,timestamp:f.timestamp}))
  await fs.writeFile(path.join(out,'normal-frame-manifest.json'),JSON.stringify(manifest,null,2))
  // Frames remain as timestamped evidence; no synthetic interpolation of missing source frames.
  const span=frames.length?frames.at(-1).timestamp-frames[0].timestamp:0
  return {status:!videoError&&perf.elapsedMs>=36000&&span>=36?'pass':'instrument-invalid',elapsedMs:perf.elapsedMs,screencastSeconds:span,screencastFrames:frames.length,canvasVideo,pageVideo,metrics,videoError,normalRAF:true,note:'normal native rAF with recording overhead; isolated canvas captureStream plus full-page CDP screencast, no CSS scene isolation; parent owns theme/mobile matrix'}
}
