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
