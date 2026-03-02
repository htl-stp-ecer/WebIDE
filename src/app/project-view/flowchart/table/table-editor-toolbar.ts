import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { Tooltip } from 'primeng/tooltip';
import {
  EditorTool,
  LineKind,
  MeasurementUnit,
  ZOOM_LEVELS,
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_STEP,
  TOOL_OPTIONS,
  LINE_KIND_OPTIONS,
  UNIT_OPTIONS,
} from './models/editor-state';

@Component({
  selector: 'app-table-editor-toolbar',
  standalone: true,
  imports: [CommonModule, TranslateModule, Tooltip],
  templateUrl: './table-editor-toolbar.html',
  styleUrl: './table-editor-toolbar.scss',
})
export class TableEditorToolbar {
  readonly zoom = input.required<number>();
  readonly showGrid = input.required<boolean>();
  readonly showSmartGuides = input.required<boolean>();
  readonly activeTool = input.required<EditorTool>();
  readonly lineKind = input.required<LineKind>();
  readonly measurementUnit = input.required<MeasurementUnit>();
  readonly hasSelection = input.required<boolean>();

  readonly zoomChange = output<number>();
  readonly gridToggle = output<void>();
  readonly smartGuidesToggle = output<void>();
  readonly toolChange = output<EditorTool>();
  readonly lineKindChange = output<LineKind>();
  readonly unitChange = output<MeasurementUnit>();
  readonly uploadRequest = output<void>();
  readonly clearRequest = output<void>();
  readonly loadMapRequest = output<void>();
  readonly deleteLineRequest = output<void>();
  readonly zoomToFit = output<void>();

  readonly toolOptions = TOOL_OPTIONS;
  readonly lineKindOptions = LINE_KIND_OPTIONS;
  readonly unitOptions = UNIT_OPTIONS;
  readonly zoomLevels = ZOOM_LEVELS;

  zoomIn(): void {
    this.zoomChange.emit(Math.min(MAX_ZOOM, this.zoom() + ZOOM_STEP));
  }

  zoomOut(): void {
    this.zoomChange.emit(Math.max(MIN_ZOOM, this.zoom() - ZOOM_STEP));
  }

  onZoomSelect(event: Event): void {
    const value = parseFloat((event.target as HTMLSelectElement).value);
    if (!Number.isNaN(value)) {
      this.zoomChange.emit(value);
    }
  }

  onLineKindSelect(event: Event): void {
    this.lineKindChange.emit((event.target as HTMLSelectElement).value as LineKind);
  }

  onUnitSelect(event: Event): void {
    this.unitChange.emit((event.target as HTMLSelectElement).value as MeasurementUnit);
  }
}
