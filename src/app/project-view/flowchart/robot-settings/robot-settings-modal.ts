import { Component, ElementRef, EventEmitter, Input, OnChanges, OnInit, Output, signal, SimpleChanges, ViewChild, AfterViewChecked, WritableSignal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe, NgClass, NgStyle } from '@angular/common';
import { Dialog } from 'primeng/dialog';
import { InputText } from 'primeng/inputtext';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { HttpService } from '../../../services/http-service';
import { NotificationService } from '../../../services/NotificationService';
import { TypeDefinition } from '../../../entities/TypeDefinition';
import { Subject } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { TableEditorView } from '../table/table-editor-view';
import { TableVisualizationPanel } from '../table/table-visualization-panel';
import { TableMapService, TableVisualizationService } from '../table/services';
import { Pose2D, thetaToDegrees } from '../table/models';
import { FlowOrientation } from '../models';

type SettingsTab = 'project' | 'robot' | 'start' | 'map';
type EditTarget = { type: 'sensor'; id: number } | { type: 'rotation' } | null;

interface Guideline {
  position: number;  // percentage 0-100
  type: 'center' | 'edge' | 'sensor' | 'rotation';
  sourceId?: number; // for sensor-based guidelines
}

interface ActiveGuidelines {
  x: Guideline | null;
  y: Guideline | null;
}

interface DragDistances {
  left: number;   // cm from left edge
  right: number;  // cm from right edge
  top: number;    // cm from top (front of robot)
  bottom: number; // cm from bottom (back of robot)
  centerX: number; // cm from vertical center line
  centerY: number; // cm from horizontal center line
  symmetricX: boolean; // left === right
  symmetricY: boolean; // top === bottom
}

interface Sensor {
  id: number;
  name: string;
  color: string;
  x_pct?: number;
  y_pct?: number;
  clearance_cm?: number;
}

interface CenterPoint {
  x_pct: number;
  y_pct: number;
}

@Component({
  selector: 'app-robot-settings-modal',
  standalone: true,
  imports: [FormsModule, DecimalPipe, NgClass, NgStyle, Dialog, InputText, TranslateModule, TableEditorView, TableVisualizationPanel],
  templateUrl: './robot-settings-modal.html',
  styleUrl: './robot-settings-modal.scss'
})
export class RobotSettingsModal implements OnInit, OnChanges, AfterViewChecked {
  @Input() visible = false;
  @Input() projectUuid: string | null = null;
  @Input() typeDefinitions: TypeDefinition[] = [];
  @Input() orientation: WritableSignal<FlowOrientation> | null = null;
  @Input() useAutoLayout = false;
  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() orientationChange = new EventEmitter<FlowOrientation>();
  @Output() useAutoLayoutChange = new EventEmitter<boolean>();

  readonly activeTab = signal<SettingsTab>('project');

  @ViewChild('robotBody') robotBodyRef!: ElementRef<HTMLDivElement>;
  @ViewChild('widthInput') widthInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('lengthInput') lengthInputRef?: ElementRef<HTMLInputElement>;

  connectionInfo: ConnectionInfo | undefined;
  loading = true;

  // Dimensions - separate edit states
  tempWidth = '';
  tempLength = '';
  editingWidth = false;
  editingLength = false;
  private pendingFocus: 'width' | 'length' | null = null;

  // Sensors
  sensors: Sensor[] = [];
  private deviceSensors: DeviceSensorInfo[] = [];
  private readonly sensorPalette = ['#ef4444', '#f97316', '#f59e0b', '#22c55e', '#3b82f6', '#6366f1', '#ec4899'];

  // Center points (geometric is always 50%, 50% - the robot's center)
  rotationCenter: CenterPoint | null = null;

  // Edit target (sensor or center)
  editTarget: EditTarget = null;

  // Drag state
  private isDragging = false;
  private persistSubject = new Subject<void>();

  // Guidelines and snapping
  private readonly SNAP_THRESHOLD = 5; // percentage threshold for snapping
  private readonly GRID_SNAP_CM = 1; // snap to whole cm values
  private readonly GRID_SNAP_THRESHOLD_CM = 0.3; // threshold in cm for grid snapping
  activeGuidelines: ActiveGuidelines = { x: null, y: null };
  horizontalGuidelines: Guideline[] = [];
  verticalGuidelines: Guideline[] = [];
  dragDistances: DragDistances | null = null;
  snappedToGrid: { x: boolean; y: boolean } = { x: false, y: false };
  private persistCentersSubject = new Subject<void>();
  private persistStartPoseSubject = new Subject<void>();

  constructor(
    private http: HttpService,
    private translate: TranslateService,
    private vizService: TableVisualizationService,
    private mapService: TableMapService
  ) {
    // Debounce persistence during drag
    this.persistSubject.pipe(debounceTime(300)).subscribe(() => {
      this.persistSensorsToServer();
    });
    this.persistCentersSubject.pipe(debounceTime(300)).subscribe(() => {
      this.persistCentersToServer();
    });
    this.persistStartPoseSubject.pipe(debounceTime(300)).subscribe(() => {
      this.persistStartPoseToServer();
    });
  }

  ngOnInit() {
    this.loadDeviceInfo();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['typeDefinitions'] && !changes['typeDefinitions'].firstChange) {
      this.syncSensorsFromDefinitions();
    }
    if (changes['visible'] && changes['visible'].currentValue) {
      this.loadDeviceInfo();
    }
  }

  ngAfterViewChecked() {
    if (this.pendingFocus === 'width' && this.widthInputRef) {
      this.widthInputRef.nativeElement.focus();
      this.widthInputRef.nativeElement.select();
      this.pendingFocus = null;
    } else if (this.pendingFocus === 'length' && this.lengthInputRef) {
      this.lengthInputRef.nativeElement.focus();
      this.lengthInputRef.nativeElement.select();
      this.pendingFocus = null;
    }
  }

  private loadDeviceInfo() {
    this.loading = true;
    this.http.getDeviceInfoDefault().subscribe({
      next: info => {
        this.connectionInfo = info;
        this.tempWidth = this.toDimensionString(info.width_cm);
        this.tempLength = this.toDimensionString(info.length_cm);
        this.deviceSensors = info.sensors ?? [];
        this.rotationCenter = info.rotation_center ?? null;
        this.syncTableVisualizationDimensions(info);
        this.syncTableVisualizationRotationCenter(info, info.rotation_center ?? null);
        this.syncTableVisualizationStartPose(info);
        this.syncSensorsFromDefinitions();
        this.loading = false;
      },
      error: () => {
        this.loading = false;
      }
    });
  }

  closeModal() {
    this.visible = false;
    this.visibleChange.emit(false);
  }

  // Dimensions - Inline Edit (separate width/length)
  startEditDimension(dimension: 'width' | 'length') {
    const dims = this.getDisplayDimensions();
    if (dimension === 'width') {
      this.tempWidth = this.toDimensionString(dims?.width);
      this.editingWidth = true;
      this.pendingFocus = 'width';
    } else {
      this.tempLength = this.toDimensionString(dims?.length);
      this.editingLength = true;
      this.pendingFocus = 'length';
    }
  }

  cancelDimensionEdit(dimension: 'width' | 'length') {
    const dims = this.getDisplayDimensions();
    if (dimension === 'width') {
      this.editingWidth = false;
      this.tempWidth = this.toDimensionString(dims?.width);
    } else {
      this.editingLength = false;
      this.tempLength = this.toDimensionString(dims?.length);
    }
  }

  onDimensionBlur(dimension: 'width' | 'length') {
    // Small delay to allow Enter key to fire first
    setTimeout(() => {
      if (dimension === 'width' && this.editingWidth) {
        this.saveDimension('width');
      } else if (dimension === 'length' && this.editingLength) {
        this.saveDimension('length');
      }
    }, 100);
  }

  saveDimension(dimension: 'width' | 'length') {
    const dims = this.getDisplayDimensions();
    const newWidth = dimension === 'width'
      ? this.parseDimension(this.tempWidth)
      : dims?.width;
    const newLength = dimension === 'length'
      ? this.parseDimension(this.tempLength)
      : dims?.length;

    if (newWidth === undefined || newLength === undefined || newWidth <= 0 || newLength <= 0) {
      this.cancelDimensionEdit(dimension);
      return;
    }

    // Close edit mode immediately for responsive feel
    if (dimension === 'width') {
      this.editingWidth = false;
    } else {
      this.editingLength = false;
    }

    this.http.updateDeviceDimensions(newWidth, newLength).subscribe({
      next: info => {
        this.connectionInfo = info;
        this.tempWidth = this.toDimensionString(info.width_cm);
        this.tempLength = this.toDimensionString(info.length_cm);
        this.syncTableVisualizationDimensions(info);
        this.syncTableVisualizationRotationCenter(info, this.rotationCenter);
        // Clamp centers and sensors to new bounds (they stay in percentage, so no action needed)
        // But clearances might need clamping if they exceed new dimensions
        this.clampClearancesToDimensions();
      },
      error: () => {
        NotificationService.showError(
          this.translate.instant('ROBOT_SETTINGS.SAVE_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
      }
    });
  }

  private clampClearancesToDimensions() {
    const maxClearance = this.sensorMaxClearanceCm;
    if (maxClearance === null) return;

    let needsPersist = false;
    this.sensors = this.sensors.map(sensor => {
      if (sensor.clearance_cm !== undefined && sensor.clearance_cm > maxClearance) {
        needsPersist = true;
        return { ...sensor, clearance_cm: maxClearance };
      }
      return sensor;
    });

    if (needsPersist) {
      this.persistSensorsToServer();
    }
  }

  private parseDimension(value: string): number | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isNaN(parsed) || parsed < 0 ? undefined : parsed;
  }

  private toDimensionString(value: number | undefined | null): string {
    return value === undefined || value === null ? '' : value.toString();
  }

  formatDimension(value: number | undefined | null): string {
    return value === undefined || value === null ? '--' : value.toString();
  }

  private syncTableVisualizationDimensions(info?: ConnectionInfo) {
    const width = info?.width_cm;
    const length = info?.length_cm;
    if (typeof width === 'number' && typeof length === 'number' && width > 0 && length > 0) {
      this.vizService.setRobotDimensions(width, length);
    }
  }

  private syncTableVisualizationRotationCenter(
    info?: ConnectionInfo,
    rotationCenter?: CenterPoint | null
  ) {
    const width = info?.width_cm;
    const length = info?.length_cm;
    if (typeof width !== 'number' || typeof length !== 'number' || width <= 0 || length <= 0) {
      this.vizService.setRotationCenter(0, 0);
      return;
    }

    if (!rotationCenter) {
      this.vizService.setRotationCenter(0, 0);
      return;
    }

    const xCm = (width * rotationCenter.x_pct) / 100;
    const yCm = length * (1 - rotationCenter.y_pct / 100);
    const forwardCm = yCm - length / 2;
    const strafeCm = (width / 2) - xCm;

    this.vizService.setRotationCenter(forwardCm, strafeCm);
  }

  private syncTableVisualizationStartPose(info?: ConnectionInfo) {
    const pose = info?.start_pose;
    if (!pose) return;
    this.vizService.setStartPose(pose.x_cm, pose.y_cm, pose.theta_deg);
  }

  // Sensors
  private syncSensorsFromDefinitions() {
    const irSensorDefs = this.typeDefinitions.filter(d => d.type === 'IRSensor');
    const sensorLookup = new Map(this.deviceSensors.map(s => [s.name, s]));

    this.sensors = irSensorDefs.map((def, index) => {
      const stored = sensorLookup.get(def.name);
      return {
        id: index + 1,
        name: def.name,
        color: this.sensorPalette[index % this.sensorPalette.length],
        x_pct: stored?.x_pct,
        y_pct: stored?.y_pct,
        clearance_cm: stored?.clearance_cm
      };
    });

    // Clear sensor selection if sensor no longer exists
    if (this.editTarget?.type === 'sensor') {
      const sensorTarget = this.editTarget;
      if (!this.sensors.some(s => s.id === sensorTarget.id)) {
        this.editTarget = null;
      }
    }
    this.syncTableVisualizationSensors();
  }

  private syncTableVisualizationSensors() {
    const dims = this.getDisplayDimensions();
    if (!dims) {
      this.vizService.clearSensors();
      return;
    }

    this.vizService.clearSensors();
    this.sensors.forEach((sensor, index) => {
      if (sensor.x_pct === undefined || sensor.y_pct === undefined) return;
      const xCm = (dims.width * sensor.x_pct) / 100;
      const yCm = dims.length * (1 - sensor.y_pct / 100);
      const forwardCm = yCm - dims.length / 2;
      const strafeCm = (dims.width / 2) - xCm;
      this.vizService.configureLineSensor(index, forwardCm, strafeCm);
    });
  }

  // Selection
  selectSensor(sensorId: number) {
    if (this.editTarget?.type === 'sensor' && this.editTarget.id === sensorId) {
      this.editTarget = null;
    } else {
      this.editTarget = { type: 'sensor', id: sensorId };
    }
  }

  selectRotationCenter() {
    this.editTarget = this.editTarget?.type === 'rotation' ? null : { type: 'rotation' };
  }

  get selectedSensorId(): number | null {
    return this.editTarget?.type === 'sensor' ? this.editTarget.id : null;
  }

  get selectedSensor(): Sensor | undefined {
    if (this.editTarget?.type === 'sensor') {
      const sensorId = this.editTarget.id;
      return this.sensors.find(s => s.id === sensorId);
    }
    return undefined;
  }

  get isRotationSelected(): boolean {
    return this.editTarget?.type === 'rotation';
  }

  get canEditSensorCm(): boolean {
    return this.getDisplayDimensions() !== null;
  }

  get selectedSensorXcm(): number | null {
    const dims = this.getDisplayDimensions();
    if (!dims || this.selectedSensor?.x_pct === undefined) return null;
    return this.roundToTwo((dims.width * this.selectedSensor.x_pct) / 100);
  }

  get selectedSensorYcm(): number | null {
    const dims = this.getDisplayDimensions();
    if (!dims || this.selectedSensor?.y_pct === undefined) return null;
    return this.roundToTwo(dims.length * (1 - this.selectedSensor.y_pct / 100));
  }

  get selectedSensorClearanceCm(): number | null {
    if (!this.selectedSensor?.clearance_cm) return null;
    return this.roundToTwo(this.selectedSensor.clearance_cm);
  }

  setSelectedSensorCoordCm(axis: 'x' | 'y', value: number | null) {
    if (this.selectedSensorId === null || !this.selectedSensor) return;
    const dims = this.getDisplayDimensions();
    if (!dims) return;

    const parsed = value === null ? undefined : Number(value);
    const maxCm = axis === 'x' ? dims.width : dims.length;
    const clampedCm = parsed === undefined || Number.isNaN(parsed) ? undefined : Math.min(Math.max(parsed, 0), maxCm);
    const percent = clampedCm === undefined || maxCm === 0
      ? undefined
      : axis === 'y' ? (1 - clampedCm / maxCm) * 100 : (clampedCm / maxCm) * 100;

    this.sensors = this.sensors.map(sensor => {
      if (sensor.id !== this.selectedSensorId) return sensor;
      return { ...sensor, x_pct: axis === 'x' ? percent : sensor.x_pct, y_pct: axis === 'y' ? percent : sensor.y_pct };
    });
    this.syncTableVisualizationSensors();
    this.persistSensors();
  }

  setSelectedSensorClearanceCm(value: number | null) {
    if (this.selectedSensorId === null) return;
    const parsed = value === null ? undefined : Number(value);
    const maxCm = this.sensorMaxClearanceCm;
    const clamped = parsed === undefined || Number.isNaN(parsed) ? undefined : Math.min(Math.max(parsed, 0), maxCm ?? parsed);

    this.sensors = this.sensors.map(sensor => {
      if (sensor.id !== this.selectedSensorId) return sensor;
      return { ...sensor, clearance_cm: clamped };
    });
    this.persistSensors();
  }

  get sensorMaxClearanceCm(): number | null {
    const dims = this.getDisplayDimensions();
    return dims ? Math.min(dims.width, dims.length) / 2 : null;
  }

  // Hit-testing threshold in percentage (how close click must be to select an element)
  private readonly HIT_TEST_THRESHOLD = 8;

  // Mouse events for live drag placement
  onRobotMouseDown(event: MouseEvent) {
    event.preventDefault();

    // Calculate click position as percentage
    const target = event.currentTarget as HTMLElement | null;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const clickX = ((event.clientX - rect.left) / rect.width) * 100;
    const clickY = ((event.clientY - rect.top) / rect.height) * 100;

    // Check if clicking on an existing element - auto-select it
    const hitElement = this.hitTestElement(clickX, clickY);
    if (hitElement) {
      this.editTarget = hitElement;
    }

    // Only start dragging if we have a target
    if (!this.editTarget) return;

    this.isDragging = true;
    this.computeGuidelines();
    this.updateTargetPosition(event);
  }

  /**
   * Find which element (sensor or rotation center) is closest to the click position
   */
  private hitTestElement(clickX: number, clickY: number): EditTarget {
    let closestElement: EditTarget = null;
    let closestDistance = this.HIT_TEST_THRESHOLD;

    // Check sensors
    for (const sensor of this.sensors) {
      if (sensor.x_pct === undefined || sensor.y_pct === undefined) continue;
      const dist = Math.hypot(sensor.x_pct - clickX, sensor.y_pct - clickY);
      if (dist < closestDistance) {
        closestDistance = dist;
        closestElement = { type: 'sensor', id: sensor.id };
      }
    }

    // Check rotation center
    if (this.rotationCenter) {
      const dist = Math.hypot(this.rotationCenter.x_pct - clickX, this.rotationCenter.y_pct - clickY);
      if (dist < closestDistance) {
        closestDistance = dist;
        closestElement = { type: 'rotation' };
      }
    }

    return closestElement;
  }

  onRobotMouseMove(event: MouseEvent) {
    if (!this.isDragging || !this.editTarget) return;
    event.preventDefault();
    this.updateTargetPosition(event);
  }

  onRobotMouseUp() {
    if (this.isDragging) {
      this.isDragging = false;
      this.clearGuidelines();
      // Final persist on mouse up
      if (this.editTarget?.type === 'sensor') {
        this.persistSensorsToServer();
      } else if (this.editTarget?.type === 'rotation') {
        this.persistCentersToServer();
      }
    }
  }

  private updateTargetPosition(event: MouseEvent) {
    const target = event.currentTarget as HTMLElement | null;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    let x = Math.min(Math.max(((event.clientX - rect.left) / rect.width) * 100, 0), 100);
    let y = Math.min(Math.max(((event.clientY - rect.top) / rect.height) * 100, 0), 100);

    // Apply snapping
    const snapped = this.applySnapping(x, y);
    x = snapped.x;
    y = snapped.y;

    // Compute distances for display
    this.computeDragDistances(x, y);

    if (this.editTarget?.type === 'sensor') {
      const targetId = this.editTarget.id;
      this.sensors = this.sensors.map(sensor => {
        if (sensor.id !== targetId) return sensor;
        return { ...sensor, x_pct: x, y_pct: y };
      });
      this.syncTableVisualizationSensors();
      this.persistSubject.next();
    } else if (this.editTarget?.type === 'rotation') {
      this.rotationCenter = { x_pct: x, y_pct: y };
      this.syncTableVisualizationRotationCenter(this.connectionInfo, this.rotationCenter);
      this.persistCentersSubject.next();
    }
  }

  // Guidelines and snapping
  private computeGuidelines() {
    const horizontal: Guideline[] = [];
    const vertical: Guideline[] = [];

    // Center guidelines (always present)
    horizontal.push({ position: 50, type: 'center' });
    vertical.push({ position: 50, type: 'center' });

    // Edge guidelines
    horizontal.push({ position: 0, type: 'edge' });
    horizontal.push({ position: 100, type: 'edge' });
    vertical.push({ position: 0, type: 'edge' });
    vertical.push({ position: 100, type: 'edge' });

    // Guidelines from other sensors (excluding the one being dragged)
    const editingSensorId = this.editTarget?.type === 'sensor' ? this.editTarget.id : null;
    for (const sensor of this.sensors) {
      if (sensor.id === editingSensorId) continue;
      if (sensor.x_pct !== undefined) {
        vertical.push({ position: sensor.x_pct, type: 'sensor', sourceId: sensor.id });
      }
      if (sensor.y_pct !== undefined) {
        horizontal.push({ position: sensor.y_pct, type: 'sensor', sourceId: sensor.id });
      }
    }

    // Guidelines from rotation center (if not editing it)
    if (this.editTarget?.type !== 'rotation' && this.rotationCenter) {
      vertical.push({ position: this.rotationCenter.x_pct, type: 'rotation' });
      horizontal.push({ position: this.rotationCenter.y_pct, type: 'rotation' });
    }

    this.horizontalGuidelines = horizontal;
    this.verticalGuidelines = vertical;
  }

  private applySnapping(x: number, y: number): { x: number; y: number } {
    this.activeGuidelines = { x: null, y: null };
    this.snappedToGrid = { x: false, y: false };

    const dims = this.getDisplayDimensions();

    // Find closest vertical guideline for X
    let closestX: Guideline | null = null;
    let closestXDist = Infinity;
    for (const g of this.verticalGuidelines) {
      const dist = Math.abs(g.position - x);
      if (dist < this.SNAP_THRESHOLD && dist < closestXDist) {
        closestXDist = dist;
        closestX = g;
      }
    }

    // Find closest horizontal guideline for Y
    let closestY: Guideline | null = null;
    let closestYDist = Infinity;
    for (const g of this.horizontalGuidelines) {
      const dist = Math.abs(g.position - y);
      if (dist < this.SNAP_THRESHOLD && dist < closestYDist) {
        closestYDist = dist;
        closestY = g;
      }
    }

    // Apply guideline snapping first (takes priority)
    if (closestX) {
      x = closestX.position;
      this.activeGuidelines.x = closestX;
    }
    if (closestY) {
      y = closestY.position;
      this.activeGuidelines.y = closestY;
    }

    // Apply grid snapping (whole cm values) if not already snapped to a guideline
    if (dims) {
      if (!closestX) {
        const xCm = (x / 100) * dims.width;
        const snappedXcm = Math.round(xCm / this.GRID_SNAP_CM) * this.GRID_SNAP_CM;
        if (Math.abs(xCm - snappedXcm) < this.GRID_SNAP_THRESHOLD_CM) {
          x = (snappedXcm / dims.width) * 100;
          this.snappedToGrid.x = true;
        }
      }
      if (!closestY) {
        const yCm = (y / 100) * dims.length;
        const snappedYcm = Math.round(yCm / this.GRID_SNAP_CM) * this.GRID_SNAP_CM;
        if (Math.abs(yCm - snappedYcm) < this.GRID_SNAP_THRESHOLD_CM) {
          y = (snappedYcm / dims.length) * 100;
          this.snappedToGrid.y = true;
        }
      }
    }

    return { x, y };
  }

  private clearGuidelines() {
    this.activeGuidelines = { x: null, y: null };
    this.horizontalGuidelines = [];
    this.verticalGuidelines = [];
    this.dragDistances = null;
    this.snappedToGrid = { x: false, y: false };
  }

  private computeDragDistances(xPct: number, yPct: number) {
    const dims = this.getDisplayDimensions();
    if (!dims) {
      this.dragDistances = null;
      return;
    }

    const left = this.roundToTwo((xPct / 100) * dims.width);
    const right = this.roundToTwo(((100 - xPct) / 100) * dims.width);
    const top = this.roundToTwo((yPct / 100) * dims.length);
    const bottom = this.roundToTwo(((100 - yPct) / 100) * dims.length);
    const centerX = this.roundToTwo(Math.abs(xPct - 50) / 100 * dims.width);
    const centerY = this.roundToTwo(Math.abs(yPct - 50) / 100 * dims.length);

    // Check symmetry with small tolerance (0.1 cm)
    const SYMMETRY_TOLERANCE = 0.1;
    const symmetricX = Math.abs(left - right) < SYMMETRY_TOLERANCE;
    const symmetricY = Math.abs(top - bottom) < SYMMETRY_TOLERANCE;

    this.dragDistances = {
      left, right, top, bottom,
      centerX, centerY,
      symmetricX, symmetricY
    };
  }

  get showGuidelines(): boolean {
    return this.isDragging;
  }

  isGuidelineActive(guideline: Guideline, axis: 'x' | 'y'): boolean {
    const active = axis === 'x' ? this.activeGuidelines.x : this.activeGuidelines.y;
    if (!active) return false;
    return active.position === guideline.position && active.type === guideline.type;
  }

  private persistSensors() {
    this.persistSubject.next();
  }

  private persistSensorsToServer() {
    const payload: DeviceSensorInfo[] = this.sensors.map(s => ({
      name: s.name,
      x_pct: s.x_pct,
      y_pct: s.y_pct,
      clearance_cm: s.clearance_cm
    }));

    this.http.updateDeviceSensors(payload).subscribe({
      next: info => {
        this.connectionInfo = info;
        this.deviceSensors = info.sensors ?? [];
      },
      error: () => {
        NotificationService.showError(
          this.translate.instant('ROBOT_SETTINGS.SENSOR_SAVE_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
      }
    });
  }

  private persistCentersToServer() {
    this.http.updateDeviceRotationCenter(this.rotationCenter ?? undefined).subscribe({
      next: info => {
        this.connectionInfo = info;
        this.rotationCenter = info.rotation_center ?? null;
        this.syncTableVisualizationRotationCenter(info, this.rotationCenter);
      },
      error: () => {
        NotificationService.showError(
          this.translate.instant('ROBOT_SETTINGS.CENTER_SAVE_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
      }
    });
  }

  // Robot preview - scale factor leaves room for measurement markings
  private readonly ROBOT_SCALE_FACTOR = 55;

  get robotScale() {
    const dims = this.getDisplayDimensions();
    if (!dims) return { widthPct: this.ROBOT_SCALE_FACTOR, heightPct: this.ROBOT_SCALE_FACTOR };
    const max = Math.max(dims.width, dims.length);
    return {
      widthPct: (dims.width / max) * this.ROBOT_SCALE_FACTOR,
      heightPct: (dims.length / max) * this.ROBOT_SCALE_FACTOR
    };
  }

  get robotWidthLabel(): string {
    const dims = this.getDisplayDimensions();
    return `${this.formatDimension(dims?.width)} cm`;
  }

  get robotLengthLabel(): string {
    const dims = this.getDisplayDimensions();
    return `${this.formatDimension(dims?.length)} cm`;
  }

  private getDisplayDimensions(): { width: number; length: number } | null {
    const w = this.connectionInfo?.width_cm;
    const l = this.connectionInfo?.length_cm;
    const fallback = this.vizService.robotConfig();
    const fallbackWidth = typeof fallback.widthCm === 'number' && fallback.widthCm > 0 ? fallback.widthCm : 15;
    const fallbackLength = typeof fallback.lengthCm === 'number' && fallback.lengthCm > 0 ? fallback.lengthCm : 22;
    const width = typeof w === 'number' && w > 0 ? w : fallbackWidth;
    const length = typeof l === 'number' && l > 0 ? l : fallbackLength;
    if (width <= 0 || length <= 0) return null;
    return { width, length };
  }

  getSensorMarkerStyle(sensor: Sensor): Record<string, string> {
    const style: Record<string, string> = { '--sensor-x': `${sensor.x_pct}%`, '--sensor-y': `${sensor.y_pct}%` };
    const clearance = this.getSensorClearanceDiameter(sensor);
    if (clearance) {
      style['--sensor-clear-x'] = `${clearance.x}%`;
      style['--sensor-clear-y'] = `${clearance.y}%`;
    }
    return style;
  }

  getSensorClearanceVisible(sensor: Sensor): boolean {
    return (sensor.clearance_cm ?? 0) > 0 && !!this.getSensorClearanceDiameter(sensor);
  }

  private getSensorClearanceDiameter(sensor: Sensor): { x: number; y: number } | null {
    if (sensor.clearance_cm === undefined) return null;
    const dims = this.getDisplayDimensions();
    if (!dims || dims.width === 0 || dims.length === 0) return null;
    return { x: (sensor.clearance_cm * 2 / dims.width) * 100, y: (sensor.clearance_cm * 2 / dims.length) * 100 };
  }

  // Rotation center getters (geometric is always at robot center - 50%, 50%)
  get rotationCenterXcm(): number | null {
    const dims = this.getDisplayDimensions();
    if (!dims || !this.rotationCenter) return null;
    return this.roundToTwo((dims.width * this.rotationCenter.x_pct) / 100);
  }

  get rotationCenterYcm(): number | null {
    const dims = this.getDisplayDimensions();
    if (!dims || !this.rotationCenter) return null;
    return this.roundToTwo(dims.length * (1 - this.rotationCenter.y_pct / 100));
  }

  setCenterCoordCm(center: 'rotation', axis: 'x' | 'y', value: number | null) {
    const dims = this.getDisplayDimensions();
    if (!dims) return;

    const parsed = value === null ? undefined : Number(value);
    const maxCm = axis === 'x' ? dims.width : dims.length;
    const clampedCm = parsed === undefined || Number.isNaN(parsed) ? undefined : Math.min(Math.max(parsed, 0), maxCm);
    if (clampedCm === undefined) return;

    const percent = maxCm === 0 ? 50 : axis === 'y' ? (1 - clampedCm / maxCm) * 100 : (clampedCm / maxCm) * 100;

    this.rotationCenter = {
      x_pct: axis === 'x' ? percent : (this.rotationCenter?.x_pct ?? 50),
      y_pct: axis === 'y' ? percent : (this.rotationCenter?.y_pct ?? 50)
    };
    this.syncTableVisualizationRotationCenter(this.connectionInfo, this.rotationCenter);
    this.persistCentersSubject.next();
  }

  getCenterMarkerStyle(center: CenterPoint | null): Record<string, string> {
    if (!center) return {};
    return { '--center-x': `${center.x_pct}%`, '--center-y': `${center.y_pct}%` };
  }

  get startPoseXcm(): number {
    return this.roundToTwo(this.vizService.startPose().x);
  }

  get startPoseYcm(): number {
    return this.roundToTwo(this.vizService.startPose().y);
  }

  get startPoseThetaDeg(): number {
    return this.roundToTwo(thetaToDegrees(this.vizService.startPose().theta));
  }

  setStartPoseXcm(value: number | null) {
    this.updateStartPose({ x: value });
  }

  setStartPoseYcm(value: number | null) {
    this.updateStartPose({ y: value });
  }

  setStartPoseThetaDeg(value: number | null) {
    this.updateStartPose({ thetaDeg: value });
  }

  onStartPosePicked(pose: Pose2D) {
    this.updateStartPose({
      x: pose.x,
      y: pose.y,
      thetaDeg: thetaToDegrees(pose.theta),
    });
  }

  private roundToTwo(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private updateStartPose(update: { x?: number | null; y?: number | null; thetaDeg?: number | null }) {
    const current = this.vizService.startPose();
    const config = this.mapService.config();
    const nextX = this.clampValue(this.coerceNumber(update.x, current.x), 0, config.widthCm);
    const nextY = this.clampValue(this.coerceNumber(update.y, current.y), 0, config.heightCm);
    const nextTheta = this.coerceNumber(update.thetaDeg, thetaToDegrees(current.theta));
    this.vizService.setStartPose(nextX, nextY, nextTheta);
    this.persistStartPoseSubject.next();
  }

  private coerceNumber(value: number | null | undefined, fallback: number): number {
    if (value === null || value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? fallback : parsed;
  }

  private clampValue(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  private persistStartPoseToServer() {
    const pose = this.vizService.startPose();
    this.http.updateDeviceStartPose({
      x_cm: pose.x,
      y_cm: pose.y,
      theta_deg: thetaToDegrees(pose.theta),
    }).subscribe({
      next: info => {
        this.connectionInfo = info;
      },
      error: () => {
        NotificationService.showError(
          this.translate.instant('ROBOT_SETTINGS.START_POSE_SAVE_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
      }
    });
  }

  // Layout settings
  readonly orientationOptions: { label: string; value: FlowOrientation }[] = [
    { label: '↕', value: 'vertical' },
    { label: '↔', value: 'horizontal' },
  ];

  get currentOrientation(): FlowOrientation {
    return this.orientation?.() ?? 'vertical';
  }

  onOrientationChange(value: FlowOrientation): void {
    this.orientationChange.emit(value);
  }

  onAutoLayoutChange(value: boolean): void {
    this.useAutoLayoutChange.emit(value);
  }
}
