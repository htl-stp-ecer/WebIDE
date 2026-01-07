import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { Tooltip } from 'primeng/tooltip';
import {
  DrawingTool,
  PaintColor,
  ZOOM_LEVELS,
  MIN_ZOOM,
  MAX_ZOOM,
  ZOOM_STEP,
  COLOR_OPTIONS,
  TOOL_OPTIONS,
} from './models/editor-state';

@Component({
  selector: 'app-table-editor-toolbar',
  standalone: true,
  imports: [CommonModule, TranslateModule, Tooltip],
  templateUrl: './table-editor-toolbar.html',
  styleUrl: './table-editor-toolbar.scss',
})
export class TableEditorToolbar {
  // Inputs
  readonly zoom = input.required<number>();
  readonly showGrid = input.required<boolean>();
  readonly activeTool = input.required<DrawingTool>();
  readonly selectedColor = input.required<PaintColor>();

  // Outputs
  readonly zoomChange = output<number>();
  readonly gridToggle = output<void>();
  readonly toolChange = output<DrawingTool>();
  readonly colorChange = output<PaintColor>();
  readonly uploadRequest = output<void>();
  readonly clearRequest = output<void>();
  readonly loadMapRequest = output<void>();
  readonly zoomToFit = output<void>();

  readonly colorOptions = COLOR_OPTIONS;
  readonly toolOptions = TOOL_OPTIONS;
  readonly zoomLevels = ZOOM_LEVELS;

  zoomIn(): void {
    const newZoom = Math.min(MAX_ZOOM, this.zoom() + ZOOM_STEP);
    this.zoomChange.emit(newZoom);
  }

  zoomOut(): void {
    const newZoom = Math.max(MIN_ZOOM, this.zoom() - ZOOM_STEP);
    this.zoomChange.emit(newZoom);
  }

  onZoomSelect(event: Event): void {
    const select = event.target as HTMLSelectElement;
    const value = parseFloat(select.value);
    if (!isNaN(value)) {
      this.zoomChange.emit(value);
    }
  }
}
