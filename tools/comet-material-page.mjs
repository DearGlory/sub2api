// Browser observations only. The judge never calls transition helpers or trusts mesh names.
export function installMaterialProbe() {
  const e=window.__SUB2API_PARTICLE_ENGINE__,sp=window.__SPACE_PROBE
  if(!e||!sp)throw Error('missing live engine/space adapter')
  const body=e.points,tail=e.tailPoints,pool=e.scratch.emittedTail
  const xyz=(a,i)=>Array.from(a.subarray(i*3,i*3+3))
  const world=(p,o)=>{const v=e.scratch.vecA.clone().set(...p);o.localToWorld(v);return v.toArray()}
  const head=()=>world([e.choreography.state.headX,e.choreography.state.headY,e.choreography.state.headZ],body)
  const project=p=>{const v=e.scratch.vecA.clone().set(...p).project(e.camera),r=e.renderer.domElement.getBoundingClientRect();return [r.x+(v.x+1)*r.width/2,r.y+(1-v.y)*r.height/2]}
  const plain=v=>v?.toArray?v.toArray():ArrayBuffer.isView(v)?Array.from(v):Array.isArray(v)?v.map(plain):typeof v==='number'||typeof v==='boolean'?v:null
  const inventory=()=>{
    e.scene.updateMatrixWorld(true);e.renderer.render(e.scene,e.camera)
    const gl=e.renderer.getContext(),rows=[]
    e.scene.traverse(o=>{
      if(!o.geometry||!o.material)return
      const g=o.geometry,p=g.getAttribute('position'),n=g.getAttribute('normal'),a=p?.array
      const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],radii=[]
      if(a)for(let i=0;i<p.count;i++){const v=[p.getX(i),p.getY(i),p.getZ(i)];for(let j=0;j<3;j++){min[j]=Math.min(min[j],v[j]);max[j]=Math.max(max[j],v[j])}radii.push(Math.hypot(...v))}
      radii.sort((a,b)=>a-b)
      const materials=(Array.isArray(o.material)?o.material:[o.material]).map(m=>{
        const pr=e.renderer.properties.get(m).currentProgram,program=pr?.program,uniforms={},gpuUniforms={}
        for(const [k,u]of Object.entries(m.uniforms||{}))uniforms[k]=plain(u.value)
        if(program)for(let i=0;i<gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);i++){const u=gl.getActiveUniform(program,i);gpuUniforms[u.name]=plain(gl.getUniform(program,gl.getUniformLocation(program,u.name)))}
        return {type:m.type,opacity:m.opacity,transparent:m.transparent,blending:m.blending,side:m.side,depthWrite:m.depthWrite,roughness:m.roughness,uniforms,gpuUniforms,linked:!!program&&gl.getProgramParameter(program,gl.LINK_STATUS),vertex:pr?gl.getShaderSource(pr.vertexShader):null,fragment:pr?gl.getShaderSource(pr.fragmentShader):null}
      })
      let normalRange=null
      if(n){let low=Infinity,high=0;for(let i=0;i<n.count;i++){const l=Math.hypot(n.getX(i),n.getY(i),n.getZ(i));low=Math.min(low,l);high=Math.max(high,l)}normalRange=[low,high]}
      rows.push({uuid:o.uuid,name:o.name,type:o.type,isMesh:!!o.isMesh,isPoints:!!o.isPoints,visible:o.visible,body:o===body,tail:o===tail,triangles:o.isMesh?(g.index?.count||p?.count||0)/3:0,positionCount:p?.count,normalCount:n?.count||0,normalRange,span:min.map((v,j)=>max[j]-v),radiusQuantiles:[.1,.5,.9].map(q=>radii[Math.floor(q*radii.length)]),bytes:Object.values(g.attributes).reduce((s,a)=>s+a.array.byteLength,0)+(g.index?.array.byteLength||0),materials,matrix:Array.from(o.matrixWorld.elements),worldCenter:world(min.map((v,j)=>(v+max[j])/2),o)})
    });return rows
  }
  let restoration=null
  function isolate(uuids) {
    if(restoration)restore()
    const keep=new Set(),canvas=e.renderer.domElement,styles=[],objects=[]
    for(let el=canvas;el;el=el.parentElement)keep.add(el)
    for(const el of document.body.querySelectorAll('*'))if(!keep.has(el)){styles.push([el,el.getAttribute('style')]);el.style.visibility='hidden'}
    for(const el of [document.documentElement,document.body]){styles.push([el,el.getAttribute('style')]);el.style.background='#000'}
    e.scene.traverse(o=>{if(o.geometry){objects.push([o,o.visible]);o.visible=uuids.includes(o.uuid)}})
    restoration={styles,objects,background:e.scene.background};e.scene.background=null
    e.renderer.render(e.scene,e.camera)
    return {t:e.dollySeconds,head:head(),camera:e.camera.matrixWorld.toArray(),bodyPointer:body===e.points,tailPointer:tail===e.tailPoints}
  }
  function restore(){if(!restoration)return true;const r=restoration;for(const [o,v]of r.objects)o.visible=v;for(const [el,s]of r.styles)s===null?el.removeAttribute('style'):el.setAttribute('style',s);e.scene.background=r.background;restoration=null;e.renderer.render(e.scene,e.camera);return r.objects.every(([o,v])=>o.visible===v)&&body===e.points&&tail===e.tailPoints}
  function geometry(){
    e.scene.updateMatrixWorld(true);const h=head(),s=e.choreography.state,p=body.geometry.getAttribute('position')
    if(p.array!==e.scratch.positions)throw Error('actual geometry adapter mismatch')
    const positions=[],glyph=[],source=[],offsets=[]
    for(let i=0;i<p.count;i++){positions.push(world(xyz(p.array,i),body));glyph.push(world(xyz(e.scratch.glyphTargets,i),body));source.push(world(xyz(e.scratch.shapeFrom,i),body));offsets.push(xyz(e.scratch.body.offsets,i))}
    let active=0,alpha=0;const births=[]
    for(let i=0;i<pool.count;i++)if(pool.active[i]===1){active++;alpha+=pool.colors[i*4+3];births.push({i,birthTime:pool.birthTime[i],position:xyz(pool.positions,i),age:pool.age[i],life:pool.life[i],birthPosition:xyz(pool.birthPosition,i)})}
    return {t:e.dollySeconds,phase:s.phase,p:s.phaseProgress,leg:s.legIndex,brand:e.currentBrandSlug,head:h,headPixel:project(h),camera:e.camera.matrixWorld.toArray(),positions,glyph,source,offsets,tail:{active,alpha,births},drawCalls:e.renderer.info.render.calls}
  }
  function pose(){const s=e.choreography.state,h=head();return {t:e.dollySeconds,phase:s.phase,p:s.phaseProgress,leg:s.legIndex,brand:e.currentBrandSlug,head:h,headPixel:project(h),camera:e.camera.matrixWorld.toArray(),projection:e.camera.projectionMatrix.toArray(),bodyMatrix:body.matrixWorld.toArray()}}
  window.__MATERIAL_PROBE={inventory,isolate,restore,geometry,pose}
  return {pointerIdentity:body.geometry.getAttribute('position').array===e.scratch.positions,inventory:inventory(),pose:pose()}
}
