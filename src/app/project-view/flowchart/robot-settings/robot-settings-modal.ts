import { Component, ElementRef, EventEmitter, Input, OnChanges, OnInit, Output, signal, SimpleChanges, ViewChild, AfterViewChecked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgClass, NgStyle } from '@angular/common';
import { Dialog } from 'primeng/dialog';
import { InputText } from 'primeng/inputtext';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { HttpService } from '../../../services/http-service';
import { NotificationService } from '../../../services/NotificationService';
import { TypeDefinition } from '../../../entities/TypeDefinition';
import { Subject } from 'rxjs';
import { debounceTime } from 'rxjs/operators';
import { TableEditorView } from '../table/table-editor-view';
import { TableVisualizationService } from '../table/services';

type SettingsTab = 'robot' | 'map';
type EditTarget = { type: 'sensor'; id: number } | { type: 'rotation' } | null;

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
  imports: [FormsModule, NgClass, NgStyle, Dialog, InputText, TranslateModule, TableEditorView],
  templateUrl: './robot-settings-modal.html',
  styleUrl: './robot-settings-modal.scss'
})
export class RobotSettingsModal implements OnInit, OnChanges, AfterViewChecked {
  @Input() visible = false;
  @Input() projectUuid: string | null = null;
  @Input() typeDefinitions: TypeDefinition[] = [];
  @Output() visibleChange = new EventEmitter<boolean>();

  readonly activeTab = signal<SettingsTab>('robot');

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
  private persistCentersSubject = new Subject<void>();

  constructor(
    private http: HttpService,
    private translate: TranslateService,
    private vizService: TableVisualizationService
  ) {
    // Debounce persistence during drag
    this.persistSubject.pipe(debounceTime(300)).subscribe(() => {
      this.persistSensorsToServer();
    });
    this.persistCentersSubject.pipe(debounceTime(300)).subscribe(() => {
      this.persistCentersToServer();
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
    if (dimension === 'width') {
      this.tempWidth = this.toDimensionString(this.connectionInfo?.width_cm);
      this.editingWidth = true;
      this.pendingFocus = 'width';
    } else {
      this.tempLength = this.toDimensionString(this.connectionInfo?.length_cm);
      this.editingLength = true;
      this.pendingFocus = 'length';
    }
  }

  cancelDimensionEdit(dimension: 'width' | 'length') {
    if (dimension === 'width') {
      this.editingWidth = false;
      this.tempWidth = this.toDimensionString(this.connectionInfo?.width_cm);
    } else {
      this.editingLength = false;
      this.tempLength = this.toDimensionString(this.connectionInfo?.length_cm);
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
    const newWidth = dimension === 'width'
      ? this.parseDimension(this.tempWidth)
      : this.connectionInfo?.width_cm;
    const newLength = dimension === 'length'
      ? this.parseDimension(this.tempLength)
      : this.connectionInfo?.length_cm;

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

  // Mouse events for live drag placement
  onRobotMouseDown(event: MouseEvent) {
    if (!this.editTarget) return;
    event.preventDefault();
    this.isDragging = true;
    this.updateTargetPosition(event);
  }

  onRobotMouseMove(event: MouseEvent) {
    if (!this.isDragging || !this.editTarget) return;
    event.preventDefault();
    this.updateTargetPosition(event);
  }

  onRobotMouseUp() {
    if (this.isDragging) {
      this.isDragging = false;
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

    const x = Math.min(Math.max(((event.clientX - rect.left) / rect.width) * 100, 0), 100);
    const y = Math.min(Math.max(((event.clientY - rect.top) / rect.height) * 100, 0), 100);

    if (this.editTarget?.type === 'sensor') {
      const targetId = this.editTarget.id;
      this.sensors = this.sensors.map(sensor => {
        if (sensor.id !== targetId) return sensor;
        return { ...sensor, x_pct: x, y_pct: y };
      });
      this.persistSubject.next();
    } else if (this.editTarget?.type === 'rotation') {
      this.rotationCenter = { x_pct: x, y_pct: y };
      this.persistCentersSubject.next();
    }
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
      },
      error: () => {
        NotificationService.showError(
          this.translate.instant('ROBOT_SETTINGS.CENTER_SAVE_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
      }
    });
  }

  // Robot preview
  get robotScale() {
    const dims = this.getDisplayDimensions();
    if (!dims) return { widthPct: 70, heightPct: 70 };
    const max = Math.max(dims.width, dims.length);
    return { widthPct: (dims.width / max) * 100, heightPct: (dims.length / max) * 100 };
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
    if (w === undefined || l === undefined || w <= 0 || l <= 0) return null;
    return { width: w, length: l };
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
    this.persistCentersSubject.next();
  }

  getCenterMarkerStyle(center: CenterPoint | null): Record<string, string> {
    if (!center) return {};
    return { '--center-x': `${center.x_pct}%`, '--center-y': `${center.y_pct}%` };
  }

  private roundToTwo(value: number): number {
    return Math.round(value * 100) / 100;
  }
}
