import {Component, ElementRef, OnDestroy, signal, ViewChild} from '@angular/core';
import {MissionPanel} from './mission-panel/mission-panel';
import {Flowchart} from './flowchart/flowchart';
import {StepPanel} from './step-panel/step-panel';
import {CodeView} from './code-view/code-view';
import { ActivatedRoute } from '@angular/router';
import { HttpService } from '../services/http-service';

type ResizeSide = 'left' | 'right';

const STORAGE_KEYS = {
  leftCollapsed: 'webide-left-panel-collapsed',
  rightCollapsed: 'webide-right-panel-collapsed',
  leftWidth: 'webide-left-panel-width',
  rightWidth: 'webide-right-panel-width',
} as const;

interface ResizeState {
  side: ResizeSide;
  startX: number;
  startLeft: number;
  startRight: number;
  containerWidth: number;
}

export type CenterView = 'flowchart' | 'code';

@Component({
  selector: 'app-project-view',
  imports: [
    MissionPanel,
    Flowchart,
    StepPanel,
    CodeView,
  ],
  templateUrl: './project-view.html',
  styleUrl: './project-view.scss'
})
export class ProjectView implements OnDestroy {
  private static readonly MIN_PANEL_WIDTH = 220;
  private static readonly MIN_CENTER_WIDTH = 360;
  private static readonly COLLAPSED_WIDTH = 40;
  private static readonly DEFAULT_PANEL_WIDTH = 280;

  @ViewChild('layoutRoot') layoutRoot!: ElementRef<HTMLDivElement>;
  @ViewChild('leftPanel') leftPanelRef!: ElementRef<HTMLDivElement>;
  @ViewChild('rightPanel') rightPanelRef!: ElementRef<HTMLDivElement>;

  private resizeState: ResizeState | null = null;

  leftCollapsed = signal(this.loadCollapsedState('left'));
  rightCollapsed = signal(this.loadCollapsedState('right'));
  centerView = signal<CenterView>('flowchart');
  projectUUID = '';

  toggleCenterView(): void {
    this.centerView.set(this.centerView() === 'flowchart' ? 'code' : 'flowchart');
  }

  constructor(
    private route: ActivatedRoute,
    private http: HttpService,
  ) {
    const projectUUID = this.route.snapshot.paramMap.get('uuid');
    if (!projectUUID) {
      this.http.clearDeviceBase();
      return;
    }
    this.projectUUID = projectUUID;

    this.http.getProject(projectUUID).subscribe({
      next: project => {
        const connection = project.connection;
        if (connection?.pi_address) {
          const base = connection.pi_port ? `${connection.pi_address}:${connection.pi_port}` : connection.pi_address;
          this.http.setDeviceBase(base);
        } else {
          this.http.clearDeviceBase();
        }
      },
      error: () => {
        this.http.clearDeviceBase();
      }
    });
  }

  private loadCollapsedState(side: 'left' | 'right'): boolean {
    const key = side === 'left' ? STORAGE_KEYS.leftCollapsed : STORAGE_KEYS.rightCollapsed;
    return localStorage.getItem(key) === 'true';
  }

  toggleLeftPanel(): void {
    const layout = this.layoutRoot?.nativeElement;
    const leftPanel = this.leftPanelRef?.nativeElement;

    if (!this.leftCollapsed() && layout && leftPanel) {
      const currentWidth = leftPanel.getBoundingClientRect().width;
      localStorage.setItem(STORAGE_KEYS.leftWidth, String(Math.round(currentWidth)));
    }

    const newState = !this.leftCollapsed();
    this.leftCollapsed.set(newState);
    localStorage.setItem(STORAGE_KEYS.leftCollapsed, String(newState));

    if (!newState && layout) {
      const savedWidth = localStorage.getItem(STORAGE_KEYS.leftWidth);
      const width = savedWidth ? parseInt(savedWidth, 10) : ProjectView.DEFAULT_PANEL_WIDTH;
      layout.style.setProperty('--left-panel-width', `${width}px`);
    }
  }

  toggleRightPanel(): void {
    const layout = this.layoutRoot?.nativeElement;
    const rightPanel = this.rightPanelRef?.nativeElement;

    if (!this.rightCollapsed() && layout && rightPanel) {
      const currentWidth = rightPanel.getBoundingClientRect().width;
      localStorage.setItem(STORAGE_KEYS.rightWidth, String(Math.round(currentWidth)));
    }

    const newState = !this.rightCollapsed();
    this.rightCollapsed.set(newState);
    localStorage.setItem(STORAGE_KEYS.rightCollapsed, String(newState));

    if (!newState && layout) {
      const savedWidth = localStorage.getItem(STORAGE_KEYS.rightWidth);
      const width = savedWidth ? parseInt(savedWidth, 10) : ProjectView.DEFAULT_PANEL_WIDTH;
      layout.style.setProperty('--right-panel-width', `${width}px`);
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
