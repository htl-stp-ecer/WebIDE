import {Component, ElementRef, OnDestroy, ViewChild} from '@angular/core';
import {MissionPanel} from './mission-panel/mission-panel';
import {Flowchart} from './flowchart/flowchart';
import {StepPanel} from './step-panel/step-panel';
import { ActivatedRoute } from '@angular/router';
import { HttpService } from '../services/http-service';
import { decodeRouteIp } from '../services/route-ip-serializer';

type ResizeSide = 'left' | 'right';

interface ResizeState {
  side: ResizeSide;
  startX: number;
  startLeft: number;
  startRight: number;
  containerWidth: number;
}

@Component({
  selector: 'app-project-view',
  imports: [
    MissionPanel,
    Flowchart,
    StepPanel
  ],
  templateUrl: './project-view.html',
  styleUrl: './project-view.scss'
})
export class ProjectView implements OnDestroy {
  private static readonly MIN_PANEL_WIDTH = 220;
  private static readonly MIN_CENTER_WIDTH = 360;

  @ViewChild('layoutRoot') layoutRoot!: ElementRef<HTMLDivElement>;
  @ViewChild('leftPanel') leftPanelRef!: ElementRef<HTMLDivElement>;
  @ViewChild('rightPanel') rightPanelRef!: ElementRef<HTMLDivElement>;

  private resizeState: ResizeState | null = null;

  constructor(
    private route: ActivatedRoute,
    private http: HttpService,
  ) {
    const ipParam = this.route.snapshot.paramMap.get('ip');
    const decodedIp = decodeRouteIp(ipParam);
    if (decodedIp) {
      this.http.setIp(decodedIp);
    }
  }

  ngOnDestroy(): void {
    this.stopResize();
  }

  startResize(event: PointerEvent, side: ResizeSide): void {
    if (!event.isPrimary || event.button !== 0) return;
    const layout = this.layoutRoot?.nativeElement;
    const leftPanel = this.leftPanelRef?.nativeElement;
    const rightPanel = this.rightPanelRef?.nativeElement;
    if (!layout || !leftPanel || !rightPanel) return;

    event.preventDefault();
    this.stopResize();
    const layoutRect = layout.getBoundingClientRect();
    const leftWidth = leftPanel.getBoundingClientRect().width;
    const rightWidth = rightPanel.getBoundingClientRect().width;
    this.resizeState = {
      side,
      startX: event.clientX,
      startLeft: leftWidth,
      startRight: rightWidth,
      containerWidth: layoutRect.width,
    };
    window.addEventListener('pointermove', this.onResizeMove);
    window.addEventListener('pointerup', this.onResizeUp);
  }

  private onResizeMove = (event: PointerEvent): void => {
    const state = this.resizeState;
    if (!state) return;
    event.preventDefault();
    const layout = this.layoutRoot?.nativeElement;
    if (!layout) return;

    const dx = event.clientX - state.startX;
    if (state.side === 'left') {
      const maxLeft = state.containerWidth - ProjectView.MIN_CENTER_WIDTH - state.startRight;
      const nextLeft = this.clamp(state.startLeft + dx, ProjectView.MIN_PANEL_WIDTH, maxLeft);
      layout.style.setProperty('--left-panel-width', `${Math.round(nextLeft)}px`);
    } else {
      const maxRight = state.containerWidth - ProjectView.MIN_CENTER_WIDTH - state.startLeft;
      const nextRight = this.clamp(state.startRight - dx, ProjectView.MIN_PANEL_WIDTH, maxRight);
      layout.style.setProperty('--right-panel-width', `${Math.round(nextRight)}px`);
    }
  };

  private onResizeUp = (): void => {
    this.stopResize();
  };

  private stopResize(): void {
    if (!this.resizeState) return;
    this.resizeState = null;
    window.removeEventListener('pointermove', this.onResizeMove);
    window.removeEventListener('pointerup', this.onResizeUp);
  }

  private clamp(value: number, min: number, max: number): number {
    if (min > max) {
      const tmp = min;
      min = max;
      max = tmp;
    }
    return Math.min(Math.max(value, min), max);
  }
}
