/** Read actual submitted buffers/matrices; baseline never changes star/camera state. */
export const INSTALL_TRACKER = `(() => {
  const e = window.__SUB2API_PARTICLE_ENGINE__;
  if (!e) throw new Error('missing engine');
  const sf = e.debugScene.scene.getObjectByName('starfield');
  const T = window.__STAR_FLOW__ = { engine: e, frames: [], generations: {}, previous: null, stopped: false };
  const mul = (m,v) => [0,1,2,3].map(r => m[r]*v[0]+m[r+4]*v[1]+m[r+8]*v[2]+m[r+12]*v[3]);
  T.snapshot = () => {
    if (window.__SUB2API_PARTICLE_ENGINE__ !== e) throw new Error('HMR replaced engine');
    const {camera:c} = e.debugScene;
    const rect = e.renderer.domElement.getBoundingClientRect();
    const W=rect.width,H=rect.height;
    const project = (obj,p) => {
      const clip=mul(c.projectionMatrix.elements,mul(c.matrixWorldInverse.elements,mul(obj.matrixWorld.elements,[...p,1])));
      const x=rect.x+(clip[0]/clip[3]+1)*W/2, y=rect.y+(1-clip[1]/clip[3])*H/2;
      return {x,y,r:Math.hypot(x-(rect.x+W/2),y-(rect.y+H/2)),onscreen:clip[3]>0&&Math.abs(clip[2]/clip[3])<=1&&x>=rect.x&&x<rect.x+W&&y>=rect.y&&y<rect.y+H};
    };
    const layers = sf.children.map((o,l) => {
      const a=o.geometry.attributes.position, col=o.geometry.attributes.color;
      const rows=[];
      for(let i=0;i<a.count;i++){
        const local=[a.getX(i),a.getY(i),a.getZ(i)];
        const color=col?[col.getX(i),col.getY(i),col.getZ(i)]:[o.material.color.r,o.material.color.g,o.material.color.b];
        const id=o.geometry.uuid+':'+i;
        const prior=T.previous?.layers[l]?.rows[i];
        if(prior && prior.local.some((v,j)=>v!==local[j])) T.generations[id]=(T.generations[id]||0)+1;
        rows.push({id,layer:l,index:i,local,color,generation:T.generations[id]||0,lit:Math.max(...color)*o.material.opacity>0, ...project(o,local)});
      }
      return {uuid:o.geometry.uuid,matrixWorld:Array.from(o.matrixWorld.elements),positionVersion:a.version,colorVersion:col?.version,opacity:o.material.opacity,size:o.material.size,rows};
    });
    return {t:performance.now(),phase:e.choreography.state.phase,progress:e.choreography.state.phaseProgress,camZ:c.position.z,W:innerWidth,H:innerHeight,rect:{x:rect.x,y:rect.y,width:W,height:H},projection:Array.from(c.projectionMatrix.elements),view:Array.from(c.matrixWorldInverse.elements),layers};
  };
  T.tick=()=>{
    if(T.stopped)return;
    const s=T.snapshot(),p=T.previous;
    if(p){
      let recycled=0,offscreen=0,zeroBrightness=0,eligible=0,inward=0,outward=0;
      const deltas=[];
      for(let l=0;l<3;l++)for(let i=0;i<s.layers[l].rows.length;i++){
        const a=p.layers[l].rows[i],b=s.layers[l].rows[i];
        if(a.generation!==b.generation){recycled++;continue;}
        if(!a.onscreen||!b.onscreen){offscreen++;continue;}
        if(!a.lit||!b.lit){zeroBrightness++;continue;}
        eligible++;const d=b.r-a.r;deltas.push(d);if(d < -1e-8)inward++;if(d > 1e-8)outward++;
      }
      deltas.sort((a,b)=>a-b);
      T.frames.push({t:s.t,phase:s.phase,fromPhase:p.phase,dz:s.camZ-p.camZ,eligible,inward,outward,recycled,offscreen,zeroBrightness,medianDr:deltas[Math.floor(deltas.length/2)]??null});
    }
    T.previous=s;
    requestAnimationFrame(T.tick);
  };
  requestAnimationFrame(T.tick);
  return {layers:sf.children.length, methods:{starfieldUpdate:e.starfield.update.toString(),advanceCamera:e.advanceCamera.toString(),tick:e.tick.toString(),render:e.renderer.render.toString()}};
})()`

// Fault injection is explicit and scoped to the exclusive probe tab; navigation restores it.
export const CONTROL = mode => `(() => {
 const e=window.__SUB2API_PARTICLE_ENGINE__,sf=e.debugScene.scene.getObjectByName('starfield');
 const saved={advanceCamera:e.advanceCamera,update:e.starfield.update,visible:sf.visible};
 window.__STAR_FLOW_RESTORE__=()=>{e.advanceCamera=saved.advanceCamera;e.starfield.update=saved.update;sf.visible=saved.visible;};
 // Keep spin/twinkle alive: this also detects the finite-rotation chord bias.
 if(${JSON.stringify(mode)}==='stopped'){e.advanceCamera=()=>{};}
 // Camera still retreats normally. Move the field toward it faster, so only the
 // screenshot direction gate (not a negative camera step) can reject this fault.
 if(${JSON.stringify(mode)}==='outward'){
   let offset=0;
   e.starfield.update=(dt,z,t)=>{saved.update(dt,z,t);offset+=dt*.5;sf.position.z+=offset;};
 }
 if(${JSON.stringify(mode)}==='dark'){for(const o of sf.children)o.visible=false;}
 return true;
})()`
