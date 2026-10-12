import fs from 'node:fs/promises'
import path from 'node:path'
import { pixels, eventObjects, same } from './comet-impact-checks.mjs'
import { hash } from './comet-impact-baseline.mjs'
import { decodePng, luminance } from './tail-probe-lib/png.mjs'
export function signedDelta(on,off){const a=luminance(decodePng(on)),b=luminance(decodePng(off));let dark=0,light=0;for(let i=0;i<a.L.length;i++){const d=a.L[i]-b.L[i];if(d<=-8)dark++;if(d>=8)light++}return {shadowPixels:dark,brightPixels:light,threshold:8}}
export function createCapture({ev,cdp,out}) {
  const shot=async name=>{const png=Buffer.from(await cdp.shot(),'base64'),file=name+'.png';await fs.writeFile(path.join(out,file),png);return {png,file,sha256:hash(png)}}
  const isolated=async(name,ids)=>{const pose=await ev('__MATERIAL_PROBE.isolate('+JSON.stringify(ids)+')');try{return {...await shot(name),pose}}finally{if(!await ev('__MATERIAL_PROBE.restore()'))throw Error('isolation restoration failed')}}
  const entry=s=>({file:s.file,sha256:s.sha256,pose:s.pose})
  async function depth(label,object,original,empty){
    const uuid=JSON.stringify(object.uuid),before=await ev('__MATERIAL_PROBE.pose()'),files=[],captures={},controls={}
    try{
      for(const half of ['near','far']){
        const control=await ev('__IMPACT_PROBE.slab('+uuid+','+JSON.stringify(half)+')');controls[half]=control
        if(control.status!=='observed')return {...control,files}
        captures[half]=await isolated(label+'-depth-'+half,[object.uuid]);files.push(entry(captures[half]));await ev('__IMPACT_PROBE.slab(null,"restore")')
      }
      for(const kind of ['rotate','translate']){
        controls[kind]=await ev('__IMPACT_PROBE.cameraControl('+JSON.stringify(kind)+')');captures[kind]=await isolated(label+'-camera-'+kind,[object.uuid]);files.push(entry(captures[kind]));await ev('__IMPACT_PROBE.cameraControl("restore")')
      }
      const after=await ev('__MATERIAL_PROBE.pose()')
      return {status:'observed',near:pixels(captures.near.png,empty.png),far:pixels(captures.far.png,empty.png),difference:pixels(captures.near.png,captures.far.png),rotate:pixels(captures.rotate.png,original.png),translate:pixels(captures.translate.png,original.png),frozen:before.t===after.t&&same(before.head,after.head)&&same(before.camera,after.camera),controls,files}
    }finally{await ev('__IMPACT_PROBE.slab(null,"restore")');await ev('__IMPACT_PROBE.cameraControl("restore")')}
  }
  async function capture(label,kind,q,{depthTest=false}={}){
    const sample=await ev('__IMPACT_PROBE.sample()'),inventory=await ev('__IMPACT_PROBE.inventory()'),objects=eventObjects(inventory),ids=objects.map(o=>o.uuid)
    const page=await shot(label+'-page');await ev('__IMPACT_PROBE.hideEvents(true)');let without
    try{without=await shot(label+'-page-noevent')}finally{await ev('__IMPACT_PROBE.hideEvents(false)')}
    const empty=await isolated(label+'-empty',[]),event=await isolated(label+'-event',ids),subjects=inventory.filter(o=>o.body||o.tail||o.isMesh),bodyIds=subjects.filter(o=>o.body||o.isMesh&&o.materials.some(m=>/#define IS_COMA 1\b/.test(m.fragment||'')||m.uniforms.uLightDirection)).map(o=>o.uuid)
    const all=await isolated(label+'-subjects',subjects.map(o=>o.uuid)),body=await isolated(label+'-body',bodyIds)
    const row={label,kind,q,...sample,inventory,files:[page,without,empty,event,all,body].map(entry),bodyIds,bodyPixels:pixels(body.png,empty.png),eventPixels:pixels(event.png,empty.png),pageDelta:pixels(page.png,without.png),shadow:signedDelta(page.png,without.png),subjectPixels:pixels(all.png,empty.png)}
    if(objects.length===1)row.eventGPU=await ev('__IMPACT_PROBE.diagnosticGPU('+JSON.stringify(objects[0].uuid)+')')
    if(depthTest&&objects.length===1&&objects[0].visible)row.depth=await depth(label,objects[0],event,empty)
    const after=await ev('__MATERIAL_PROBE.pose()');row.frozen=after.t===sample.pose.t&&same(after.head,sample.pose.head)&&same(after.camera,sample.pose.camera)
    return row
  }
  return {shot,isolated,capture,depth,entry}
}
