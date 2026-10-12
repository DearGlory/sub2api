// Browser-only observation/negative controls. Never imports or changes product files.
export function installImpactProbe() {
  const e=window.__SUB2API_PARTICLE_ENGINE__,mp=window.__MATERIAL_PROBE
  if(!e||!mp)throw Error('missing original material adapter')
  const plain=v=>v?.toArray?v.toArray():ArrayBuffer.isView(v)?Array.from(v):typeof v==='number'||typeof v==='boolean'?v:null
  const events=()=>{const rows=[];e.scene.traverse(o=>{if(o.isMesh&&o.material?.uniforms&&['uEventMode','uEventProgress','uEventStrength','uHead','uRadius'].some(k=>k in o.material.uniforms))rows.push(o)});return rows}
  const render=()=>e.renderer.render(e.scene,e.camera)
  const world=(p,o)=>o.localToWorld(e.scratch.vecA.clone().set(...p)).toArray()
  const gpu=o=>{const gl=e.renderer.getContext(),p=e.renderer.properties.get(o.material).currentProgram?.program,u={};if(!p)return null;for(let i=0;i<gl.getProgramParameter(p,gl.ACTIVE_UNIFORMS);i++){const a=gl.getActiveUniform(p,i);if(a.size===1)u[a.name]=plain(gl.getUniform(p,gl.getUniformLocation(p,a.name)))}return u}
  function inventory(){const rows=mp.inventory();for(const row of rows){const o=e.scene.getObjectByProperty('uuid',row.uuid);row.geometryType=o.geometry.type;row.parentMatrix=o.parent.matrixWorld.toArray();row.materials.forEach((m,i)=>{const mat=Array.isArray(o.material)?o.material[i]:o.material;m.fragmentSource=mat.fragmentShader||null;m.vertexSource=mat.vertexShader||null})}return rows}
  function diagnosticGPU(uuid){const o=e.scene.getObjectByProperty('uuid',uuid);if(!o)return null;const old=[];e.scene.traverse(x=>{if(x.geometry){old.push([x,x.visible]);x.visible=x===o}});try{render();return {diagnosticForcedDraw:true,uniforms:gpu(o),matrix:o.matrixWorld.toArray(),expectedModelView:e.camera.matrixWorldInverse.clone().multiply(o.matrixWorld).toArray()}}finally{for(const [x,v]of old)x.visible=v;render()}}
  function sample(){
    e.scene.updateMatrixWorld(true);const p=e.points.geometry.getAttribute('position'),pool=e.scratch.emittedTail,positions=[],births=[];let active=0
    const stride=Math.max(1,Math.ceil(p.count/96))
    for(let i=0;i<p.count;i+=stride)positions.push({i,world:world([p.getX(i),p.getY(i),p.getZ(i)],e.points)})
    for(let i=0;i<pool.count;i++)if(pool.active[i]===1){active++;if(births.length<96)births.push({i,birthTime:pool.birthTime[i],age:pool.age[i],life:pool.life[i],position:Array.from(pool.positions.subarray(i*3,i*3+3))})}
    return {pose:mp.pose(),positions:{total:p.count,stride,samples:positions},tail:{total:pool.count,active,samples:births},drawCalls:e.renderer.info.render.calls,geometryBytes:inventoryBytes(),eventCount:events().length}
  }
  function inventoryBytes(){let bytes=0;e.scene.traverse(o=>{if(o.geometry)bytes+=Object.values(o.geometry.attributes).reduce((s,a)=>s+a.array.byteLength,0)+(o.geometry.index?.array.byteLength||0)});return bytes}
  function births(){const p=e.scratch.emittedTail,rows=[];for(let i=0;i<p.count;i++)if(p.active[i]===1)rows.push({i,birthTime:p.birthTime[i],age:p.age[i],life:p.life[i],position:Array.from(p.positions.subarray(i*3,i*3+3))});return rows}
  let camera=null,shader=null,hidden=null,negative=null
  function cameraControl(kind){if(kind==='restore'){if(camera){e.camera.position.copy(camera.position);e.camera.quaternion.copy(camera.quaternion);e.camera.updateMatrixWorld(true);camera=null;render()}return mp.pose()}
    if(camera)cameraControl('restore');camera={position:e.camera.position.clone(),quaternion:e.camera.quaternion.clone()};if(kind==='rotate')e.camera.rotateY(.045);else if(kind==='translate')e.camera.position.x+=.35;else throw Error('unknown camera control');e.camera.updateMatrixWorld(true);render();return mp.pose()}
  function slab(uuid,half){
    if(half==='restore'){if(shader){shader.material.fragmentShader=shader.fragment;shader.material.needsUpdate=true;shader=null;render()}return true}
    if(shader)slab(uuid,'restore')
    const o=e.scene.getObjectByProperty('uuid',uuid),m=o.material,text=m.fragmentShader
    // Keep original marching step and extinction; suppress only one half's sample positions.
    const re=/vec3\s+(\w+)\s*=\s*\w+\s*\+\s*\w+\s*\*\s*\([^;]+;/g
    const candidates=[...text.matchAll(re)].filter(v=>new RegExp('(?:density|sampleField|eventDensity)\\s*\\(\\s*'+v[1]+'\\s*\\)').test(text)||/origin\s*=\s*uCameraFrame\s*-\s*uHead/.test(text)&&v[1]==='p'&&/length\(p\)/.test(text))
    if(candidates.length!==1)return {status:'instrument-invalid',reason:'unknown integration position; cannot instrument depth'}
    const match=candidates[0],relative=/origin\s*=\s*uCameraFrame\s*-\s*uHead/.test(text);shader={material:m,fragment:text};m.fragmentShader=text.replace(match[0],match[0]+'\n if ('+match[1]+'.z '+(half==='near'?'<':'>=')+' '+(relative?'0.0':'uHead.z')+') continue;');m.needsUpdate=true;render();return {status:'observed',sample:match[1],half,plane:relative?'0 in head-relative shader frame':'uHead.z in actual shader frame'}
  }
  function hideEvents(on){if(on){hidden=events().map(o=>[o,o.visible]);for(const [o]of hidden)o.visible=false}else if(hidden){for(const [o,v]of hidden)o.visible=v;hidden=null}render();return mp.pose()}
  function mutate(kind,uuid){
    if(kind==='restore'){if(negative){const {o,visible,scale,uniforms,fragment}=negative;o.visible=visible;o.scale.copy(scale);for(const [k,v]of Object.entries(uniforms)){const u=o.material.uniforms[k];u.value?.copy?u.value.copy(v):u.value=v}o.material.fragmentShader=fragment;o.material.needsUpdate=true;negative=null;render()}return true}
    if(negative)mutate('restore');const o=e.scene.getObjectByProperty('uuid',uuid),m=o.material
    negative={o,visible:o.visible,scale:o.scale.clone(),fragment:m.fragmentShader,uniforms:Object.fromEntries(Object.entries(m.uniforms).map(([k,u])=>[k,u.value?.clone?u.value.clone():u.value]))}
    if(kind==='noevent')o.visible=false
    else if(kind==='zeroOpacity'){if(m.uniforms.uOpacity)m.uniforms.uOpacity.value=0;else{m.fragmentShader=m.fragmentShader.replace(/}\s*$/,'gl_FragColor.a = 0.0;\n}');m.needsUpdate=true}}
    else if(kind==='board2D')o.scale.z=.00001
    else if(kind==='planar-ring'){m.fragmentShader='uniform vec3 uHead;uniform float uRadius;uniform float uEventStrength;varying vec3 vFrame;void main(){float r=length((vFrame-uHead).xy)/uRadius;float ring=exp(-pow((r-0.6)/0.12,2.0));gl_FragColor=vec4(0.2,0.45,0.65,ring*uEventStrength);}';m.needsUpdate=true}
    else if(kind==='cpu-unlinked'){render();m.uniforms.uHead.value.x+=3;return {status:'observed',gpu:gpu(o)}}
    else throw Error('unknown negative '+kind)
    render();return {status:'observed'}
  }
  function restore(){mutate('restore');slab(null,'restore');cameraControl('restore');hideEvents(false);return mp.restore()}
  window.__IMPACT_PROBE={inventory,diagnosticGPU,sample,births,cameraControl,slab,hideEvents,mutate,restore}
  return {pose:mp.pose(),implementation:events().length?'observed':'notimplemented'}
}
