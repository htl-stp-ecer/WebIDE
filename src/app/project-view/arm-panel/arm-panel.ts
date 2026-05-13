import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
  computed,
  signal,
} from '@angular/core';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Subject, Subscription} from 'rxjs';
import {debounceTime, throttleTime} from 'rxjs/operators';
import * as THREE from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {HttpService} from '../../services/http-service';
import {HttpClient} from '@angular/common/http';

interface ArmJoint {
  index: number;
  servo: string;
  port: number;
  length_cm: number;
  axis: [number, number, number];
  mount_rpy_deg?: [number, number, number];
  joint_range_deg: [number, number];
  servo_range_deg: [number, number];
}

interface ArmPosition {
  joint_angles_deg: number[];
  xyz_cm: [number, number, number];
}

interface ArmChain {
  name: string;
  joints: ArmJoint[];
  positions: Record<string, ArmPosition>;
  workspace?: {
    reach_max_cm?: number;
    reach_min_cm?: number;
    [k: string]: any;
  };
  forbidden_zones?: any[];
}

interface FkResponse {
  frames: [number, number, number][];
  end_effector_cm: [number, number, number];
  joint_axes?: unknown[];
}

interface IkResponse {
  joint_angles_deg: number[];
  end_effector_cm: [number, number, number];
  reachable: boolean;
}

interface GizmoAxisData {
  axis: 'x' | 'y' | 'z';
  dir: THREE.Vector3;
  shaftMat: THREE.MeshStandardMaterial;
  headMat: THREE.MeshStandardMaterial;
  hitZone: THREE.Mesh;
}

@Component({
  selector: 'app-arm-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './arm-panel.html',
  styleUrl: './arm-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArmPanel implements AfterViewInit, OnDestroy, OnChanges {
  @Input() projectUuid = '';

  @ViewChild('canvasHost') canvasHost?: ElementRef<HTMLDivElement>;
  private threeInitialized = false;

  chain = signal<ArmChain | null>(null);
  loading = signal(false);
  errorMsg = signal<string | null>(null);
  jointAngles = signal<number[]>([]);
  targetXYZ = signal<[number, number, number]>([0, 0, 0]);
  endEffector = signal<[number, number, number]>([0, 0, 0]);
  reachable = signal<boolean>(true);
  livePreview = signal(false);
  selectedPosition = signal<string>('');
  savePositionName = signal<string>('');
  dragging = signal(false);
  /** null = none, -1 = end-effector, ≥2 = jointMeshes frame index */
  selectedNode = signal<number | null>(null);

  positionsList = computed(() => {
    const c = this.chain();
    return c ? Object.keys(c.positions ?? {}) : [];
  });

  selectedNodeLabel = computed(() => {
    const sel = this.selectedNode();
    if (sel === null) return null;
    if (sel === -1) return 'End-effector';
    if (sel >= 2) {
      const j = this.chain()?.joints[sel - 2];
      return j ? `J${j.index} · ${j.servo}` : `Frame ${sel}`;
    }
    return null;
  });

  // three.js scene objects
  private renderer?: THREE.WebGLRenderer;
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private controls?: OrbitControls;
  private rafHandle = 0;
  private resizeObserver?: ResizeObserver;
  private jointMeshes: THREE.Mesh[] = [];
  private linkMeshes: THREE.Mesh[] = [];
  private endEffectorMesh?: THREE.Mesh;
  private workspaceMesh?: THREE.Mesh;
  private disposables: Array<() => void> = [];
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  // Gizmo (XYZ translation arrows, shown for selected node)
  private gizmoGroup = new THREE.Group();
  private gizmoAxes: GizmoAxisData[] = [];
  private hoveredGizmoAxis: 'x' | 'y' | 'z' | null = null;
  private isGizmoDrag = false;
  private activeGizmoAxis: 'x' | 'y' | 'z' | null = null;
  private gizmoDragAxisDir = new THREE.Vector3();
  private gizmoDragAxisOrigin = new THREE.Vector3();
  private gizmoDragCamPlane = new THREE.Plane();

  // Direct node drag (screen-plane IK, same as old behaviour)
  private nodeDragPlane = new THREE.Plane();
  private nodeDragOffset = new THREE.Vector3();

  // Last FK frames, cached so arrow keys can compute deltas
  private lastFrames: [number, number, number][] = [];

  private fkSubject = new Subject<number[]>();
  private ikDragSubject = new Subject<{target: [number, number, number]; endJointIndex: number | null}>();
  private liveSubject = new Subject<number[]>();
  private subs: Subscription[] = [];

  private keydownHandler = (e: KeyboardEvent) => this.zone.run(() => this.onKeyDown(e));

  constructor(
    private httpService: HttpService,
    private http: HttpClient,
    private zone: NgZone,
  ) {}

  ngAfterViewInit(): void {
    this.subs.push(
      this.fkSubject.pipe(debounceTime(50)).subscribe(angles => this.callFk(angles)),
    );
    this.subs.push(
      this.ikDragSubject
        .pipe(throttleTime(80, undefined, {leading: true, trailing: true}))
        .subscribe(({target, endJointIndex}) => this.callIk(target, endJointIndex)),
    );
    this.subs.push(
      this.liveSubject
        .pipe(throttleTime(100, undefined, {leading: true, trailing: true}))
        .subscribe(angles => this.callCommand(angles)),
    );
    document.addEventListener('keydown', this.keydownHandler);
    if (this.projectUuid) this.loadChain();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['projectUuid'] && !changes['projectUuid'].firstChange && this.projectUuid) {
      this.loadChain();
    }
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafHandle);
    this.resizeObserver?.disconnect();
    this.subs.forEach(s => s.unsubscribe());
    document.removeEventListener('keydown', this.keydownHandler);
    this.disposables.forEach(d => d());
    this.disposables = [];
    this.disposeScene();
    this.renderer?.dispose();
    if (this.renderer) {
      const el = this.renderer.domElement;
      el.parentElement?.removeChild(el);
    }
  }

  private apiBase() {
    return `/api/v1/projects/${this.projectUuid}/arm`;
  }

  private loadChain() {
    this.loading.set(true);
    this.errorMsg.set(null);
    this.http.get<ArmChain>(this.apiBase() + '/chain').subscribe({
      next: chain => {
        this.chain.set(chain);
        this.jointAngles.set(chain.joints.map(j => (j.joint_range_deg[0] + j.joint_range_deg[1]) / 2));
        this.loading.set(false);
        // canvas host rendered via @if — wait one tick so ViewChild is populated
        setTimeout(() => {
          if (!this.threeInitialized && this.canvasHost) {
            this.initThree();
            this.threeInitialized = true;
          }
          this.rebuildArm();
          this.callFk(this.jointAngles());
        }, 0);
      },
      error: err => {
        this.loading.set(false);
        this.errorMsg.set(
          err?.status === 404 ? 'No arm configured for this project.' : 'Failed to load arm.',
        );
      },
    });
  }

  // ────────────── three.js setup ──────────────

  private initThree() {
    if (!this.canvasHost) return;
    const host = this.canvasHost.nativeElement;
    const width = host.clientWidth || 600;
    const height = host.clientHeight || 400;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x121218);

    // Z-up world (robotics convention)
    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(40, -40, 30);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({antialias: true});
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height);
    host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;

    // Floor grid in XY plane (Z-up)
    const grid = new THREE.GridHelper(100, 20, 0x444466, 0x2a2a3a);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);
    this.scene.add(new THREE.AxesHelper(10));

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(50, 80, 50);
    this.scene.add(dir);

    // End-effector sphere
    const eeGeo = new THREE.SphereGeometry(1.5, 24, 16);
    const eeMat = new THREE.MeshStandardMaterial({color: 0xff5577, emissive: 0x441122});
    this.endEffectorMesh = new THREE.Mesh(eeGeo, eeMat);
    this.scene.add(this.endEffectorMesh);
    this.disposables.push(() => { eeGeo.dispose(); eeMat.dispose(); });

    // XYZ gizmo group
    this.gizmoGroup.visible = false;
    this.scene.add(this.gizmoGroup);
    this.buildGizmo();

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(host);

    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointerleave', this.onPointerUp);

    this.zone.runOutsideAngular(() => {
      const animate = () => {
        this.rafHandle = requestAnimationFrame(animate);
        this.controls?.update();
        // Scale gizmo proportionally to camera distance for consistent screen size
        if (this.gizmoGroup.visible && this.camera) {
          const dist = this.gizmoGroup.position.distanceTo(this.camera.position);
          this.gizmoGroup.scale.setScalar(Math.max(dist * 0.05, 0.5));
        }
        if (this.renderer && this.scene && this.camera) {
          this.renderer.render(this.scene, this.camera);
        }
      };
      animate();
    });
  }

  private buildGizmo() {
    const SHAFT = 6;
    const HEAD = 2;
    const configs: {axis: 'x' | 'y' | 'z'; color: number; dir: THREE.Vector3}[] = [
      {axis: 'x', color: 0xff3333, dir: new THREE.Vector3(1, 0, 0)},
      {axis: 'y', color: 0x33cc33, dir: new THREE.Vector3(0, 1, 0)},
      {axis: 'z', color: 0x3399ff, dir: new THREE.Vector3(0, 0, 1)},
    ];

    for (const {axis, color, dir} of configs) {
      // THREE.js cylinders/cones are Y-aligned; rotate to target axis
      const q = new THREE.Quaternion();
      if (axis === 'x') q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
      else if (axis === 'z') q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

      const shaftGeo = new THREE.CylinderGeometry(0.22, 0.22, SHAFT, 8);
      const shaftMat = new THREE.MeshStandardMaterial({color, emissive: color, emissiveIntensity: 0.15});
      const shaft = new THREE.Mesh(shaftGeo, shaftMat);
      shaft.quaternion.copy(q);
      shaft.position.copy(dir.clone().multiplyScalar(SHAFT / 2));

      const headGeo = new THREE.ConeGeometry(0.65, HEAD, 8);
      const headMat = new THREE.MeshStandardMaterial({color, emissive: color, emissiveIntensity: 0.15});
      const head = new THREE.Mesh(headGeo, headMat);
      head.quaternion.copy(q);
      head.position.copy(dir.clone().multiplyScalar(SHAFT + HEAD / 2));

      // Invisible fat cylinder for easier raycasting
      const hitGeo = new THREE.CylinderGeometry(1.3, 1.3, SHAFT + HEAD + 0.5, 8);
      const hitMat = new THREE.MeshBasicMaterial({transparent: true, opacity: 0, depthWrite: false});
      const hitZone = new THREE.Mesh(hitGeo, hitMat);
      hitZone.quaternion.copy(q);
      hitZone.position.copy(dir.clone().multiplyScalar((SHAFT + HEAD) / 2));
      hitZone.userData['gizmoAxis'] = axis;

      this.gizmoGroup.add(shaft, head, hitZone);
      this.gizmoAxes.push({axis, dir, shaftMat, headMat, hitZone});
      this.disposables.push(() => {
        shaftGeo.dispose(); shaftMat.dispose();
        headGeo.dispose(); headMat.dispose();
        hitGeo.dispose(); hitMat.dispose();
      });
    }
  }

  private updateGizmo() {
    const sel = this.selectedNode();
    if (sel === null || this.lastFrames.length === 0) {
      this.gizmoGroup.visible = false;
      return;
    }
    const frame = sel === -1
      ? this.lastFrames[this.lastFrames.length - 1]
      : this.lastFrames[sel];
    if (!frame) {
      this.gizmoGroup.visible = false;
      return;
    }
    this.gizmoGroup.position.set(frame[0], frame[1], frame[2]);
    this.gizmoGroup.visible = true;
  }

  private highlightGizmoAxis(axis: 'x' | 'y' | 'z' | null) {
    if (this.hoveredGizmoAxis === axis) return;
    this.hoveredGizmoAxis = axis;
    for (const ga of this.gizmoAxes) {
      const active = ga.axis === axis;
      ga.shaftMat.emissiveIntensity = active ? 0.75 : 0.15;
      ga.headMat.emissiveIntensity = active ? 0.75 : 0.15;
    }
  }

  private onResize() {
    if (!this.renderer || !this.camera || !this.canvasHost) return;
    const host = this.canvasHost.nativeElement;
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private rebuildArm() {
    if (!this.scene) return;
    this.jointMeshes.forEach(m => {
      this.scene!.remove(m);
      (m.geometry as THREE.BufferGeometry).dispose();
      (m.material as THREE.Material).dispose();
    });
    this.linkMeshes.forEach(m => {
      this.scene!.remove(m);
      (m.geometry as THREE.BufferGeometry).dispose();
      (m.material as THREE.Material).dispose();
    });
    this.jointMeshes = [];
    this.linkMeshes = [];

    if (this.workspaceMesh) {
      this.scene.remove(this.workspaceMesh);
      (this.workspaceMesh.geometry as THREE.BufferGeometry).dispose();
      (this.workspaceMesh.material as THREE.Material).dispose();
      this.workspaceMesh = undefined;
    }
    const reach = this.chain()?.workspace?.reach_max_cm;
    if (reach && reach > 0) {
      const geo = new THREE.SphereGeometry(reach, 32, 16);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x44aaff, wireframe: true, transparent: true, opacity: 0.12,
      });
      this.workspaceMesh = new THREE.Mesh(geo, mat);
      this.scene.add(this.workspaceMesh);
    }
  }

  private ensureMeshCounts(numFrames: number) {
    if (!this.scene) return;
    const desired = Math.max(0, numFrames - 1);
    while (this.jointMeshes.length < desired) {
      const geo = new THREE.SphereGeometry(1.0, 16, 12);
      const mat = new THREE.MeshStandardMaterial({color: 0x66aaff});
      const mesh = new THREE.Mesh(geo, mat);
      this.scene.add(mesh);
      this.jointMeshes.push(mesh);
    }
    while (this.jointMeshes.length > desired) {
      const mesh = this.jointMeshes.pop()!;
      this.scene.remove(mesh);
      (mesh.geometry as THREE.BufferGeometry).dispose();
      (mesh.material as THREE.Material).dispose();
    }
    while (this.linkMeshes.length < desired) {
      const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
      const mat = new THREE.MeshStandardMaterial({color: 0x888899});
      const mesh = new THREE.Mesh(geo, mat);
      this.scene.add(mesh);
      this.linkMeshes.push(mesh);
    }
    while (this.linkMeshes.length > desired) {
      const mesh = this.linkMeshes.pop()!;
      this.scene.remove(mesh);
      (mesh.geometry as THREE.BufferGeometry).dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }

  private updateArmFromFrames(frames: [number, number, number][]) {
    this.lastFrames = frames;
    this.ensureMeshCounts(frames.length);

    for (let i = 0; i < this.jointMeshes.length; i++) {
      const f = frames[i];
      if (f) this.jointMeshes[i].position.set(f[0], f[1], f[2]);
    }
    for (let i = 0; i < this.linkMeshes.length; i++) {
      const a = frames[i];
      const b = frames[i + 1];
      if (!a || !b) continue;
      const va = new THREE.Vector3(a[0], a[1], a[2]);
      const vb = new THREE.Vector3(b[0], b[1], b[2]);
      const dir = vb.clone().sub(va);
      const len = dir.length();
      const mesh = this.linkMeshes[i];
      mesh.position.copy(va.clone().add(vb).multiplyScalar(0.5));
      mesh.scale.set(1, Math.max(len, 0.001), 1);
      mesh.visible = len > 1e-4;
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        dir.clone().normalize(),
      );
    }
    const ee = frames[frames.length - 1];
    if (ee && this.endEffectorMesh) {
      this.endEffectorMesh.position.set(ee[0], ee[1], ee[2]);
    }

    this.updateGizmo();
  }

  // ────────────── API calls ──────────────

  private callFk(angles: number[]) {
    if (!this.chain()) return;
    this.http.post<FkResponse>(this.apiBase() + '/fk', {joint_angles_deg: angles}).subscribe({
      next: res => {
        this.updateArmFromFrames(res.frames);
        this.endEffector.set(res.end_effector_cm);
        this.targetXYZ.set([...res.end_effector_cm]);
        if (this.livePreview()) this.liveSubject.next(angles);
      },
      error: () => {/* ignore */},
    });
  }

  private callIk(target: [number, number, number], endJointIndex: number | null = null) {
    const body: Record<string, unknown> = {
      target_cm: target,
      initial_angles_deg: this.jointAngles(),
    };
    if (endJointIndex !== null && endJointIndex >= 0) {
      body['end_joint_index'] = endJointIndex;
    }
    this.http.post<IkResponse>(this.apiBase() + '/ik', body).subscribe({
      next: res => {
        this.reachable.set(res.reachable);
        this.jointAngles.set([...res.joint_angles_deg]);
        this.callFk(res.joint_angles_deg);
      },
      error: () => this.reachable.set(false),
    });
  }

  private callCommand(angles: number[]) {
    this.httpService.commandArm(this.projectUuid, angles).subscribe({
      next: () => {/* ok */},
      error: () => {/* ignore */},
    });
  }

  // ────────────── UI handlers ──────────────

  onJointChange(i: number, value: string | number) {
    const v = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(v)) return;
    const arr = [...this.jointAngles()];
    arr[i] = v;
    this.jointAngles.set(arr);
    this.fkSubject.next(arr);
  }

  onTargetChange(axis: 0 | 1 | 2, value: string | number) {
    const v = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(v)) return;
    const t: [number, number, number] = [...this.targetXYZ()] as [number, number, number];
    t[axis] = v;
    this.targetXYZ.set(t);
  }

  solveIk() {
    this.callIk(this.targetXYZ());
  }

  onSelectPosition(name: string) {
    this.selectedPosition.set(name);
    const pos = this.chain()?.positions[name];
    if (!pos) return;
    this.jointAngles.set([...pos.joint_angles_deg]);
    this.callFk(pos.joint_angles_deg);
  }

  savePosition() {
    const name = this.savePositionName().trim();
    if (!name) return;
    this.http
      .put(this.apiBase() + `/positions/${encodeURIComponent(name)}`, {
        joint_angles_deg: this.jointAngles(),
      })
      .subscribe({next: () => { this.loadChain(); this.savePositionName.set(''); }});
  }

  deletePosition() {
    const name = this.selectedPosition();
    if (!name) return;
    this.http.delete(this.apiBase() + `/positions/${encodeURIComponent(name)}`).subscribe({
      next: () => { this.selectedPosition.set(''); this.loadChain(); },
    });
  }

  toggleLive() {
    this.livePreview.set(!this.livePreview());
  }

  clearSelection() {
    this.selectedNode.set(null);
    this.gizmoGroup.visible = false;
  }

  // ────────────── Pointer events ──────────────

  private onPointerDown = (e: PointerEvent) => {
    if (!this.camera || !this.renderer) return;
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    // 1. Gizmo arrow hit (highest priority)
    if (this.gizmoGroup.visible) {
      const hits = this.raycaster.intersectObjects(
        this.gizmoAxes.map(ga => ga.hitZone), false,
      );
      if (hits.length > 0) {
        const axis = (hits[0].object as THREE.Mesh).userData['gizmoAxis'] as 'x' | 'y' | 'z';
        this.startAxisDrag(e, axis);
        return;
      }
    }

    // 2. Node selection: EE or movable joint frames (frameIdx ≥ 2)
    const selectables: THREE.Mesh[] = [];
    if (this.endEffectorMesh) selectables.push(this.endEffectorMesh);
    for (let i = 2; i < this.jointMeshes.length; i++) selectables.push(this.jointMeshes[i]);

    const nodeHits = this.raycaster.intersectObjects(selectables, false);
    if (nodeHits.length > 0) {
      const hitObj = nodeHits[0].object as THREE.Mesh;
      const nodeIdx = hitObj === this.endEffectorMesh
        ? -1
        : this.jointMeshes.indexOf(hitObj);
      this.zone.run(() => this.selectedNode.set(nodeIdx));
      this.updateGizmo();
      // Start plane-based drag immediately (select + drag in one gesture)
      this.startNodeDrag(e, hitObj, nodeIdx, nodeHits[0].point);
      return;
    }

    // 3. Empty space → deselect
    this.zone.run(() => this.selectedNode.set(null));
    this.gizmoGroup.visible = false;
  };

  private startNodeDrag(e: PointerEvent, mesh: THREE.Mesh, nodeIdx: number, hitPoint: THREE.Vector3) {
    if (!this.camera) return;
    if (this.controls) this.controls.enabled = false;
    this.dragging.set(true);
    this.isGizmoDrag = false;

    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    this.nodeDragPlane.setFromNormalAndCoplanarPoint(camDir.negate(), mesh.position.clone());
    this.nodeDragOffset.copy(hitPoint).sub(mesh.position);

    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (this.renderer) this.renderer.domElement.style.cursor = 'grabbing';
  }

  private startAxisDrag(e: PointerEvent, axis: 'x' | 'y' | 'z') {
    if (!this.camera) return;
    if (this.controls) this.controls.enabled = false;
    this.dragging.set(true);
    this.isGizmoDrag = true;
    this.activeGizmoAxis = axis;
    this.highlightGizmoAxis(axis);

    const ga = this.gizmoAxes.find(g => g.axis === axis)!;
    this.gizmoDragAxisDir.copy(ga.dir);
    this.gizmoDragAxisOrigin.copy(this.gizmoGroup.position);

    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    this.gizmoDragCamPlane.setFromNormalAndCoplanarPoint(camDir, this.gizmoDragAxisOrigin);

    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (this.renderer) this.renderer.domElement.style.cursor = 'grabbing';
  }

  private onPointerMove = (e: PointerEvent) => {
    if (!this.camera || !this.renderer) return;
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);

    if (this.dragging() && this.isGizmoDrag) {
      const worldPoint = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.gizmoDragCamPlane, worldPoint)) {
        // Project intersection onto drag axis to constrain movement
        const toPoint = worldPoint.clone().sub(this.gizmoDragAxisOrigin);
        const t = toPoint.dot(this.gizmoDragAxisDir);
        const newPos = this.gizmoDragAxisOrigin.clone().add(
          this.gizmoDragAxisDir.clone().multiplyScalar(t),
        );
        const target: [number, number, number] = [newPos.x, newPos.y, newPos.z];
        const sel = this.selectedNode();
        const endJointIndex = sel === -1 ? null : (sel !== null && sel >= 2 ? sel - 2 : null);
        if (endJointIndex !== undefined) {
          if (sel === -1) this.zone.run(() => this.targetXYZ.set(target));
          this.ikDragSubject.next({target, endJointIndex: endJointIndex ?? null});
        }
      }
      return;
    }

    if (this.dragging() && !this.isGizmoDrag) {
      // Direct screen-plane drag on the node sphere
      const intersect = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.nodeDragPlane, intersect)) {
        intersect.sub(this.nodeDragOffset);
        const target: [number, number, number] = [intersect.x, intersect.y, intersect.z];
        const sel = this.selectedNode();
        const endJointIndex = sel === -1 ? null : (sel !== null && sel >= 2 ? sel - 2 : null);
        if (endJointIndex !== undefined) {
          if (sel === -1) this.zone.run(() => this.targetXYZ.set(target));
          this.ikDragSubject.next({target, endJointIndex: endJointIndex ?? null});
        }
      }
      return;
    }

    // Hover feedback when idle
    if (!this.dragging()) {
      if (this.gizmoGroup.visible) {
        const hits = this.raycaster.intersectObjects(
          this.gizmoAxes.map(ga => ga.hitZone), false,
        );
        if (hits.length > 0) {
          const axis = (hits[0].object as THREE.Mesh).userData['gizmoAxis'] as 'x' | 'y' | 'z';
          this.highlightGizmoAxis(axis);
          this.renderer.domElement.style.cursor = 'grab';
          return;
        }
      }
      this.highlightGizmoAxis(null);

      const selectables: THREE.Object3D[] = [];
      if (this.endEffectorMesh) selectables.push(this.endEffectorMesh);
      for (let i = 2; i < this.jointMeshes.length; i++) selectables.push(this.jointMeshes[i]);
      const nodeHits = this.raycaster.intersectObjects(selectables, false);
      this.renderer.domElement.style.cursor = nodeHits.length > 0 ? 'pointer' : '';
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.dragging()) {
      this.dragging.set(false);
      this.isGizmoDrag = false;
      this.activeGizmoAxis = null;
      if (this.controls) this.controls.enabled = true;
      if (this.renderer) this.renderer.domElement.style.cursor = '';
      try { (e.target as HTMLElement).releasePointerCapture?.(e.pointerId); } catch {/* */}
    }
  };

  // ────────────── Keyboard nudge ──────────────

  private onKeyDown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName?.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const sel = this.selectedNode();
    if (sel === null) return;

    if (e.key === 'Escape') {
      this.clearSelection();
      return;
    }

    const step = e.shiftKey ? 2.0 : 0.5;
    const delta: [number, number, number] = [0, 0, 0];
    switch (e.key) {
      case 'ArrowLeft':  delta[0] = -step; break;
      case 'ArrowRight': delta[0] =  step; break;
      case 'ArrowUp':    delta[1] =  step; break;
      case 'ArrowDown':  delta[1] = -step; break;
      case 'PageUp':     delta[2] =  step; break;
      case 'PageDown':   delta[2] = -step; break;
      default: return;
    }
    e.preventDefault();

    if (this.lastFrames.length === 0) return;
    const cur: [number, number, number] = sel === -1
      ? (this.lastFrames[this.lastFrames.length - 1] ?? [0, 0, 0])
      : (this.lastFrames[sel] ?? [0, 0, 0]);

    const target: [number, number, number] = [
      cur[0] + delta[0],
      cur[1] + delta[1],
      cur[2] + delta[2],
    ];
    const endJointIndex = sel === -1 ? null : (sel >= 2 ? sel - 2 : null);
    if (sel === -1) this.targetXYZ.set(target);
    this.ikDragSubject.next({target, endJointIndex});
  }

  private updatePointer(e: PointerEvent) {
    if (!this.renderer) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private disposeScene() {
    if (!this.scene) return;
    this.jointMeshes.forEach(m => {
      (m.geometry as THREE.BufferGeometry).dispose();
      (m.material as THREE.Material).dispose();
    });
    this.linkMeshes.forEach(m => {
      (m.geometry as THREE.BufferGeometry).dispose();
      (m.material as THREE.Material).dispose();
    });
    if (this.workspaceMesh) {
      (this.workspaceMesh.geometry as THREE.BufferGeometry).dispose();
      (this.workspaceMesh.material as THREE.Material).dispose();
    }
    this.controls?.dispose();
  }
}
