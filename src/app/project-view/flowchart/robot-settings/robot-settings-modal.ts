import {
  AfterViewChecked,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnInit,
  Output,
  signal,
  SimpleChanges,
  ViewChild,
  WritableSignal
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {NgClass, NgStyle} from '@angular/common';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import { Button } from 'primeng/button';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {HttpService} from '../../../services/http-service';
import {NotificationService} from '../../../services/NotificationService';
import {KeybindingsService, StepKeybinding} from '../../../services/keybindings-service';
import {StepsStateService} from '../../../services/steps-state-service';
import {TypeDefinition} from '../../../entities/TypeDefinition';
import {Subject} from 'rxjs';
import {Step} from '../models';
import {debounceTime} from 'rxjs/operators';
import {TableEditorView} from '../table/table-editor-view';
import {TableVisualizationPanel} from '../table/table-visualization-panel';
import {TableMapService, TableVisualizationService} from '../table/services';
import {Pose2D, thetaToDegrees} from '../table/models';
import {FlowOrientation} from '../models';

type SettingsTab = 'project' | 'robot' | 'start' | 'map' | 'keybindings';
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

interface StepIndexStatus {
  status: string;
  count?: number;
  last_indexed_at?: string;
  error?: string;
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

interface WheelPosition {
  name: string;
  x_pct: number;
  y_pct: number;
}

@Component({
  selector: 'app-robot-settings-modal',
  standalone: true,
  imports: [FormsModule, NgClass, NgStyle, Dialog, InputText, Button, TranslateModule, TableEditorView, TableVisualizationPanel],
  templateUrl: './robot-settings-modal.html',
  styleUrl: './robot-settings-modal.scss'
})
export class RobotSettingsModal implements OnInit, OnChanges, AfterViewChecked {
  @Input() visible = false;
  @Input() projectUuid: string | null = null;
  @Input() typeDefinitions: TypeDefinition[] = [];
  @Input() orientation: WritableSignal<FlowOrientation> | null = null;
  @Input() useAutoLayout = false;
  @Input() set initialTab(tab: SettingsTab | null) {
    if (tab) {
      this.activeTab.set(tab);
    }
  }
  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() orientationChange = new EventEmitter<FlowOrientation>();
  @Output() useAutoLayoutChange = new EventEmitter<boolean>();

  readonly activeTab = signal<SettingsTab>('project');

  @ViewChild('robotBody') robotBodyRef!: ElementRef<HTMLDivElement>;
  @ViewChild('robotFrame') robotFrameRef!: ElementRef<HTMLDivElement>;
  @ViewChild('widthInput') widthInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('lengthInput') lengthInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('trackWidthInput') trackWidthInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('wheelbaseInput') wheelbaseInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('wheelRadiusInput') wheelRadiusInputRef?: ElementRef<HTMLInputElement>;

  connectionInfo: ConnectionInfo | undefined;
  loading = true;
  savingRobotConfig = false;
  stepIndexStatus?: StepIndexStatus;
  stepIndexLoading = false;
  stepIndexRefreshing = false;
  private stepIndexPoll?: ReturnType<typeof setTimeout>;

  // Dimensions - separate edit states
  tempWidth = '';
  tempLength = '';
  editingWidth = false;
  editingLength = false;
  private pendingFocus: 'width' | 'length' | 'trackWidth' | 'wheelbase' | 'wheelRadius' | null = null;

  // Sensors
  sensors: Sensor[] = [];
  private deviceSensors: DeviceSensorInfo[] = [];
  private readonly sensorPalette = ['#ef4444', '#f97316', '#f59e0b', '#22c55e', '#3b82f6', '#6366f1', '#ec4899'];

  // Center points (geometric is always 50%, 50% - the robot's center)
  rotationCenter: CenterPoint | null = null;

  // Kinematics info (editable)
  driveType: string | null = null;
  trackWidthM: number | null = null;
  wheelbaseM: number | null = null;
  wheelRadiusM: number | null = null;

  // Kinematics edit states
  tempTrackWidth = '';
  tempWheelbase = '';
  tempWheelRadius = '';
  editingTrackWidth = false;
  editingWheelbase = false;
  editingWheelRadius = false;

  // Edit target (sensor or center)
  editTarget: EditTarget = null;

  // Drag state
  private isDragging = false;
  private persistSubject = new Subject<void>();

  // Guidelines and snapping
  private readonly SNAP_THRESHOLD = 5; // percentage threshold for snapping
  private readonly GRID_SNAP_CM = 1; // snap to whole cm values
  private readonly GRID_SNAP_THRESHOLD_CM = 0.3; // threshold in cm for grid snapping
  activeGuidelines: ActiveGuidelines = {x: null, y: null};
  horizontalGuidelines: Guideline[] = [];
  verticalGuidelines: Guideline[] = [];
  dragDistances: DragDistances | null = null;
  snappedToGrid: { x: boolean; y: boolean } = {x: false, y: false};
  private persistCentersSubject = new Subject<void>();
  private persistStartPoseSubject = new Subject<void>();

  constructor(
    private http: HttpService,
    private translate: TranslateService,
    private vizService: TableVisualizationService,
    private mapService: TableMapService,
    public keybindingsService: KeybindingsService,
    private stepsStateService: StepsStateService
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
    this.loadStepIndexStatus();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['typeDefinitions'] && !changes['typeDefinitions'].firstChange) {
      this.syncSensorsFromDefinitions();
    }
    if (changes['visible'] && changes['visible'].currentValue) {
      this.loadDeviceInfo();
      this.loadStepIndexStatus();
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
    } else if (this.pendingFocus === 'trackWidth' && this.trackWidthInputRef) {
      this.trackWidthInputRef.nativeElement.focus();
      this.trackWidthInputRef.nativeElement.select();
      this.pendingFocus = null;
    } else if (this.pendingFocus === 'wheelbase' && this.wheelbaseInputRef) {
      this.wheelbaseInputRef.nativeElement.focus();
      this.wheelbaseInputRef.nativeElement.select();
      this.pendingFocus = null;
    } else if (this.pendingFocus === 'wheelRadius' && this.wheelRadiusInputRef) {
      this.wheelRadiusInputRef.nativeElement.focus();
      this.wheelRadiusInputRef.nativeElement.select();
      this.pendingFocus = null;
    }
  }

  private loadDeviceInfo() {
    this.loading = true;

    // Use local API directly (no Pi connection needed)
    if (this.projectUuid) {
      this.http.getLocalDeviceInfo(this.projectUuid).subscribe({
        next: info => this.handleDeviceInfoLoaded(info),
        error: () => {
          this.loading = false;
          this.syncSensorsFromDefinitions();
        }
      });
    } else {
      this.loading = false;
      this.syncSensorsFromDefinitions();
    }
  }

  private handleDeviceInfoLoaded(info: ConnectionInfo) {
    this.connectionInfo = info;
    this.tempWidth = this.toDimensionString(info.width_cm);
    this.tempLength = this.toDimensionString(info.length_cm);
    this.deviceSensors = info.sensors ?? [];
    // Kinematics info
    this.driveType = info.drive_type ?? null;
    this.trackWidthM = info.track_width_m ?? null;
    this.wheelbaseM = info.wheelbase_m ?? null;
    this.wheelRadiusM = info.wheel_radius_m ?? null;
    // Convert rotation center from API cm to display pct
    this.rotationCenter = this.apiRotationCenterToDisplay(info);
    this.syncTableVisualizationDimensions(info);
    this.syncTableVisualizationRotationCenter(info, this.rotationCenter);
    this.syncTableVisualizationStartPose(info);
    this.syncSensorsFromDefinitions();
    this.loading = false;
  }

  /**
   * Convert rotation center from API format (cm from lower-left) to display format (pct from upper-left).
   */
  private apiRotationCenterToDisplay(info: ConnectionInfo): CenterPoint | null {
    const rc = info.rotation_center;
    if (!rc) return null;
    const width = info.width_cm;
    const length = info.length_cm;
    if (!width || !length || width <= 0 || length <= 0) return null;
    return {
      x_pct: (rc.x_cm / width) * 100,
      y_pct: (1 - rc.y_cm / length) * 100
    };
  }

  /**
   * Convert rotation center from display format (pct) to API format (cm from lower-left).
   */
  private displayRotationCenterToApi(): DeviceCenterPoint | undefined {
    if (!this.rotationCenter) return undefined;
    const dims = this.getDisplayDimensions();
    if (!dims) return undefined;
    return {
      x_cm: (this.rotationCenter.x_pct / 100) * dims.width,
      y_cm: (1 - this.rotationCenter.y_pct / 100) * dims.length
    };
  }

  private loadStepIndexStatus() {
    if (this.stepIndexPoll) {
      clearTimeout(this.stepIndexPoll);
      this.stepIndexPoll = undefined;
    }
    this.stepIndexLoading = true;
    const wasIndexing = this.stepIndexStatus?.status === 'indexing';
    this.http.getStepIndexStatus().subscribe({
      next: status => {
        this.stepIndexStatus = status;
        this.stepIndexLoading = false;
        if (status.status === 'indexing') {
          this.stepIndexPoll = setTimeout(() => this.loadStepIndexStatus(), 2000);
        } else if (wasIndexing && status.status === 'ready') {
          // Indexing just finished - trigger step panel refresh
          this.stepsStateService.triggerRefresh();
        }
      },
      error: () => {
        this.stepIndexLoading = false;
      }
    });
  }

  refreshStepIndex(forceClear: boolean = false) {
    this.stepIndexRefreshing = true;
    // Mark current status as indexing so the polling logic knows to trigger refresh when done
    if (this.stepIndexStatus) {
      this.stepIndexStatus = { ...this.stepIndexStatus, status: 'indexing' };
    }
    this.http.refreshStepIndex(forceClear).subscribe({
      next: status => {
        this.stepIndexStatus = status;
        this.stepIndexRefreshing = false;
        if (status.status === 'indexing') {
          this.loadStepIndexStatus();
        } else if (status.status === 'ready') {
          // Indexing completed immediately (rare but possible)
          this.stepsStateService.triggerRefresh();
        }
      },
      error: () => {
        this.stepIndexRefreshing = false;
      }
    });
  }

  clearStepIndexCache() {
    this.stepIndexRefreshing = true;
    this.http.clearStepIndex().subscribe({
      next: status => {
        this.stepIndexStatus = status;
        this.stepIndexRefreshing = false;
        // Trigger refresh to show empty state in step panel
        this.stepsStateService.triggerRefresh();
      },
      error: () => {
        this.stepIndexRefreshing = false;
      }
    });
  }

  getStepIndexStatusLabel() {
    if (!this.stepIndexStatus) return this.translate.instant('STEP_INDEX.STATUS_UNKNOWN');
    switch (this.stepIndexStatus.status) {
      case 'indexing':
        return this.translate.instant('STEP_INDEX.STATUS_INDEXING');
      case 'ready':
        return this.translate.instant('STEP_INDEX.STATUS_READY');
      case 'error':
        return this.translate.instant('STEP_INDEX.STATUS_ERROR');
      default:
        return this.translate.instant('STEP_INDEX.STATUS_EMPTY');
    }
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

    // Use local API directly
    if (this.projectUuid) {
      this.http.updateLocalDeviceDimensions(this.projectUuid, newWidth, newLength).subscribe({
        next: info => this.handleDimensionsSaved(info),
        error: () => this.showSaveError()
      });
    } else {
      this.showSaveError();
    }
  }

  private handleDimensionsSaved(info: ConnectionInfo) {
    this.connectionInfo = info;
    this.tempWidth = this.toDimensionString(info.width_cm);
    this.tempLength = this.toDimensionString(info.length_cm);
    this.syncTableVisualizationDimensions(info);
    this.syncTableVisualizationRotationCenter(info, this.rotationCenter);
    this.clampClearancesToDimensions();
  }

  private showSaveError() {
    NotificationService.showError(
      this.translate.instant('ROBOT_SETTINGS.SAVE_ERROR'),
      this.translate.instant('COMMON.ERROR')
    );
  }

  /**
   * Save all robot physical configuration (dimensions, sensors, rotation center) at once.
   */
  saveRobotConfig() {
    if (!this.projectUuid) {
      this.showSaveError();
      return;
    }

    this.savingRobotConfig = true;

    const dims = this.getDisplayDimensions();
    const width = dims?.width ?? 0;
    const length = dims?.length ?? 0;

    // Build sensors payload - convert from display pct to API cm
    const sensorsPayload: DeviceSensorInfo[] = this.sensors.map(s => {
      const { x_cm, y_cm } = this.displayPctToCm(s.x_pct, s.y_pct);
      return {
        name: s.name,
        x_cm,
        y_cm,
        clearance_cm: s.clearance_cm
      };
    });

    // Save dimensions first, then sensors, then rotation center
    const saveDimensions = () => {
      if (width > 0 && length > 0) {
        return this.http.updateLocalDeviceDimensions(this.projectUuid!, width, length).toPromise();
      }
      return Promise.resolve(null);
    };

    const saveSensors = () => {
      return this.http.updateLocalDeviceSensors(this.projectUuid!, sensorsPayload).toPromise();
    };

    const saveRotationCenter = () => {
      // Convert from display pct to API cm
      const apiRotationCenter = this.displayRotationCenterToApi();
      return this.http.updateLocalDeviceRotationCenter(this.projectUuid!, apiRotationCenter).toPromise();
    };

    saveDimensions()
      .then(() => saveSensors())
      .then(() => saveRotationCenter())
      .then((info) => {
        this.savingRobotConfig = false;
        if (info) {
          this.connectionInfo = info;
        }
        NotificationService.showSuccess(
          this.translate.instant('ROBOT_SETTINGS.SAVE_SUCCESS'),
          this.translate.instant('COMMON.SUCCESS')
        );
      })
      .catch(() => {
        this.savingRobotConfig = false;
        this.showSaveError();
      });
  }

  private clampClearancesToDimensions() {
    const maxClearance = this.sensorMaxClearanceCm;
    if (maxClearance === null) return;

    let needsPersist = false;
    this.sensors = this.sensors.map(sensor => {
      if (sensor.clearance_cm !== undefined && sensor.clearance_cm > maxClearance) {
        needsPersist = true;
        return {...sensor, clearance_cm: maxClearance};
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

  // Coordinate conversion: API stores cm from lower-left, display uses pct from upper-left
  private cmToDisplayPct(x_cm: number | undefined, y_cm: number | undefined): { x_pct?: number; y_pct?: number } {
    const dims = this.getDisplayDimensions();
    if (!dims || x_cm === undefined || y_cm === undefined) {
      return { x_pct: undefined, y_pct: undefined };
    }
    return {
      x_pct: (x_cm / dims.width) * 100,
      y_pct: (1 - y_cm / dims.length) * 100  // Flip Y: API has 0=back, display has 0=front
    };
  }

  private displayPctToCm(x_pct: number | undefined, y_pct: number | undefined): { x_cm?: number; y_cm?: number } {
    const dims = this.getDisplayDimensions();
    if (!dims || x_pct === undefined || y_pct === undefined) {
      return { x_cm: undefined, y_cm: undefined };
    }
    return {
      x_cm: (x_pct / 100) * dims.width,
      y_cm: (1 - y_pct / 100) * dims.length  // Flip Y: display has 0=front, API has 0=back
    };
  }

  // Sensors
  private syncSensorsFromDefinitions() {
    const irSensorDefs = this.typeDefinitions.filter(d => d.type === 'IRSensor');
    const sensorLookup = new Map(this.deviceSensors.map(s => [s.name, s]));

    this.sensors = irSensorDefs.map((def, index) => {
      const stored = sensorLookup.get(def.name);
      // Convert from API cm to display pct
      const { x_pct, y_pct } = this.cmToDisplayPct(stored?.x_cm, stored?.y_cm);
      return {
        id: index + 1,
        name: def.name,
        color: this.sensorPalette[index % this.sensorPalette.length],
        x_pct,
        y_pct,
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
      this.editTarget = {type: 'sensor', id: sensorId};
    }
  }

  selectRotationCenter() {
    this.editTarget = this.editTarget?.type === 'rotation' ? null : {type: 'rotation'};
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
    // Allow values outside robot dimensions (sensors can be placed outside the body)
    const cm = parsed === undefined || Number.isNaN(parsed) ? undefined : parsed;
    const maxCm = axis === 'x' ? dims.width : dims.length;
    const percent = cm === undefined || maxCm === 0
      ? undefined
      : axis === 'y' ? (1 - cm / maxCm) * 100 : (cm / maxCm) * 100;

    this.sensors = this.sensors.map(sensor => {
      if (sensor.id !== this.selectedSensorId) return sensor;
      return {...sensor, x_pct: axis === 'x' ? percent : sensor.x_pct, y_pct: axis === 'y' ? percent : sensor.y_pct};
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
      return {...sensor, clearance_cm: clamped};
    });
    this.persistSensors();
  }

  get sensorMaxClearanceCm(): number | null {
    const dims = this.getDisplayDimensions();
    return dims ? Math.min(dims.width, dims.length) / 2 : null;
  }

  // Hit-testing threshold in percentage (how close click must be to select an element)
  private readonly HIT_TEST_THRESHOLD = 12;

  // Bound listeners for document-level drag tracking
  private boundDocMouseMove = (e: MouseEvent) => this.onDocumentMouseMove(e);
  private boundDocMouseUp = () => this.onDocumentMouseUp();

  // Mouse events for live drag placement
  onRobotMouseDown(event: MouseEvent) {
    // Don't interfere with interactive elements (dimension labels, inputs)
    const clickedEl = event.target as HTMLElement;
    if (clickedEl.closest('button, input, .robot-measure-label')) return;

    event.preventDefault();

    // Calculate click position as percentage relative to robot body
    const bodyEl = this.robotBodyRef?.nativeElement;
    if (!bodyEl) return;
    const rect = bodyEl.getBoundingClientRect();
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

    // Listen on document so drag continues when mouse leaves the robot area
    document.addEventListener('mousemove', this.boundDocMouseMove);
    document.addEventListener('mouseup', this.boundDocMouseUp);
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
        closestElement = {type: 'sensor', id: sensor.id};
      }
    }

    // Check rotation center
    if (this.rotationCenter) {
      const dist = Math.hypot(this.rotationCenter.x_pct - clickX, this.rotationCenter.y_pct - clickY);
      if (dist < closestDistance) {
        closestDistance = dist;
        closestElement = {type: 'rotation'};
      }
    }

    return closestElement;
  }

  onRobotMouseMove(event: MouseEvent) {
    if (!this.isDragging || !this.editTarget) return;
    event.preventDefault();
    this.updateTargetPosition(event);
  }

  private onDocumentMouseMove(event: MouseEvent) {
    if (!this.isDragging || !this.editTarget) return;
    event.preventDefault();
    this.updateTargetPosition(event);
  }

  private onDocumentMouseUp() {
    this.finishDrag();
  }

  onRobotMouseUp() {
    this.finishDrag();
  }

  private finishDrag() {
    if (this.isDragging) {
      this.isDragging = false;
      this.clearGuidelines();
      document.removeEventListener('mousemove', this.boundDocMouseMove);
      document.removeEventListener('mouseup', this.boundDocMouseUp);
      // Final persist on mouse up
      if (this.editTarget?.type === 'sensor') {
        this.persistSensorsToServer();
      } else if (this.editTarget?.type === 'rotation') {
        this.persistCentersToServer();
      }
    }
  }

  private updateTargetPosition(event: MouseEvent) {
    // Always calculate position relative to the robot body, even when mouse is outside it
    const bodyEl = this.robotBodyRef?.nativeElement;
    if (!bodyEl) return;
    const rect = bodyEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    // Allow values outside 0-100% so sensors can be placed outside the robot body
    let x = ((event.clientX - rect.left) / rect.width) * 100;
    let y = ((event.clientY - rect.top) / rect.height) * 100;

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
        return {...sensor, x_pct: x, y_pct: y};
      });
      this.syncTableVisualizationSensors();
      this.persistSubject.next();
    } else if (this.editTarget?.type === 'rotation') {
      this.rotationCenter = {x_pct: x, y_pct: y};
      this.syncTableVisualizationRotationCenter(this.connectionInfo, this.rotationCenter);
      this.persistCentersSubject.next();
    }
  }

  // Guidelines and snapping
  private computeGuidelines() {
    const horizontal: Guideline[] = [];
    const vertical: Guideline[] = [];

    // Center guidelines (always present)
    horizontal.push({position: 50, type: 'center'});
    vertical.push({position: 50, type: 'center'});

    // Edge guidelines
    horizontal.push({position: 0, type: 'edge'});
    horizontal.push({position: 100, type: 'edge'});
    vertical.push({position: 0, type: 'edge'});
    vertical.push({position: 100, type: 'edge'});

    // Guidelines from other sensors (excluding the one being dragged)
    const editingSensorId = this.editTarget?.type === 'sensor' ? this.editTarget.id : null;
    for (const sensor of this.sensors) {
      if (sensor.id === editingSensorId) continue;
      if (sensor.x_pct !== undefined) {
        vertical.push({position: sensor.x_pct, type: 'sensor', sourceId: sensor.id});
      }
      if (sensor.y_pct !== undefined) {
        horizontal.push({position: sensor.y_pct, type: 'sensor', sourceId: sensor.id});
      }
    }

    // Guidelines from rotation center (if not editing it)
    if (this.editTarget?.type !== 'rotation' && this.rotationCenter) {
      vertical.push({position: this.rotationCenter.x_pct, type: 'rotation'});
      horizontal.push({position: this.rotationCenter.y_pct, type: 'rotation'});
    }

    this.horizontalGuidelines = horizontal;
    this.verticalGuidelines = vertical;
  }

  private applySnapping(x: number, y: number): { x: number; y: number } {
    this.activeGuidelines = {x: null, y: null};
    this.snappedToGrid = {x: false, y: false};

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

    return {x, y};
  }

  private clearGuidelines() {
    this.activeGuidelines = {x: null, y: null};
    this.horizontalGuidelines = [];
    this.verticalGuidelines = [];
    this.dragDistances = null;
    this.snappedToGrid = {x: false, y: false};
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
    // Convert from display pct to API cm
    const payload: DeviceSensorInfo[] = this.sensors.map(s => {
      const { x_cm, y_cm } = this.displayPctToCm(s.x_pct, s.y_pct);
      return {
        name: s.name,
        x_cm,
        y_cm,
        clearance_cm: s.clearance_cm
      };
    });

    // Use local API directly
    if (this.projectUuid) {
      this.http.updateLocalDeviceSensors(this.projectUuid, payload).subscribe({
        next: info => this.handleSensorsSaved(info),
        error: () => this.showSensorSaveError()
      });
    } else {
      this.showSensorSaveError();
    }
  }

  private handleSensorsSaved(info: ConnectionInfo) {
    this.connectionInfo = info;
    this.deviceSensors = info.sensors ?? [];
  }

  private showSensorSaveError() {
    NotificationService.showError(
      this.translate.instant('ROBOT_SETTINGS.SENSOR_SAVE_ERROR'),
      this.translate.instant('COMMON.ERROR')
    );
  }

  private persistCentersToServer() {
    // Use local API directly - convert from display pct to API cm
    if (this.projectUuid) {
      const apiRotationCenter = this.displayRotationCenterToApi();
      this.http.updateLocalDeviceRotationCenter(this.projectUuid, apiRotationCenter).subscribe({
        next: info => this.handleCentersSaved(info),
        error: () => this.showCenterSaveError()
      });
    } else {
      this.showCenterSaveError();
    }
  }

  private handleCentersSaved(info: ConnectionInfo) {
    this.connectionInfo = info;
    // Convert from API cm to display pct
    this.rotationCenter = this.apiRotationCenterToDisplay(info);
    this.syncTableVisualizationRotationCenter(info, this.rotationCenter);
  }

  private showCenterSaveError() {
    NotificationService.showError(
      this.translate.instant('ROBOT_SETTINGS.CENTER_SAVE_ERROR'),
      this.translate.instant('COMMON.ERROR')
    );
  }

  // Robot preview - scale factor leaves room for measurement markings and out-of-body sensor placement
  private readonly ROBOT_SCALE_FACTOR = 50;

  get robotScale() {
    const dims = this.getDisplayDimensions();
    if (!dims) return {widthPct: this.ROBOT_SCALE_FACTOR, heightPct: this.ROBOT_SCALE_FACTOR};
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

  /**
   * Calculate wheel positions based on kinematics configuration.
   * Wheels are positioned relative to the rotation center (not geometric center).
   * Returns positions as percentages for visualization.
   */
  get wheelPositions(): WheelPosition[] {
    const dims = this.getDisplayDimensions();
    if (!dims || !this.driveType || this.trackWidthM === null) {
      return [];
    }

    const trackWidthCm = this.trackWidthM * 100;
    const wheelbaseCm = (this.wheelbaseM ?? 0) * 100;

    // Use rotation center as origin, default to geometric center (50%, 50%)
    const centerXpct = this.rotationCenter?.x_pct ?? 50;
    const centerYpct = this.rotationCenter?.y_pct ?? 50;

    // Convert cm offsets to percentages relative to rotation center
    const strafe2pct = (strafeCm: number) => centerXpct - (strafeCm / dims.width) * 100;
    const forward2pct = (forwardCm: number) => centerYpct - (forwardCm / dims.length) * 100;

    const positions: WheelPosition[] = [];
    const driveTypeLower = this.driveType.toLowerCase();

    if (driveTypeLower === 'mecanum') {
      if (wheelbaseCm <= 0) return [];

      const forwardOffset = wheelbaseCm / 2;
      const strafeOffset = trackWidthCm / 2;

      positions.push(
        { name: 'FL', x_pct: strafe2pct(strafeOffset), y_pct: forward2pct(forwardOffset) },
        { name: 'FR', x_pct: strafe2pct(-strafeOffset), y_pct: forward2pct(forwardOffset) },
        { name: 'BL', x_pct: strafe2pct(strafeOffset), y_pct: forward2pct(-forwardOffset) },
        { name: 'BR', x_pct: strafe2pct(-strafeOffset), y_pct: forward2pct(-forwardOffset) }
      );
    } else if (['differential', 'tank', 'two_wheel'].includes(driveTypeLower)) {
      const strafeOffset = trackWidthCm / 2;

      positions.push(
        { name: 'L', x_pct: strafe2pct(strafeOffset), y_pct: centerYpct },
        { name: 'R', x_pct: strafe2pct(-strafeOffset), y_pct: centerYpct }
      );
    }

    return positions;
  }

  /**
   * Get display-friendly drive type label.
   */
  get driveTypeLabel(): string {
    if (!this.driveType) return '';
    const type = this.driveType.toLowerCase();
    const labels: Record<string, string> = {
      'mecanum': 'Mecanum',
      'differential': 'Differential',
      'tank': 'Tank',
      'two_wheel': 'Two-Wheel'
    };
    return labels[type] ?? this.driveType;
  }

  /**
   * Check if current drive type is mecanum.
   */
  get isMecanumDrive(): boolean {
    return this.driveType?.toLowerCase() === 'mecanum';
  }

  /**
   * Get track width display in cm.
   */
  get trackWidthCm(): number | null {
    return this.trackWidthM !== null ? this.roundToTwo(this.trackWidthM * 100) : null;
  }

  /**
   * Get wheelbase display in cm.
   */
  get wheelbaseCm(): number | null {
    return this.wheelbaseM !== null ? this.roundToTwo(this.wheelbaseM * 100) : null;
  }

  /**
   * Get wheel radius display in cm.
   */
  get wheelRadiusCm(): number | null {
    return this.wheelRadiusM !== null ? this.roundToTwo(this.wheelRadiusM * 100) : null;
  }

  // Track width editing
  startEditTrackWidth() {
    this.tempTrackWidth = this.trackWidthCm?.toString() ?? '';
    this.editingTrackWidth = true;
    this.pendingFocus = 'trackWidth';
  }

  cancelTrackWidthEdit() {
    this.editingTrackWidth = false;
    this.tempTrackWidth = this.trackWidthCm?.toString() ?? '';
  }

  onTrackWidthBlur() {
    setTimeout(() => {
      if (this.editingTrackWidth) {
        this.saveTrackWidth();
      }
    }, 100);
  }

  saveTrackWidth() {
    const newValueCm = this.parseDimension(this.tempTrackWidth);
    if (newValueCm === undefined || newValueCm <= 0) {
      this.cancelTrackWidthEdit();
      return;
    }
    this.editingTrackWidth = false;
    this.trackWidthM = newValueCm / 100;
    // Persist to YAML via local API
    this.persistKinematicsToServer();
  }

  // Wheelbase editing
  startEditWheelbase() {
    this.tempWheelbase = this.wheelbaseCm?.toString() ?? '';
    this.editingWheelbase = true;
    this.pendingFocus = 'wheelbase';
  }

  cancelWheelbaseEdit() {
    this.editingWheelbase = false;
    this.tempWheelbase = this.wheelbaseCm?.toString() ?? '';
  }

  onWheelbaseBlur() {
    setTimeout(() => {
      if (this.editingWheelbase) {
        this.saveWheelbase();
      }
    }, 100);
  }

  saveWheelbase() {
    const newValueCm = this.parseDimension(this.tempWheelbase);
    if (newValueCm === undefined || newValueCm <= 0) {
      this.cancelWheelbaseEdit();
      return;
    }
    this.editingWheelbase = false;
    this.wheelbaseM = newValueCm / 100;
    this.persistKinematicsToServer();
  }

  // Wheel radius editing
  startEditWheelRadius() {
    this.tempWheelRadius = this.wheelRadiusCm?.toString() ?? '';
    this.editingWheelRadius = true;
    this.pendingFocus = 'wheelRadius';
  }

  cancelWheelRadiusEdit() {
    this.editingWheelRadius = false;
    this.tempWheelRadius = this.wheelRadiusCm?.toString() ?? '';
  }

  onWheelRadiusBlur() {
    setTimeout(() => {
      if (this.editingWheelRadius) {
        this.saveWheelRadius();
      }
    }, 100);
  }

  saveWheelRadius() {
    const newValueCm = this.parseDimension(this.tempWheelRadius);
    if (newValueCm === undefined || newValueCm <= 0) {
      this.cancelWheelRadiusEdit();
      return;
    }
    this.editingWheelRadius = false;
    this.wheelRadiusM = newValueCm / 100;
    this.persistKinematicsToServer();
  }

  private persistKinematicsToServer() {
    if (!this.projectUuid) return;
    this.http.updateLocalDeviceKinematics(this.projectUuid, {
      track_width_m: this.trackWidthM ?? undefined,
      wheelbase_m: this.wheelbaseM ?? undefined,
      wheel_radius_m: this.wheelRadiusM ?? undefined,
    }).subscribe({
      error: () => this.showSaveError()
    });
  }

  getWheelMarkerStyle(wheel: WheelPosition): Record<string, string> {
    const style: Record<string, string> = {
      '--wheel-x': `${wheel.x_pct}%`,
      '--wheel-y': `${wheel.y_pct}%`
    };

    // Size wheels based on radius if available
    const dims = this.getDisplayDimensions();
    if (dims && this.wheelRadiusM !== null) {
      const wheelDiameterCm = this.wheelRadiusM * 2 * 100;
      // Wheel height (diameter) as percentage of robot length
      const heightPct = (wheelDiameterCm / dims.length) * 100;
      // Wheel width is typically ~40% of diameter for standard wheels
      const widthPct = (wheelDiameterCm * 0.4 / dims.width) * 100;
      style['--wheel-height'] = `${heightPct}%`;
      style['--wheel-width'] = `${widthPct}%`;
    }

    return style;
  }

  /**
   * Get CSS class for wheel rectangle based on position.
   */
  getWheelRectClass(wheel: WheelPosition): string {
    if (this.isMecanumDrive) {
      // Mecanum wheels are all the same
      return 'wheel-rect-mecanum';
    }
    // Differential wheels
    return 'wheel-rect-diff';
  }

  /**
   * Get CSS class for mecanum wheel roller line direction.
   * FL and BR rollers go one way, FR and BL go the other.
   */
  getWheelRollerClass(wheel: WheelPosition): string {
    if (wheel.name === 'FL' || wheel.name === 'BR') {
      return 'wheel-roller-left';
    }
    return 'wheel-roller-right';
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
    return {width, length};
  }

  getSensorMarkerStyle(sensor: Sensor): Record<string, string> {
    const style: Record<string, string> = {'--sensor-x': `${sensor.x_pct}%`, '--sensor-y': `${sensor.y_pct}%`};
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
    return {x: (sensor.clearance_cm * 2 / dims.width) * 100, y: (sensor.clearance_cm * 2 / dims.length) * 100};
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
    return {'--center-x': `${center.x_pct}%`, '--center-y': `${center.y_pct}%`};
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
    this.updateStartPose({x: value});
  }

  setStartPoseYcm(value: number | null) {
    this.updateStartPose({y: value});
  }

  setStartPoseThetaDeg(value: number | null) {
    this.updateStartPose({thetaDeg: value});
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
    const payload = {
      x_cm: pose.x,
      y_cm: pose.y,
      theta_deg: thetaToDegrees(pose.theta),
    };

    // Use local API directly
    if (this.projectUuid) {
      this.http.updateLocalDeviceStartPose(this.projectUuid, payload).subscribe({
        next: info => this.handleStartPoseSaved(info),
        error: () => this.showStartPoseSaveError()
      });
    } else {
      this.showStartPoseSaveError();
    }
  }

  private handleStartPoseSaved(info: ConnectionInfo) {
    this.connectionInfo = info;
  }

  private showStartPoseSaveError() {
    NotificationService.showError(
      this.translate.instant('ROBOT_SETTINGS.START_POSE_SAVE_ERROR'),
      this.translate.instant('COMMON.ERROR')
    );
  }

  // Layout settings
  readonly orientationOptions: { label: string; value: FlowOrientation }[] = [
    {label: '↕', value: 'vertical'},
    {label: '↔', value: 'horizontal'},
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

  // Keybindings
  readonly recordingFor = signal<Step | null>(null);
  readonly recordedKey = signal<string | null>(null);
  readonly keybindingsSubTab = signal<'recent' | 'all' | 'bindings'>('recent');
  keybindingFilter = '';

  get recentSteps() {
    return this.keybindingsService.recentSteps();
  }

  get keybindings() {
    return this.keybindingsService.stepKeybindings();
  }

  filteredStepsForKeybindings(): Step[] {
    const steps = this.stepsStateService.currentSteps() ?? [];
    if (!this.keybindingFilter.trim()) {
      return steps;
    }
    const filter = this.keybindingFilter.toLowerCase();
    return steps.filter(s => s.name.toLowerCase().includes(filter));
  }

  getKeybindingForStep(step: Step): string | null {
    return this.keybindingsService.getKeybindingForStep(step);
  }

  formatKeybinding(keybind: string): string {
    return this.keybindingsService.formatKeybinding(keybind);
  }

  startRecordingKeybinding(step: Step): void {
    this.recordingFor.set(step);
    this.recordedKey.set(null);
  }

  cancelRecording(): void {
    this.recordingFor.set(null);
    this.recordedKey.set(null);
  }

  @HostListener('window:keydown', ['$event'])
  onKeyDownForRecording(event: KeyboardEvent): void {
    if (!this.recordingFor()) return;

    event.preventDefault();
    event.stopPropagation();

    // Ignore single modifier keys
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
      return;
    }

    // Escape cancels recording
    if (event.key === 'Escape') {
      this.cancelRecording();
      return;
    }

    const keybind = this.keybindingsService.parseKeyEvent(event);

    // Require at least one modifier for non-function keys
    const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
    const isFunctionKey = event.key.startsWith('F') && event.key.length <= 3;

    if (!hasModifier && !isFunctionKey) {
      return;
    }

    this.recordedKey.set(keybind);
  }

  saveRecordedKeybinding(): void {
    const step = this.recordingFor();
    const keybind = this.recordedKey();
    if (step && keybind) {
      this.keybindingsService.setStepKeybinding(step, keybind);
    }
    this.cancelRecording();
  }

  removeKeybinding(step: Step): void {
    this.keybindingsService.removeStepKeybinding(step);
  }

  removeKeybindingByBinding(binding: StepKeybinding): void {
    const steps = this.stepsStateService.currentSteps() ?? [];
    const step = steps.find(
      s => s.name === binding.stepName &&
           (s.import ?? null) === binding.stepImport &&
           s.file === binding.stepFile
    );
    if (step) {
      this.keybindingsService.removeStepKeybinding(step);
    } else {
      this.keybindingsService.setStepKeybinding({
        name: binding.stepName,
        import: binding.stepImport,
        file: binding.stepFile,
        arguments: []
      }, '');
    }
  }

  clearAllKeybindings(): void {
    this.keybindingsService.clearAllKeybindings();
  }
}
