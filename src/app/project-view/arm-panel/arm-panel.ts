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
}

interface IkResponse {
  joint_angles_deg: number[];
  end_effector_cm: [number, number, number];
  reachable: boolean;
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

  @ViewChild('canvasHost', {static: true}) canvasHost!: ElementRef<HTMLDivElement>;

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

  positionsList = computed(() => {
    const c = this.chain();
    return c ? Object.keys(c.positions ?? {}) : [];
  });

  // three.js objects
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
  private dragPlane = new THREE.Plane();
  private dragOffset = new THREE.Vector3();

  private fkSubject = new Subject<number[]>();
  private ikDragSubject = new Subject<[number, number, number]>();
  private liveSubject = new Subject<number[]>();
  private subs: Subscription[] = [];

  constructor(
    private httpService: HttpService,
    private http: HttpClient,
    private zone: NgZone,
  ) {}

  ngAfterViewInit(): void {
    this.initThree();
    this.subs.push(
      this.fkSubject.pipe(debounceTime(50)).subscribe(angles => this.callFk(angles)),
    );
    this.subs.push(
      this.ikDragSubject.pipe(throttleTime(80, undefined, {leading: true, trailing: true}))
        .subscribe(target => this.callIk(target)),
    );
    this.subs.push(
      this.liveSubject.pipe(throttleTime(100, undefined, {leading: true, trailing: true}))
        .subscribe(angles => this.callCommand(angles)),
    );
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
        this.rebuildArm();
        this.callFk(this.jointAngles());
        this.loading.set(false);
      },
      error: err => {
        this.loading.set(false);
        this.errorMsg.set(err?.status === 404 ? 'No arm configured for this project.' : 'Failed to load arm.');
      },
    });
  }

  // ────────────── three.js init ──────────────
  private initThree() {
    const host = this.canvasHost.nativeElement;
    const width = host.clientWidth || 600;
    const height = host.clientHeight || 400;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x121218);

    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 2000);
    this.camera.position.set(40, 40, 40);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({antialias: true});
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height);
    host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;

    // Floor grid 50cm
    const grid = new THREE.GridHelper(100, 20, 0x444466, 0x2a2a3a);
    this.scene.add(grid);
    const axes = new THREE.AxesHelper(10);
    this.scene.add(axes);

    // Ambient + directional
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.7);
    dir.position.set(50, 80, 50);
    this.scene.add(dir);

    // End-effector mesh
    const eeGeo = new THREE.SphereGeometry(1.5, 24, 16);
    const eeMat = new THREE.MeshStandardMaterial({color: 0xff5577, emissive: 0x441122});
    this.endEffectorMesh = new THREE.Mesh(eeGeo, eeMat);
    this.scene.add(this.endEffectorMesh);
    this.disposables.push(() => {
      eeGeo.dispose();
      eeMat.dispose();
    });

    // Resize observer
    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(host);

    // Pointer events for drag
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointerleave', this.onPointerUp);

    // Render loop (outside Angular)
    this.zone.runOutsideAngular(() => {
      const animate = () => {
        this.rafHandle = requestAnimationFrame(animate);
        this.controls?.update();
        if (this.renderer && this.scene && this.camera) {
          this.renderer.render(this.scene, this.camera);
        }
      };
      animate();
    });
  }

  private onResize() {
    if (!this.renderer || !this.camera) return;
    const host = this.canvasHost.nativeElement;
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private rebuildArm() {
    if (!this.scene) return;
    // Clean previous
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

    const chain = this.chain();
    if (!chain) return;

    const jointMat = new THREE.MeshStandardMaterial({color: 0x66aaff});
    const linkMat = new THREE.MeshStandardMaterial({color: 0x888899});

    // One sphere per joint frame, links between consecutive frames
    const numFrames = chain.joints.length + 1;
    for (let i = 0; i < numFrames; i++) {
      const geo = new THREE.SphereGeometry(1.0, 16, 12);
      const mesh = new THREE.Mesh(geo, jointMat.clone());
      this.scene.add(mesh);
      this.jointMeshes.push(mesh);
    }
    for (let i = 0; i < chain.joints.length; i++) {
      const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
      const mesh = new THREE.Mesh(geo, linkMat.clone());
      this.scene.add(mesh);
      this.linkMeshes.push(mesh);
    }

    // Workspace hint
    if (this.workspaceMesh) {
      this.scene.remove(this.workspaceMesh);
      (this.workspaceMesh.geometry as THREE.BufferGeometry).dispose();
      (this.workspaceMesh.material as THREE.Material).dispose();
      this.workspaceMesh = undefined;
    }
    const reach = chain.workspace?.reach_max_cm;
    if (reach && reach > 0) {
      const geo = new THREE.SphereGeometry(reach, 32, 16);
      const mat = new THREE.MeshBasicMaterial({color: 0x44aaff, wireframe: true, transparent: true, opacity: 0.12});
      this.workspaceMesh = new THREE.Mesh(geo, mat);
      this.scene.add(this.workspaceMesh);
    }
  }

  private updateArmFromFrames(frames: [number, number, number][]) {
    // Joints
    for (let i = 0; i < this.jointMeshes.length; i++) {
      const f = frames[i];
      if (!f) continue;
      this.jointMeshes[i].position.set(f[0], f[1], f[2]);
    }
    // Links connect frames[i] -> frames[i+1]
    for (let i = 0; i < this.linkMeshes.length; i++) {
      const a = frames[i];
      const b = frames[i + 1];
      if (!a || !b) continue;
      const va = new THREE.Vector3(a[0], a[1], a[2]);
      const vb = new THREE.Vector3(b[0], b[1], b[2]);
      const mid = va.clone().add(vb).multiplyScalar(0.5);
      const dir = vb.clone().sub(va);
      const len = dir.length();
      const mesh = this.linkMeshes[i];
      mesh.position.copy(mid);
      mesh.scale.set(1, Math.max(len, 0.001), 1);
      // Orient cylinder (default Y axis) along dir
      const up = new THREE.Vector3(0, 1, 0);
      const q = new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize());
      mesh.quaternion.copy(q);
    }
    const ee = frames[frames.length - 1];
    if (ee && this.endEffectorMesh) {
      this.endEffectorMesh.position.set(ee[0], ee[1], ee[2]);
    }
  }

  // ────────────── API calls ──────────────
  private callFk(angles: number[]) {
    if (!this.chain()) return;
    this.http.post<FkResponse>(this.apiBase() + '/fk', {joint_angles_deg: angles}).subscribe({
      next: res => {
        this.updateArmFromFrames(res.frames);
        this.endEffector.set(res.end_effector_cm);
        this.targetXYZ.set([...res.end_effector_cm]);
        if (this.livePreview()) {
          this.liveSubject.next(angles);
        }
      },
      error: () => {/* ignore */},
    });
  }

  private callIk(target: [number, number, number]) {
    this.http.post<IkResponse>(this.apiBase() + '/ik', {
      target_cm: target,
      initial_angles_deg: this.jointAngles(),
    }).subscribe({
      next: res => {
        this.reachable.set(res.reachable);
        if (res.reachable) {
          this.jointAngles.set([...res.joint_angles_deg]);
          this.callFk(res.joint_angles_deg);
        }
      },
      error: () => this.reachable.set(false),
    });
  }

  private callCommand(angles: number[]) {
    // /command actually moves servos — must hit the Pi server (raccoon.hal
    // lives only there), not the local IDE backend.
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
    const t: [number, number, number] = [...this.targetXYZ()] as any;
    t[axis] = v;
    this.targetXYZ.set(t);
  }

  solveIk() {
    this.callIk(this.targetXYZ());
  }

  onSelectPosition(name: string) {
    this.selectedPosition.set(name);
    const c = this.chain();
    if (!c) return;
    const pos = c.positions[name];
    if (!pos) return;
    this.jointAngles.set([...pos.joint_angles_deg]);
    this.callFk(pos.joint_angles_deg);
  }

  savePosition() {
    const name = this.savePositionName().trim();
    if (!name) return;
    this.http.put(this.apiBase() + `/positions/${encodeURIComponent(name)}`, {
      joint_angles_deg: this.jointAngles(),
    }).subscribe({
      next: () => {
        this.loadChain();
        this.savePositionName.set('');
      },
    });
  }

  deletePosition() {
    const name = this.selectedPosition();
    if (!name) return;
    this.http.delete(this.apiBase() + `/positions/${encodeURIComponent(name)}`).subscribe({
      next: () => {
        this.selectedPosition.set('');
        this.loadChain();
      },
    });
  }

  toggleLive() {
    this.livePreview.set(!this.livePreview());
  }

  // ────────────── Drag IK on end-effector ──────────────
  private onPointerDown = (e: PointerEvent) => {
    if (!this.endEffectorMesh || !this.camera || !this.renderer) return;
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.endEffectorMesh);
    if (hits.length === 0) return;
    if (this.controls) this.controls.enabled = false;
    this.dragging.set(true);

    // Plane perpendicular to camera dir passing through end-effector
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);
    this.dragPlane.setFromNormalAndCoplanarPoint(camDir.negate(), this.endEffectorMesh.position.clone());
    this.dragOffset.copy(hits[0].point).sub(this.endEffectorMesh.position);

    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging() || !this.camera) return;
    this.updatePointer(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersect = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.dragPlane, intersect)) {
      intersect.sub(this.dragOffset);
      const target: [number, number, number] = [intersect.x, intersect.y, intersect.z];
      this.targetXYZ.set(target);
      this.ikDragSubject.next(target);
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.dragging()) {
      this.dragging.set(false);
      if (this.controls) this.controls.enabled = true;
      try {
        (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      } catch {/* */}
    }
  };

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
