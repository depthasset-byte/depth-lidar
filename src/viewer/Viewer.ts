// three.js 기반 3D 뷰어. 스토어 상태를 받아 장면을 맞추고, 선택·찍기·변환 조작 결과를 콜백으로 돌려준다.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { MeshBVH, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import type { Mat4, MeshData } from '../geometry/mesh';
import type { AppState, ScanObject, TextureInfo, Vec3 } from '../store';

/* eslint-disable @typescript-eslint/no-explicit-any */
(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const srgbToLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export interface ViewerHandlers {
  onPick(point: Vec3, objectId: string): void;
  onSelection(masks: Record<string, Uint8Array>, subtract: boolean): void;
  onGizmoCommit(id: string, matrix: Mat4): void;
}

interface Visual {
  id: string;
  group: THREE.Group;
  geometry: THREE.BufferGeometry;
  mesh: THREE.Mesh | null;
  wire: THREE.Mesh | null;
  points: THREE.Points;
  sel: THREE.Object3D | null;
  holes: THREE.Object3D | null;
  data: MeshData;
  texture: TextureInfo | null;
  map: THREE.Texture | null;
  matrix: Mat4 | null;
  isCloud: boolean;
}

interface Label {
  pos: THREE.Vector3;
  el: HTMLDivElement;
}

export type ViewPreset = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private persp = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 10000);
  private camera: THREE.Camera = this.persp;
  private controls: OrbitControls;
  private gizmo: TransformControls;
  private pivot = new THREE.Object3D();
  private pivotStartInv = new THREE.Matrix4();
  private gizmoStart = new THREE.Matrix4();
  private gizmoId: string | null = null;
  private gizmoDragging = false;
  private light = new THREE.DirectionalLight(0xffffff, 2.4);
  private grid: THREE.GridHelper | null = null;
  private visuals = new Map<string, Visual>();
  private overlay = new THREE.Group();
  private labels: Label[] = [];
  private labelLayer: HTMLDivElement;
  private svg: SVGSVGElement;
  private axesScene = new THREE.Scene();
  private axesCam = new THREE.OrthographicCamera(-1.4, 1.4, 1.4, -1.4, 0.1, 10);
  private dirty = true;
  private raf = 0;
  private disposed = false;
  private prev: AppState | null = null;
  private state: AppState | null = null;
  private radius = 100;
  private center = new THREE.Vector3();
  private ro: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private drag: { x: number; y: number; moved: boolean; selecting: boolean; pts: { x: number; y: number }[]; subtract: boolean } | null = null;
  private firstFit = true;

  constructor(private container: HTMLElement, private handlers: ViewerHandlers) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = false;
    const canvas = this.renderer.domElement;
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;outline:none;';
    container.appendChild(canvas);

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;');
    container.appendChild(this.svg);
    this.labelLayer = document.createElement('div');
    this.labelLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    container.appendChild(this.labelLayer);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f48, 1.1));
    this.scene.add(this.light, this.light.target, this.overlay, this.pivot);
    this.persp.position.set(160, 110, 220);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.zoomSpeed = 1.2;
    this.controls.addEventListener('change', () => this.invalidate());

    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSize(0.9);
    this.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      const dragging = !!(e as unknown as { value: boolean }).value;
      this.controls.enabled = !dragging;
      this.gizmoDragging = dragging;
      if (!dragging && this.gizmoId) {
        const v = this.visuals.get(this.gizmoId);
        if (v) {
          v.group.updateMatrix();
          this.handlers.onGizmoCommit(this.gizmoId, v.group.matrix.elements.slice());
        }
      }
    });
    this.gizmo.addEventListener('objectChange', () => {
      const v = this.gizmoId ? this.visuals.get(this.gizmoId) : null;
      if (!v) return;
      this.pivot.updateMatrixWorld(true);
      const m = new THREE.Matrix4().multiplyMatrices(this.pivot.matrixWorld, this.pivotStartInv).multiply(this.gizmoStart);
      m.decompose(v.group.position, v.group.quaternion, v.group.scale);
      this.invalidate();
    });
    this.gizmo.addEventListener('change', () => this.invalidate());

    // 방향 표시 축
    const axes = new THREE.AxesHelper(1);
    (axes.material as THREE.LineBasicMaterial).depthTest = false;
    this.axesScene.add(axes);

    canvas.addEventListener('pointerdown', this.onDown, true);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('dblclick', this.onDbl);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      if (this.dirty) this.renderNow();
    };
    loop();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    for (const v of this.visuals.values()) this.disposeVisual(v);
    this.visuals.clear();
    this.controls.dispose();
    this.gizmo.dispose();
    this.renderer.dispose();
    this.container.replaceChildren();
  }

  invalidate() {
    this.dirty = true;
  }

  private size() {
    return { w: Math.max(1, this.container.clientWidth), h: Math.max(1, this.container.clientHeight) };
  }

  private resize() {
    const { w, h } = this.size();
    this.renderer.setSize(w, h, false);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.updateOrtho();
    this.invalidate();
  }

  private updateOrtho() {
    const { w, h } = this.size();
    const dist = this.camera.position.distanceTo(this.controls?.target ?? this.center);
    const half = Math.max(1e-6, dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)));
    this.ortho.top = half;
    this.ortho.bottom = -half;
    this.ortho.left = (-half * w) / h;
    this.ortho.right = (half * w) / h;
    this.ortho.updateProjectionMatrix();
  }

  renderNow() {
    this.dirty = false;
    const { w, h } = this.size();
    const dist = this.camera.position.distanceTo(this.controls.target);
    if (this.camera === this.persp) {
      this.persp.near = Math.max(1e-4, dist * 0.02);
      this.persp.far = dist + this.radius * 6 + 10;
      this.persp.updateProjectionMatrix();
    } else {
      this.ortho.near = -(this.radius * 6 + dist);
      this.ortho.far = dist + this.radius * 6 + 10;
      this.ortho.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.light.position.copy(this.camera.position).addScaledVector(right, -dist * 0.35).addScaledVector(up, dist * 0.45);
    this.light.target.position.copy(this.controls.target);
    this.light.target.updateMatrixWorld();
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    // 방향 축 (왼쪽 아래)
    this.renderer.clearDepth();
    this.renderer.setViewport(10, 10, 76, 76);
    this.axesCam.position.set(0, 0, 3).applyQuaternion(this.camera.quaternion);
    this.axesCam.quaternion.copy(this.camera.quaternion);
    this.axesCam.updateMatrixWorld();
    this.renderer.render(this.axesScene, this.axesCam);
    this.renderer.setViewport(0, 0, w, h);
    this.updateLabels();
  }

  // ───────── 상태 동기화 ─────────
  sync(s: AppState) {
    const p = this.prev;
    this.state = s;
    const objectsChanged = !p || p.objects !== s.objects;
    const viewChanged = !p || p.view !== s.view;
    if (objectsChanged || viewChanged) {
      const ids = new Set(s.objects.map((o) => o.id));
      for (const [id, v] of this.visuals)
        if (!ids.has(id)) {
          this.disposeVisual(v);
          this.visuals.delete(id);
        }
      let geomChanged = false;
      for (const o of s.objects) {
        let v = this.visuals.get(o.id);
        if (!v || v.data !== o.data) {
          if (v) this.disposeVisual(v);
          v = this.buildVisual(o);
          this.visuals.set(o.id, v);
          geomChanged = true;
        }
        if (v.texture !== o.texture) {
          v.map?.dispose();
          v.map = null;
          v.texture = o.texture;
          if (o.texture) {
            v.map = new THREE.CanvasTexture(o.texture.canvas);
            v.map.colorSpace = THREE.SRGBColorSpace;
            v.map.anisotropy = 4;
          }
        }
        if (v.matrix !== o.matrix && !(this.gizmoDragging && this.gizmoId === o.id)) {
          new THREE.Matrix4().fromArray(o.matrix).decompose(v.group.position, v.group.quaternion, v.group.scale);
          v.matrix = o.matrix;
          geomChanged = true;
        }
        v.group.visible = o.visible;
        this.applyMaterial(v, o, s);
      }
      if (objectsChanged) {
        this.updateBounds();
        if (this.firstFit && s.objects.length) {
          this.firstFit = false;
          this.fitView();
        }
        if (!s.objects.length) this.firstFit = true;
      }
      void geomChanged;
    }
    if (viewChanged) {
      this.setOrtho(s.view.ortho);
      this.updateGrid(s.view.grid);
    }
    if (objectsChanged || !p || p.selection !== s.selection) this.updateSelection(s);
    if (objectsChanged || !p || p.holes !== s.holes || p.tool !== s.tool) this.updateHoles(s);
    if (
      objectsChanged || !p || p.tool !== s.tool || p.alignPairs !== s.alignPairs || p.distancePoints !== s.distancePoints ||
      p.sectionResult !== s.sectionResult || p.measureMode !== s.measureMode || p.sectionAxis !== s.sectionAxis || p.sectionOffset !== s.sectionOffset
    )
      this.updateOverlay(s);
    if (objectsChanged || !p || p.gizmo !== s.gizmo) this.updateGizmo(s);
    this.prev = s;
    this.invalidate();
  }

  private disposeVisual(v: Visual) {
    this.scene.remove(v.group);
    (v.geometry as any).disposeBoundsTree?.();
    v.geometry.dispose();
    v.map?.dispose();
    for (const o of [v.mesh, v.wire, v.points, v.sel, v.holes]) {
      if (!o) continue;
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      m?.dispose();
      if (o === v.sel || o === v.holes) (o as THREE.Mesh).geometry?.dispose();
    }
  }

  private buildVisual(o: ScanObject): Visual {
    const d = o.data;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
    if (d.indices) g.setIndex(new THREE.BufferAttribute(d.indices, 1));
    if (d.normals) g.setAttribute('normal', new THREE.BufferAttribute(d.normals, 3));
    else if (d.indices) g.computeVertexNormals();
    if (d.colors) {
      const c = new Float32Array(d.colors.length);
      for (let i = 0; i < c.length; i++) c[i] = srgbToLin(d.colors[i]);
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    if (d.uvs) g.setAttribute('uv', new THREE.BufferAttribute(d.uvs, 2));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    const isCloud = !d.indices;
    const group = new THREE.Group();
    let mesh: THREE.Mesh | null = null, wire: THREE.Mesh | null = null;
    if (!isCloud) {
      if (d.indices!.length) (g as any).computeBoundsTree({ indirect: true });
      mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.72, metalness: 0.0 }));
      wire = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ wireframe: true, color: 0x0b0e12, transparent: true, opacity: 0.28, depthWrite: false }));
      wire.raycast = () => {};
      group.add(mesh, wire);
    }
    const points = new THREE.Points(g, new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false }));
    group.add(points);
    group.userData.id = o.id;
    this.scene.add(group);
    return { id: o.id, group, geometry: g, mesh, wire, points, sel: null, holes: null, data: d, texture: null, map: null, matrix: null, isCloud };
  }

  private applyMaterial(v: Visual, o: ScanObject, s: AppState) {
    const view = s.view;
    const showPoints = v.isCloud || view.mode === 'points';
    const hasColor = !!o.data.colors;
    const useMap = view.showColor && !!v.map && !!o.data.uvs;
    const useVC = view.showColor && hasColor && !useMap;
    if (v.mesh) {
      v.mesh.visible = !showPoints;
      const m = v.mesh.material as THREE.MeshStandardMaterial;
      if (m.map !== (useMap ? v.map : null) || m.vertexColors !== useVC || m.flatShading !== view.flat) m.needsUpdate = true;
      m.map = useMap ? v.map : null;
      m.vertexColors = useVC;
      m.flatShading = view.flat;
      m.color.set(useMap || useVC ? '#ffffff' : o.color);
    }
    if (v.wire) v.wire.visible = view.mode === 'wire';
    v.points.visible = showPoints;
    const pm = v.points.material as THREE.PointsMaterial;
    if (pm.vertexColors !== (view.showColor && hasColor)) pm.needsUpdate = true;
    pm.vertexColors = view.showColor && hasColor;
    pm.color.set(pm.vertexColors ? '#ffffff' : o.color);
  }

  private updateBounds() {
    const box = new THREE.Box3();
    let any = false;
    for (const v of this.visuals.values()) {
      if (!v.group.visible || !v.geometry.boundingBox || v.geometry.getAttribute('position').count === 0) continue;
      v.group.updateMatrixWorld(true);
      box.union(v.geometry.boundingBox.clone().applyMatrix4(v.group.matrixWorld));
      any = true;
    }
    if (!any) {
      this.radius = 100;
      this.center.set(0, 0, 0);
      return;
    }
    const sp = box.getBoundingSphere(new THREE.Sphere());
    this.radius = Math.max(sp.radius, 1e-3);
    this.center.copy(sp.center);
    if (this.grid) this.updateGrid(true);
  }

  private updateGrid(on: boolean) {
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.grid = null;
    }
    if (!on) return;
    const step = Math.pow(10, Math.floor(Math.log10(Math.max(this.radius, 1e-3))));
    const size = step * 10 * Math.max(1, Math.ceil((this.radius * 3) / (step * 10)));
    this.grid = new THREE.GridHelper(size, Math.round(size / step), 0x6f7b8a, 0x4a525d);
    const m = this.grid.material as THREE.LineBasicMaterial;
    m.transparent = true;
    m.opacity = 0.45;
    this.grid.raycast = () => {};
    this.scene.add(this.grid);
  }

  private setOrtho(on: boolean) {
    const next = on ? this.ortho : this.persp;
    if (next === this.camera) return;
    next.position.copy(this.camera.position);
    next.quaternion.copy(this.camera.quaternion);
    (next as THREE.OrthographicCamera).zoom = 1;
    this.camera = next;
    this.updateOrtho();
    this.controls.object = next as THREE.PerspectiveCamera;
    this.gizmo.camera = next;
    this.controls.update();
  }

  // ───────── 카메라 ─────────
  fitView() {
    this.updateBounds();
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    if (dir.lengthSq() < 1e-9) dir.set(1, 0.6, 1.2);
    dir.normalize();
    const dist = (this.radius / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2))) * 1.05;
    this.controls.target.copy(this.center);
    this.camera.position.copy(this.center).addScaledVector(dir, dist);
    if (this.camera === this.ortho) {
      this.ortho.zoom = 1;
      this.updateOrtho();
    }
    this.controls.update();
    this.invalidate();
  }

  setPreset(p: ViewPreset) {
    const dirs: Record<ViewPreset, [number, number, number]> = {
      front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 1, 0.0001], bottom: [0, -1, 0.0001], iso: [1, 0.7, 1.1],
    };
    const dist = this.camera.position.distanceTo(this.controls.target) || this.radius * 3;
    const d = new THREE.Vector3(...dirs[p]).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(d, dist);
    this.controls.update();
    this.invalidate();
  }

  // ───────── 선택 표시 ─────────
  private updateSelection(s: AppState) {
    for (const v of this.visuals.values()) {
      if (v.sel) {
        v.group.remove(v.sel);
        (v.sel as THREE.Mesh).geometry.dispose();
        ((v.sel as THREE.Mesh).material as THREE.Material).dispose();
        v.sel = null;
      }
      const mask = s.selection[v.id];
      if (!mask) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', v.geometry.getAttribute('position'));
      const idx: number[] = [];
      if (v.isCloud) {
        for (let i = 0; i < mask.length; i++) if (mask[i]) idx.push(i);
        if (!idx.length) continue;
        g.setIndex(idx);
        v.sel = new THREE.Points(g, new THREE.PointsMaterial({ size: 3.5, sizeAttenuation: false, color: 0xff3b30, depthTest: false }));
      } else {
        const I = v.data.indices!;
        for (let f = 0; f < mask.length; f++) if (mask[f]) idx.push(I[f * 3], I[f * 3 + 1], I[f * 3 + 2]);
        if (!idx.length) continue;
        g.setIndex(idx);
        v.sel = new THREE.Mesh(
          g,
          new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.62, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false }),
        );
      }
      v.sel.raycast = () => {};
      v.sel.renderOrder = 5;
      v.group.add(v.sel);
    }
  }

  private updateHoles(s: AppState) {
    for (const v of this.visuals.values()) {
      if (v.holes) {
        v.group.remove(v.holes);
        (v.holes as THREE.LineSegments).geometry.dispose();
        ((v.holes as THREE.LineSegments).material as THREE.Material).dispose();
        v.holes = null;
      }
      if (s.tool !== 'holes' || !s.holes || s.holes.objectId !== v.id) continue;
      const P = v.data.positions;
      const pos: number[] = [], col: number[] = [];
      for (const h of s.holes.items) {
        const c = h.checked ? [1, 0.62, 0.1] : [0.35, 0.6, 0.95];
        const n = h.vertices.length;
        for (let i = 0; i < n; i++) {
          const a = h.vertices[i] * 3, b = h.vertices[(i + 1) % n] * 3;
          pos.push(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2]);
          col.push(...c, ...c);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      v.holes = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
      v.holes.renderOrder = 6;
      v.holes.raycast = () => {};
      v.group.add(v.holes);
    }
  }

  // ───────── 월드 좌표 덧그림 (정렬 점, 거리, 단면) ─────────
  private clearOverlay() {
    for (const c of [...this.overlay.children]) {
      this.overlay.remove(c);
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    }
    this.labelLayer.replaceChildren();
    this.labels = [];
  }

  private addLabel(p: Vec3, text: string, cls: string) {
    const el = document.createElement('div');
    el.className = `v-label ${cls}`;
    el.textContent = text;
    this.labelLayer.appendChild(el);
    this.labels.push({ pos: new THREE.Vector3(...p), el });
  }

  private addMarkers(pts: Vec3[], color: number) {
    if (!pts.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
    const o = new THREE.Points(g, new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, color, depthTest: false, transparent: true }));
    o.renderOrder = 10;
    o.raycast = () => {};
    this.overlay.add(o);
  }

  private addLines(flat: ArrayLike<number>, color: number, segments: boolean) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(Array.from(flat), 3));
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
    const o = segments ? new THREE.LineSegments(g, mat) : new THREE.Line(g, mat);
    o.renderOrder = 9;
    o.raycast = () => {};
    this.overlay.add(o);
  }

  private updateOverlay(s: AppState) {
    this.clearOverlay();
    if (s.tool === 'align') {
      const fx: Vec3[] = [], mv: Vec3[] = [];
      s.alignPairs.forEach((p, i) => {
        if (p.fixed) {
          fx.push(p.fixed);
          this.addLabel(p.fixed, `기준 ${i + 1}`, 'fixed');
        }
        if (p.moving) {
          mv.push(p.moving);
          this.addLabel(p.moving, `이동 ${i + 1}`, 'moving');
        }
      });
      this.addMarkers(fx, 0x34c759);
      this.addMarkers(mv, 0xff9f0a);
    }
    if (s.tool === 'measure' && s.measureMode === 'distance' && s.distancePoints.length) {
      const pts = s.distancePoints;
      this.addMarkers(pts, 0xffd60a);
      if (pts.length > 1) this.addLines(pts.flat(), 0xffd60a, false);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        this.addLabel([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], d.toFixed(3), 'dist');
      }
    }
    if (s.tool === 'measure' && s.measureMode === 'section') {
      // 단면 평면
      const n: Vec3 = [0, 0, 0];
      n[s.sectionAxis] = 1;
      const size = this.radius * 2.4;
      const pg = new THREE.PlaneGeometry(size, size);
      const plane = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false }));
      plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...n));
      plane.position.copy(this.center);
      plane.position.setComponent(s.sectionAxis, s.sectionOffset);
      plane.raycast = () => {};
      this.overlay.add(plane);
      if (s.sectionResult && s.sectionResult.segments.length) this.addLines(s.sectionResult.segments, 0x30d5ff, true);
    }
  }

  private updateLabels() {
    if (!this.labels.length) return;
    const { w, h } = this.size();
    const v = new THREE.Vector3();
    for (const l of this.labels) {
      v.copy(l.pos).project(this.camera);
      const vis = v.z > -1 && v.z < 1;
      l.el.style.display = vis ? '' : 'none';
      if (vis) l.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -140%)`;
    }
  }

  // ───────── 변환 조작기 ─────────
  private updateGizmo(s: AppState) {
    const gz = s.gizmo;
    const v = gz ? this.visuals.get(gz.id) : null;
    if (!gz || !v) {
      this.gizmo.detach();
      this.gizmoId = null;
      return;
    }
    if (this.gizmoDragging) return;
    v.group.updateMatrixWorld(true);
    const c = v.geometry.boundingBox ? v.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(v.group.matrixWorld) : new THREE.Vector3();
    this.pivot.position.copy(c);
    this.pivot.quaternion.identity();
    this.pivot.scale.set(1, 1, 1);
    this.pivot.updateMatrixWorld(true);
    this.pivotStartInv.copy(this.pivot.matrixWorld).invert();
    v.group.updateMatrix();
    this.gizmoStart.copy(v.group.matrix);
    this.gizmoId = gz.id;
    this.gizmo.setMode(gz.mode);
    this.gizmo.attach(this.pivot);
  }

  // ───────── 포인터 입력 ─────────
  private local(e: PointerEvent | MouseEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const p = this.local(e);
    const selecting = !!this.state && this.state.tool === 'editor' && e.ctrlKey;
    this.drag = { x: p.x, y: p.y, moved: false, selecting, pts: [p], subtract: e.altKey || e.shiftKey };
    if (selecting) {
      this.controls.enabled = false;
      try {
        this.renderer.domElement.setPointerCapture(e.pointerId);
      } catch {
        /* 합성 이벤트 등 캡처할 수 없는 포인터 */
      }
      e.stopPropagation();
    }
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    const p = this.local(e);
    if (Math.hypot(p.x - d.x, p.y - d.y) > 4) d.moved = true;
    if (!d.selecting) return;
    d.pts.push(p);
    this.drawSelectionShape(d.pts);
  };

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.selecting) {
      this.controls.enabled = true;
      this.svg.replaceChildren();
      try {
        this.renderer.domElement.releasePointerCapture(e.pointerId);
      } catch {
        /* 이미 해제됨 */
      }
      if (d.moved && d.pts.length > 2) this.selectByShape(d.pts, d.subtract);
      return;
    }
    if (!d.moved && !this.gizmoDragging) {
      const hit = this.pick(d.x, d.y);
      if (hit) this.handlers.onPick(hit.point, hit.id);
    }
  };

  private onDbl = (e: MouseEvent) => {
    const p = this.local(e);
    const hit = this.pick(p.x, p.y);
    if (hit) {
      this.controls.target.set(...hit.point);
      this.controls.update();
      this.invalidate();
    }
  };

  private polygonFromDrag(pts: { x: number; y: number }[]) {
    if (this.state?.selectShape === 'rect') {
      const a = pts[0], b = pts[pts.length - 1];
      return [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
    }
    return pts;
  }

  private drawSelectionShape(pts: { x: number; y: number }[]) {
    const poly = this.polygonFromDrag(pts);
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    el.setAttribute('points', poly.map((p) => `${p.x},${p.y}`).join(' '));
    el.setAttribute('fill', 'rgba(255,59,48,0.14)');
    el.setAttribute('stroke', '#ff3b30');
    el.setAttribute('stroke-width', '1.5');
    el.setAttribute('stroke-dasharray', '5 3');
    this.svg.replaceChildren(el);
  }

  /** 화면 좌표(캔버스 기준 CSS 픽셀)에서 가장 가까운 표면 점을 찾는다. */
  pick(x: number, y: number): { point: Vec3; id: string } | null {
    const { w, h } = this.size();
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -(y / h) * 2 + 1), this.camera);
    (this.raycaster as any).firstHitOnly = true;
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.raycaster.params.Points = { threshold: (dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 2 * 5) / h };
    const targets: THREE.Object3D[] = [];
    for (const v of this.visuals.values()) {
      if (!v.group.visible) continue;
      if (v.mesh && v.mesh.visible) targets.push(v.mesh);
      else if (v.points.visible && v.geometry.getAttribute('position').count < 3000000) targets.push(v.points);
    }
    const hits = this.raycaster.intersectObjects(targets, false);
    if (!hits.length) return null;
    hits.sort((a, b) => a.distance - b.distance);
    const hit = hits[0];
    return { point: [hit.point.x, hit.point.y, hit.point.z], id: hit.object.parent!.userData.id as string };
  }

  /** 끌어서 그린 도형 안의 면(점)을 선택한다. */
  selectByShape(pts: { x: number; y: number }[], subtract: boolean) {
    const s = this.state;
    if (!s) return;
    const poly = this.polygonFromDrag(pts);
    const masks = this.computeSelection(poly, s.visibleOnly);
    this.handlers.onSelection(masks, subtract);
  }

  computeSelection(poly: { x: number; y: number }[], visibleOnly: boolean): Record<string, Uint8Array> {
    const s = this.state!;
    const { w, h } = this.size();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of poly) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const inside = (x: number, y: number) => {
      if (x < minX || x > maxX || y < minY || y > maxY) return false;
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
      }
      return c;
    };
    this.camera.updateMatrixWorld();
    const vp = new THREE.Matrix4().multiplyMatrices((this.camera as THREE.PerspectiveCamera).projectionMatrix, this.camera.matrixWorldInverse);
    const out: Record<string, Uint8Array> = {};
    for (const o of s.objects) {
      if (!o.checked || !o.visible) continue;
      const v = this.visuals.get(o.id);
      if (!v) continue;
      v.group.updateMatrixWorld(true);
      const e = new THREE.Matrix4().multiplyMatrices(vp, v.group.matrixWorld).elements;
      const P = o.data.positions;
      const nv = P.length / 3;
      const sx = new Float32Array(nv), sy = new Float32Array(nv);
      for (let i = 0; i < nv; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (cw <= 0) {
          sx[i] = NaN;
          continue;
        }
        sx[i] = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw * 0.5 + 0.5) * w;
        sy[i] = (1 - ((e[1] * x + e[5] * y + e[9] * z + e[13]) / cw * 0.5 + 0.5)) * h;
      }
      if (v.isCloud) {
        const mask = new Uint8Array(nv);
        let any = false;
        for (let i = 0; i < nv; i++) if (sx[i] === sx[i] && inside(sx[i], sy[i])) { mask[i] = 1; any = true; }
        if (any) out[o.id] = mask;
        continue;
      }
      const I = o.data.indices!;
      const tc = I.length / 3;
      const mask = new Uint8Array(tc);
      const bvh = (v.geometry as any).boundsTree as MeshBVH | undefined;
      const inv = new THREE.Matrix4().copy(v.group.matrixWorld).invert();
      const camLocal = this.camera.position.clone().applyMatrix4(inv);
      const fwdLocal = new THREE.Vector3(0, 0, -1).transformDirection(this.camera.matrixWorld).transformDirection(inv);
      const isOrtho = this.camera === this.ortho;
      const ray = new THREE.Ray();
      const c = new THREE.Vector3();
      let any = false;
      for (let f = 0; f < tc; f++) {
        const a = I[f * 3], b = I[f * 3 + 1], d = I[f * 3 + 2];
        const ax = sx[a], bx = sx[b], dx = sx[d];
        if (ax !== ax || bx !== bx || dx !== dx) continue;
        if (!inside((ax + bx + dx) / 3, (sy[a] + sy[b] + sy[d]) / 3)) continue;
        if (visibleOnly && bvh) {
          c.set((P[a * 3] + P[b * 3] + P[d * 3]) / 3, (P[a * 3 + 1] + P[b * 3 + 1] + P[d * 3 + 1]) / 3, (P[a * 3 + 2] + P[b * 3 + 2] + P[d * 3 + 2]) / 3);
          let dist: number;
          if (isOrtho) {
            ray.direction.copy(fwdLocal);
            ray.origin.copy(c).addScaledVector(fwdLocal, -this.radius * 20);
            dist = this.radius * 20;
          } else {
            ray.origin.copy(camLocal);
            ray.direction.subVectors(c, camLocal);
            dist = ray.direction.length();
            ray.direction.divideScalar(dist || 1);
          }
          const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
          if (hit && hit.faceIndex !== f && hit.distance < dist * (1 - 2e-3)) continue;
        }
        mask[f] = 1;
        any = true;
      }
      if (any) out[o.id] = mask;
    }
    return out;
  }

  /** 시험·자동 검증용: 현재 화면에서 객체가 차지하는 화면 사각형 */
  screenRectOf(id: string): { x0: number; y0: number; x1: number; y1: number } | null {
    const v = this.visuals.get(id);
    if (!v || !v.geometry.boundingBox) return null;
    const { w, h } = this.size();
    this.camera.updateMatrixWorld();
    v.group.updateMatrixWorld(true);
    const b = v.geometry.boundingBox;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      const p = new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(v.group.matrixWorld).project(this.camera);
      x0 = Math.min(x0, ((p.x + 1) / 2) * w); x1 = Math.max(x1, ((p.x + 1) / 2) * w);
      y0 = Math.min(y0, ((1 - p.y) / 2) * h); y1 = Math.max(y1, ((1 - p.y) / 2) * h);
    }
    return { x0, y0, x1, y1 };
  }

  /** 월드 좌표를 캔버스 기준 CSS 픽셀로 투영한다. */
  projectToScreen(p: Vec3): { x: number; y: number } {
    const { w, h } = this.size();
    this.camera.updateMatrixWorld();
    const v = new THREE.Vector3(...p).project(this.camera);
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
  }

  /** 검증용: 이동 조작기의 축 손잡이가 놓인 화면 위치와, 그 축 방향으로 조금 더 나아간 위치. */
  gizmoHandleScreen(axis: 0 | 1 | 2): { from: { x: number; y: number }; to: { x: number; y: number } } | null {
    if (!this.gizmoId) return null;
    const c = this.pivot.getWorldPosition(new THREE.Vector3());
    const dist = c.distanceTo(this.camera.position);
    const zoom = (this.camera as THREE.PerspectiveCamera).zoom || 1;
    const factor = this.camera === this.persp ? dist * Math.min((1.9 * Math.tan((Math.PI * this.persp.fov) / 360)) / zoom, 7) : (this.ortho.top - this.ortho.bottom) / zoom;
    const unit = (factor * this.gizmo.size) / 4;
    const dir = new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
    const a = c.clone().addScaledVector(dir, unit * 0.3), b = c.clone().addScaledVector(dir, unit * 0.9);
    return { from: this.projectToScreen([a.x, a.y, a.z]), to: this.projectToScreen([b.x, b.y, b.z]) };
  }

  cameraPosition(): Vec3 {
    return [this.camera.position.x, this.camera.position.y, this.camera.position.z];
  }

  sceneCenter(): Vec3 {
    return [this.center.x, this.center.y, this.center.z];
  }
  sceneRadius() {
    return this.radius;
  }
}
