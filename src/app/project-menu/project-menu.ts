import { Component, OnInit } from '@angular/core';
import {ActivatedRoute, Router} from '@angular/router';
import { HttpService } from '../services/http-service';
import { FormsModule } from '@angular/forms';
import { InputText } from 'primeng/inputtext';
import { Button } from 'primeng/button';
import { NotificationService } from '../services/NotificationService';
import { Card } from 'primeng/card';
import { ConfirmDialog } from 'primeng/confirmdialog';
import { ConfirmationService } from 'primeng/api';
import {NgClass, NgStyle} from '@angular/common';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { decodeRouteIp, encodeRouteIp } from '../services/route-ip-serializer';
import { UnityWebglService } from '../project-view/flowchart/unity/unity-webgl.service';
import { TypeDefinition } from '../entities/TypeDefinition';

interface Sensor {
  id: number;
  name: string;
  color: string;
  x_pct?: number;
  y_pct?: number;
  clearance_cm?: number;
}

@Component({
  selector: 'app-project-menu',
  standalone: true,
  imports: [FormsModule, InputText, Button, Card, ConfirmDialog, NgClass, NgStyle, TranslateModule],
  templateUrl: './project-menu.html',
  styleUrl: './project-menu.scss',
  providers: [ConfirmationService] // required for PrimeNG
})
export class ProjectMenu implements OnInit {
  connectionInfo: ConnectionInfo | undefined;
  tempName: string = ""
  editingName = false;

  tempWidth: string = "";
  tempLength: string = "";
  editingDimensions = false;

  projects: Project[] = [];
  sensors: Sensor[] = [];
  selectedSensorId: number | null = null;
  sensorProjectUuid: string | null = null;
  private deviceSensors: DeviceSensorInfo[] = [];
  private sensorDefinitions: TypeDefinition[] = [];
  private readonly sensorPalette = ['#ef4444', '#f97316', '#f59e0b', '#22c55e', '#3b82f6', '#6366f1', '#ec4899'];

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private http: HttpService,
    private confirmationService: ConfirmationService,
    private translate: TranslateService,
    private unity: UnityWebglService
  ) {
    const ipParam = this.route.snapshot.paramMap.get('ip');
    const decodedIp = decodeRouteIp(ipParam);
    if (decodedIp) {
      this.http.setIp(decodedIp);
    }
  }

  ngOnInit() {
    this.http.getDeviceInfoDefault().subscribe(deviceInfo => {
      this.connectionInfo = deviceInfo;
      this.tempName = deviceInfo.hostname
      this.tempWidth = this.toDimensionString(deviceInfo.width_cm);
      this.tempLength = this.toDimensionString(deviceInfo.length_cm);
      this.deviceSensors = deviceInfo.sensors ?? [];
      this.syncSensorsFromDefinitions();
    });

    this.http.getAllProjects().subscribe(projects => {
      this.projects = projects;
      this.ensureSensorProjectSelection();
    })
  }

  enableEdit() {
    this.editingName = true;
  }

  disableEdit() {
    this.editingName = false;
  }

  finishEdit() {
    this.editingName = false;
    this.connectionInfo!.hostname = this.tempName;
    this.saveHostname(this.connectionInfo!.hostname);
  }

  saveHostname(newName: string) {
    this.http.changeHostname(newName).subscribe({
      next: res => {
        this.connectionInfo = res;
        this.tempName = res.hostname;
        this.tempWidth = this.toDimensionString(res.width_cm);
        this.tempLength = this.toDimensionString(res.length_cm);
        NotificationService.showSuccess(
          this.translate.instant('PROJECT_MENU.SAVE_HOSTNAME_SUCCESS'),
          this.translate.instant('COMMON.SUCCESS')
        );
      },
      error: err => {
        NotificationService.showError(
          this.translate.instant('PROJECT_MENU.SAVE_HOSTNAME_ERROR'),
          this.translate.instant('COMMON.ERROR')
        )
        console.log(err)
      }
    })
  }

  get canSaveDimensions(): boolean {
    if (!this.connectionInfo) {
      return false;
    }

    return this.parseDimension(this.tempWidth) !== undefined &&
      this.parseDimension(this.tempLength) !== undefined;
  }

  enableDimensionsEdit() {
    if (!this.connectionInfo) {
      return;
    }

    this.editingDimensions = true;
    this.tempWidth = this.toDimensionString(this.connectionInfo.width_cm);
    this.tempLength = this.toDimensionString(this.connectionInfo.length_cm);
  }

  cancelDimensionsEdit() {
    this.editingDimensions = false;
    this.tempWidth = this.toDimensionString(this.connectionInfo?.width_cm);
    this.tempLength = this.toDimensionString(this.connectionInfo?.length_cm);
  }

  saveDimensions() {
    const width = this.parseDimension(this.tempWidth);
    const length = this.parseDimension(this.tempLength);

    if (width === undefined || length === undefined) {
      NotificationService.showError(
        this.translate.instant('PROJECT_MENU.INVALID_DIMENSIONS'),
        this.translate.instant('COMMON.ERROR')
      );
      return;
    }

    this.http.updateDeviceDimensions(width, length).subscribe({
      next: (info: ConnectionInfo) => {
        this.connectionInfo = info;
        this.tempWidth = this.toDimensionString(info.width_cm);
        this.tempLength = this.toDimensionString(info.length_cm);
        this.editingDimensions = false;
        if (info.length_cm !== undefined && info.width_cm !== undefined) {
          this.unity.applyRobotSize(info.length_cm, info.width_cm);
        } else {
          this.unity.applyRobotSize(length, width);
        }
        NotificationService.showSuccess(
          this.translate.instant('PROJECT_MENU.SAVE_DIMENSIONS_SUCCESS'),
          this.translate.instant('COMMON.SUCCESS')
        );
      },
      error: err => {
        NotificationService.showError(
          this.translate.instant('PROJECT_MENU.SAVE_DIMENSIONS_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
        console.error(err);
      }
    })
  }

  private parseDimension(value: string): number | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const parsed = Number(value);
    if (Number.isNaN(parsed) || parsed < 0) {
      return undefined;
    }

    return parsed;
  }

  private toDimensionString(value: number | undefined | null): string {
    return value === undefined || value === null ? '' : value.toString();
  }

  formatDimension(value: number | undefined | null): string {
    return value === undefined || value === null ? '--' : value.toString();
  }

  confirmDelete(uuid: string) {
    this.confirmationService.confirm({
      message: this.translate.instant('PROJECT_MENU.CONFIRM_DELETE_MESSAGE'),
      header: this.translate.instant('COMMON.CONFIRM_DELETION'),
      icon: 'pi pi-exclamation-triangle',
      acceptButtonStyleClass: 'p-button-danger p-button-sm',
      rejectButtonStyleClass: 'p-button-secondary p-button-sm',
      accept: () => {
        this.deleteProject(uuid);
      }
    });
  }

  private deleteProject(uuid: string) {
    this.http.deleteProject(uuid).subscribe({
      next: () => {
        NotificationService.showSuccess(
          this.translate.instant('PROJECT_MENU.DELETE_SUCCESS'),
          this.translate.instant('COMMON.SUCCESS')
        );
        this.projects = this.projects.filter(project => project.uuid !== uuid)
        this.ensureSensorProjectSelection();
      },
      error: err => {
        NotificationService.showError(
          this.translate.instant('PROJECT_MENU.DELETE_ERROR'),
          this.translate.instant('COMMON.ERROR')
        )
        console.log(err)
      }
    })
  }

  addingProject = false;
  newProjectName = "";

  enableAddProject() {
    this.addingProject = true;
    this.newProjectName = "";
  }

  cancelAddProject() {
    this.addingProject = false;
  }

  createProject() {
    if (!this.newProjectName.trim()) {
      NotificationService.showError(
        this.translate.instant('PROJECT_MENU.NAME_REQUIRED'),
        this.translate.instant('COMMON.ERROR')
      );
      return;
    }

    this.http.createProject(this.newProjectName).subscribe({
      next: (project: Project) => {
        NotificationService.showSuccess(
          this.translate.instant('PROJECT_MENU.CREATE_SUCCESS'),
          this.translate.instant('COMMON.SUCCESS')
        );
        this.projects = [...this.projects, project];
        this.ensureSensorProjectSelection();
        this.addingProject = false;
      },
      error: err => {
        NotificationService.showError(
          this.translate.instant('PROJECT_MENU.CREATE_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
        console.error(err);
      }
    });
  }

  redirectToProject(uuid: string) {
    const ipParam = this.route.snapshot.paramMap.get('ip');
    const decodedIp = decodeRouteIp(ipParam);
    if (!decodedIp) {
      console.warn('Cannot redirect to project view: missing IP route parameter');
      return;
    }

    this.router.navigate(['/', encodeRouteIp(decodedIp), 'projects', uuid]);
  }

  backToProjects() {
    this.router.navigate(['/']);
  }

  selectSensor(sensorId: number) {
    this.selectedSensorId = this.selectedSensorId === sensorId ? null : sensorId;
  }

  setSelectedSensorCoordCm(axis: 'x' | 'y', value: number | null) {
    if (this.selectedSensorId === null) {
      return;
    }

    const dimensions = this.getDisplayDimensions();
    if (!dimensions) {
      return;
    }

    if (!this.selectedSensor) {
      return;
    }

    const parsed = value === null || value === undefined ? undefined : Number(value);
    const maxCm = axis === 'x' ? dimensions.width : dimensions.length;
    const clampedCm = parsed === undefined || Number.isNaN(parsed)
      ? undefined
      : Math.min(Math.max(parsed, 0), maxCm);
    const percent = clampedCm === undefined || maxCm === 0
      ? undefined
      : axis === 'y'
        ? (1 - clampedCm / maxCm) * 100
        : (clampedCm / maxCm) * 100;

    this.sensors = this.sensors.map(sensor => {
      if (sensor.id !== this.selectedSensorId) {
        return sensor;
      }

      return {
        ...sensor,
        x_pct: axis === 'x' ? percent : sensor.x_pct,
        y_pct: axis === 'y' ? percent : sensor.y_pct,
      };
    });

    this.persistSensors();
  }

  setSelectedSensorClearanceCm(value: number | null) {
    if (this.selectedSensorId === null) {
      return;
    }

    const parsed = value === null || value === undefined ? undefined : Number(value);
    const maxCm = this.sensorMaxClearanceCm;
    const clamped = parsed === undefined || Number.isNaN(parsed)
      ? undefined
      : Math.min(Math.max(parsed, 0), maxCm ?? parsed);

    this.sensors = this.sensors.map(sensor => {
      if (sensor.id !== this.selectedSensorId) {
        return sensor;
      }

      return {
        ...sensor,
        clearance_cm: clamped,
      };
    });

    this.persistSensors();
  }

  placeSelectedSensor(event: MouseEvent) {
    if (this.selectedSensorId === null) {
      return;
    }

    if (!this.selectedSensor) {
      return;
    }

    const target = event.currentTarget as HTMLElement | null;
    if (!target) {
      return;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return;
    }

    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    const clampedX = Math.min(Math.max(x, 0), 100);
    const clampedY = Math.min(Math.max(y, 0), 100);

    this.sensors = this.sensors.map(sensor => {
      if (sensor.id !== this.selectedSensorId) {
        return sensor;
      }

      return {
        ...sensor,
        x_pct: clampedX,
        y_pct: clampedY
      };
    });
    this.persistSensors();
  }

  get robotScale() {
    const dimensions = this.getDisplayDimensions();
    if (!dimensions) {
      return { widthPct: 70, heightPct: 70 };
    }

    const max = Math.max(dimensions.width, dimensions.length);
    return {
      widthPct: (dimensions.width / max) * 100,
      heightPct: (dimensions.length / max) * 100
    };
  }

  get robotDimensionLabel(): string {
    const dimensions = this.getDisplayDimensions();
    return `${this.formatDimension(dimensions?.width)} × ${this.formatDimension(dimensions?.length)} cm`;
  }

  get robotWidthLabel(): string {
    const dimensions = this.getDisplayDimensions();
    return `${this.formatDimension(dimensions?.width)} cm`;
  }

  get robotLengthLabel(): string {
    const dimensions = this.getDisplayDimensions();
    return `${this.formatDimension(dimensions?.length)} cm`;
  }

  get selectedSensor(): Sensor | undefined {
    if (this.selectedSensorId === null) {
      return undefined;
    }

    return this.sensors.find(sensor => sensor.id === this.selectedSensorId);
  }

  get canEditSensorCm(): boolean {
    return this.getDisplayDimensions() !== null;
  }

  get selectedSensorXcm(): number | null {
    const dimensions = this.getDisplayDimensions();
    if (!dimensions || this.selectedSensor?.x_pct === undefined) {
      return null;
    }

    return this.roundToTwo((dimensions.width * this.selectedSensor.x_pct) / 100);
  }

  get selectedSensorYcm(): number | null {
    const dimensions = this.getDisplayDimensions();
    if (!dimensions || this.selectedSensor?.y_pct === undefined) {
      return null;
    }

    return this.roundToTwo(dimensions.length * (1 - this.selectedSensor.y_pct / 100));
  }

  get selectedSensorClearanceCm(): number | null {
    if (!this.selectedSensor || this.selectedSensor.clearance_cm === undefined) {
      return null;
    }

    return this.roundToTwo(this.selectedSensor.clearance_cm);
  }

  get sensorMaxXcm(): number | null {
    const dimensions = this.getDisplayDimensions();
    if (!dimensions) {
      return null;
    }
    return dimensions.width;
  }

  get sensorMaxYcm(): number | null {
    const dimensions = this.getDisplayDimensions();
    if (!dimensions) {
      return null;
    }
    return dimensions.length;
  }

  get sensorMinXcm(): number | null {
    const dimensions = this.getDisplayDimensions();
    if (!dimensions) {
      return null;
    }
    return 0;
  }

  get sensorMinYcm(): number | null {
    const dimensions = this.getDisplayDimensions();
    if (!dimensions) {
      return null;
    }
    return 0;
  }

  get sensorMaxClearanceCm(): number | null {
    const dimensions = this.getDisplayDimensions();
    if (!dimensions) {
      return null;
    }

    return Math.min(dimensions.width, dimensions.length) / 2;
  }

  private getDisplayDimensions(): { width: number; length: number } | null {
    const width = this.editingDimensions
      ? this.parseDimension(this.tempWidth) ?? this.connectionInfo?.width_cm
      : this.connectionInfo?.width_cm;
    const length = this.editingDimensions
      ? this.parseDimension(this.tempLength) ?? this.connectionInfo?.length_cm
      : this.connectionInfo?.length_cm;

    if (width === undefined || length === undefined || width <= 0 || length <= 0) {
      return null;
    }

    return { width, length };
  }

  getSensorMarkerStyle(sensor: Sensor): Record<string, string> {
    const style: Record<string, string> = {
      '--sensor-x': `${sensor.x_pct}%`,
      '--sensor-y': `${sensor.y_pct}%`,
    };
    const clearance = this.getSensorClearanceDiameter(sensor);
    if (clearance) {
      style['--sensor-clear-x'] = `${clearance.x}%`;
      style['--sensor-clear-y'] = `${clearance.y}%`;
    }
    return style;
  }

  getSensorClearanceVisible(sensor: Sensor): boolean {
    if (sensor.clearance_cm === undefined || sensor.clearance_cm <= 0) {
      return false;
    }
    return !!this.getSensorClearanceDiameter(sensor);
  }

  private getSensorClearanceDiameter(sensor: Sensor): { x: number; y: number } | null {
    if (sensor.clearance_cm === undefined) {
      return null;
    }

    const dimensions = this.getDisplayDimensions();
    if (!dimensions || dimensions.width === 0 || dimensions.length === 0) {
      return null;
    }

    return {
      x: (sensor.clearance_cm * 2 / dimensions.width) * 100,
      y: (sensor.clearance_cm * 2 / dimensions.length) * 100,
    };
  }

  private roundToTwo(value: number): number {
    return Math.round(value * 100) / 100;
  }

  onSensorProjectChange(projectUuid: string | null) {
    this.sensorProjectUuid = projectUuid;
    this.loadSensorDefinitionsForProject(projectUuid);
  }

  private ensureSensorProjectSelection() {
    if (this.projects.length === 0) {
      this.sensorProjectUuid = null;
      this.sensorDefinitions = [];
      this.syncSensorsFromDefinitions();
      return;
    }

    const hasSelection = this.sensorProjectUuid && this.projects.some(project => project.uuid === this.sensorProjectUuid);
    if (!hasSelection) {
      this.sensorProjectUuid = this.projects[0].uuid;
    }

    this.loadSensorDefinitionsForProject(this.sensorProjectUuid);
  }

  private loadSensorDefinitionsForProject(projectUuid: string | null) {
    if (!projectUuid) {
      this.sensorDefinitions = [];
      this.syncSensorsFromDefinitions();
      return;
    }

    this.http.getTypeDefinitions(projectUuid).subscribe({
      next: definitions => {
        this.sensorDefinitions = this.filterIrSensorDefinitions(definitions);
        this.syncSensorsFromDefinitions();
      },
      error: () => {
        this.sensorDefinitions = [];
        this.syncSensorsFromDefinitions();
      }
    });
  }

  private filterIrSensorDefinitions(definitions: TypeDefinition[]): TypeDefinition[] {
    return definitions.filter(definition => definition.type === 'IRSensor');
  }

  private syncSensorsFromDefinitions() {
    const sensorLookup = new Map(this.deviceSensors.map(sensor => [sensor.name, sensor]));
    this.sensors = this.sensorDefinitions.map((definition, index) => {
      const stored = sensorLookup.get(definition.name);
      return {
        id: index + 1,
        name: definition.name,
        color: this.sensorPalette[index % this.sensorPalette.length],
        x_pct: stored?.x_pct ?? undefined,
        y_pct: stored?.y_pct ?? undefined,
        clearance_cm: stored?.clearance_cm ?? undefined,
      };
    });

    if (this.selectedSensorId !== null && !this.sensors.some(sensor => sensor.id === this.selectedSensorId)) {
      this.selectedSensorId = null;
    }
  }

  private persistSensors() {
    const payload: DeviceSensorInfo[] = this.sensors.map(sensor => ({
      name: sensor.name,
      x_pct: sensor.x_pct,
      y_pct: sensor.y_pct,
      clearance_cm: sensor.clearance_cm,
    }));

    this.http.updateDeviceSensors(payload).subscribe({
      next: info => {
        this.connectionInfo = info;
        this.deviceSensors = info.sensors ?? [];
        this.syncSensorsFromDefinitions();
      },
      error: err => {
        NotificationService.showError(
          this.translate.instant('PROJECT_MENU.SENSOR_SAVE_ERROR'),
          this.translate.instant('COMMON.ERROR')
        );
        console.error(err);
      }
    });
  }

}
