import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Bake the existing model's parts into one shared geometry without changing its silhouette. */
export function droneGeometry(model: THREE.Object3D) {
  model.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  model.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const geometry = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    // All parts use the same state material; normals and positions are the only inputs.
    for (const name of Object.keys(geometry.attributes))
      if (name !== "position" && name !== "normal") geometry.deleteAttribute(name);
    geometry.applyMatrix4(o.matrixWorld);
    parts.push(geometry);
  });
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  if (!merged) throw Error("Drone model has no compatible mesh geometry");
  return merged;
}

/** Reuse GPU storage between frames; grow only when fleet size increases. */
export class FleetLines extends THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> {
  private vertices = 0;
  constructor(material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false })) {
    super(new THREE.BufferGeometry(), material);
    this.frustumCulled = false;
    this.geometry.setDrawRange(0, 0);
  }
  begin(capacity: number) {
    this.vertices = 0;
    if ((this.geometry.getAttribute("position")?.count ?? 0) >= capacity) return;
    this.geometry.dispose();
    this.geometry = new THREE.BufferGeometry();
    const size = Math.max(64, 2 ** Math.ceil(Math.log2(capacity)));
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(size * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(size * 4), 4).setUsage(THREE.DynamicDrawUsage));
  }
  segment(ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: THREE.Color, a: number, b = a) {
    const p = this.geometry.getAttribute("position"), c = this.geometry.getAttribute("color");
    p.setXYZ(this.vertices, ax, ay, az);
    c.setXYZW(this.vertices++, color.r, color.g, color.b, a);
    p.setXYZ(this.vertices, bx, by, bz);
    c.setXYZW(this.vertices++, color.r, color.g, color.b, b);
  }
  end() {
    this.geometry.setDrawRange(0, this.vertices);
    this.visible = this.vertices > 0;
    for (const attribute of Object.values(this.geometry.attributes)) {
      if (!(attribute instanceof THREE.BufferAttribute)) continue;
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, this.vertices * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }
}

/** Adjust resolution after sustained frame pressure, with slower recovery to avoid oscillation. */
export class ViewportResolution {
  readonly ceiling: number;
  ratio: number;
  private elapsed = 0;
  private frames = 0;
  private fastWindows = 0;
  constructor(deviceRatio: number) {
    this.ratio = this.ceiling = Math.min(deviceRatio, 1.5);
  }
  sample(ms: number) {
    if (ms <= 0 || ms > 1000) {
      this.elapsed = this.frames = this.fastWindows = 0;
      return false;
    }
    this.elapsed += ms;
    this.frames++;
    if (this.elapsed < 2000) return false;
    const average = this.elapsed / this.frames, before = this.ratio;
    this.elapsed = this.frames = 0;
    if (average > 22) {
      this.ratio = Math.max(Math.min(0.75, this.ceiling), this.ratio - 0.25);
      this.fastWindows = 0;
    } else if (average < 18) {
      if (++this.fastWindows >= 4) {
        this.ratio = Math.min(this.ceiling, this.ratio + 0.25);
        this.fastWindows = 0;
      }
    } else this.fastWindows = 0;
    return before !== this.ratio;
  }
}

/** A world-fixed photograph, visible only where a distant flat card reads naturally. */
export class DuskBackdrop extends THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  private direction = new THREE.Vector3();
  private destroyed = false;
  constructor(changed: () => void) {
    const texture = new THREE.TextureLoader().load("/assets/environments/sudoko-dusk-basin.webp", loaded => {
      if (this.destroyed) return;
      this.scale.y = this.scale.x * loaded.image.height / loaded.image.width;
      this.userData.state = "ready";
      changed();
    }, undefined, () => {
      if (this.destroyed) return;
      this.userData.state = "failed";
      changed();
    });
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, fog: false, toneMapped: false, opacity: 0 });
    material.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `#include <map_fragment>
        float sides = smoothstep(0.0, 0.14, vMapUv.x) * (1.0 - smoothstep(0.86, 1.0, vMapUv.x));
        float bottom = smoothstep(0.55, 0.74, vMapUv.y);
        float top = 1.0 - smoothstep(0.94, 1.0, vMapUv.y);
        diffuseColor.a *= sides * bottom * top;`);
    };
    super(new THREE.PlaneGeometry(1, 1), material);
    this.name = "dusk-basin-backdrop";
    this.userData.state = "loading";
    this.position.set(45, -250, -900);
    this.scale.set(1800, 1800 * 752 / 1344, 1);
    this.visible = false;
  }
  update(camera: THREE.Camera, target: THREE.Vector3) {
    camera.getWorldDirection(this.direction);
    const horizontal = Math.hypot(this.direction.x, this.direction.z);
    const facing = horizontal ? -this.direction.z / horizontal : 0;
    const yaw = THREE.MathUtils.smoothstep(facing, Math.cos(Math.PI / 3.6), Math.cos(Math.PI / 12));
    const elevation = 1 - THREE.MathUtils.smoothstep(Math.abs(this.direction.y), 0.5, 0.77);
    const near = THREE.MathUtils.smoothstep(camera.position.z - this.position.z, 300, 650);
    const far = 1 - THREE.MathUtils.smoothstep(camera.position.distanceTo(target), 600, 900);
    this.material.opacity = this.userData.state === "ready" ? 0.78 * yaw * elevation * near * far : 0;
    this.visible = !this.destroyed && this.material.opacity > 0.001;
  }
  dispose() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.userData.state = "disposed";
    this.visible = false;
    this.removeFromParent();
    this.material.map!.dispose();
    this.material.dispose();
    this.geometry.dispose();
  }
}

const terrainHash = (a: number, b: number) => { const s=Math.sin(a*127.1+b*311.7)*43758.5453; return s-Math.floor(s); };
const terrainNoise = (x: number, y: number) => {
  const xi=Math.floor(x), yi=Math.floor(y), xf=x-xi, yf=y-yi;
  const u=xf*xf*(3-2*xf), v=yf*yf*(3-2*yf);
  const a=terrainHash(xi,yi), b=terrainHash(xi+1,yi), c=terrainHash(xi,yi+1), d=terrainHash(xi+1,yi+1);
  return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v;
};
const terrainFbm = (x: number, y: number) => {
  let value=0, amplitude=0.5, frequency=1;
  for(let i=0;i<4;i++){value+=amplitude*terrainNoise(x*frequency,y*frequency); frequency*=2.03; amplitude*=0.5;}
  return value;
};
/** A quiet operating basin, low foothills, then larger ridges softened by scene fog. */
export function basinHeight(x: number, z: number, cx: number, cz: number, hx: number, hz: number) {
  const out=Math.hypot(Math.max(0,Math.abs(x-cx)-hx),Math.max(0,Math.abs(z-cz)-hz));
  const rise=THREE.MathUtils.smoothstep(out,30,200), far=THREE.MathUtils.smoothstep(out,200,620);
  const ridge=1-Math.abs(terrainFbm(x/190,z/190)*2-1);
  return rise*(terrainFbm(x/150+3,z/150)*7+ridge*ridge*7)+far*(ridge*ridge*62+terrainFbm(x/300+9,z/300)*26)-(1-rise)*0.4;
}

/** Neutral, unlabelled scenery; no beacon, selection geometry, or simulation identity. */
export function outpostGeometry() {
  const parts = [
    new THREE.BoxGeometry(10, 2, 6).translate(0, 1, 0),
    new THREE.SphereGeometry(2.1, 10, 6, 0, Math.PI*2, 0, Math.PI/2).translate(-2, 2, 0),
    new THREE.CylinderGeometry(0.13, 0.22, 14, 5).translate(3, 7, 0),
    new THREE.BoxGeometry(3.5, 0.15, 0.15).translate(3, 11, 0),
  ];
  const merged=mergeGeometries(parts)!;
  for(const geometry of parts)geometry.dispose();
  return merged;
}
