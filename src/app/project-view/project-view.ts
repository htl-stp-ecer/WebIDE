import {AfterViewInit, Component, ElementRef, OnDestroy, signal, ViewChild} from '@angular/core';
import {MissionPanel} from './mission-panel/mission-panel';
import {Flowchart} from './flowchart/flowchart';
import {StepPanel} from './step-panel/step-panel';
import {StepDocsPanel} from './step-docs-panel/step-docs-panel';
import {CodeView} from './code-view/code-view';
import {RunLogPanel} from './flowchart/logs/run-log-panel';
import {TableVisualizationPanel} from './flowchart/table/table-visualization-panel';
import {TableEditorView} from './flowchart/table/table-editor-view';
import { ActivatedRoute } from '@angular/router';
import { HttpService } from '../services/http-service';

type ResizeSide = 'left' | 'right' | 'bottom';

const STORAGE_KEYS = {
  rightWidth: 'webide-right-panel-width',
  activeRightPanel: 'webide-active-right-panel',
  leftPanelWidth: 'webide-left-panel-width',
  activeToolPanel: 'webide-active-tool-panel',
  activeBottomPanel: 'webide-active-bottom-panel',
  bottomPanelHeight: 'webide-bottom-panel-height',
} as const;

interface ResizeState {
  side: ResizeSide;
  startX: number;
  startY: number;
  startLeft: number;
  startRight: number;
  startBottom: number;
  containerWidth: number;
  containerHeight: number;
}

export type CenterView = 'flowchart' | 'code';
export type SideToolPanel = 'missions' | null;
export type BottomToolPanel = 'logs' | 'table' | null;
export type RightToolPanel = 'steps' | 'docs' | null;

@Component({
  selector: 'app-project-view',
  imports: [
    MissionPanel,
    Flowchart,
    StepPanel,
    StepDocsPanel,
    CodeView,
    RunLogPanel,
    TableVisualizationPanel,
    TableEditorView,
  ],
  templateUrl: './project-view.html',
  styleUrl: './project-view.scss'
})
export class ProjectView implements OnDestroy, AfterViewInit {
  private static readonly MIN_PANEL_WIDTH = 220;
  private static readonly MIN_CENTER_WIDTH = 360;
  private static readonly MIN_BOTTOM_HEIGHT = 120;
  private static readonly DEFAULT_BOTTOM_HEIGHT = 200;
  private static readonly COLLAPSED_WIDTH = 40;
  private static readonly DEFAULT_PANEL_WIDTH = 280;

  @ViewChild('layoutRoot') layoutRoot!: ElementRef<HTMLDivElement>;
  @ViewChild('leftPanel') leftPanelRef!: ElementRef<HTMLDivElement>;
  @ViewChild('rightPanel') rightPanelRef!: ElementRef<HTMLDivElement>;
  @ViewChild('tableVizRef') tableVizRef?: TableVisualizationPanel;
  @ViewChild('missionPanelRef') missionPanelRef?: MissionPanel;

  private resizeState: ResizeState | null = null;

  activeRightPanel = signal<RightToolPanel>(this.loadActiveRightPanel());
  activeToolPanel = signal<SideToolPanel>(this.loadActiveToolPanel());
  activeBottomPanel = signal<BottomToolPanel>(this.loadActiveBottomPanel());
  tableEditMode = signal(false);
  centerView = signal<CenterView>('flowchart');
  projectUUID = '';

  ngAfterViewInit(): void {
    const savedHeight = localStorage.getItem(STORAGE_KEYS.bottomPanelHeight);
    if (savedHeight && this.layoutRoot?.nativeElement) {
      this.layoutRoot.nativeElement.style.setProperty('--bottom-panel-height', `${savedHeight}px`);
    }
  }

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

  private loadActiveRightPanel(): RightToolPanel {
    const saved = localStorage.getItem(STORAGE_KEYS.activeRightPanel);
    return (saved === 'steps' || saved === 'docs') ? saved : null;
  }

  private loadActiveToolPanel(): SideToolPanel {
    const saved = localStorage.getItem(STORAGE_KEYS.activeToolPanel);
    return saved === 'missions' ? saved : null;
  }

  private loadActiveBottomPanel(): BottomToolPanel {
    const saved = localStorage.getItem(STORAGE_KEYS.activeBottomPanel);
    return (saved === 'logs' || saved === 'table') ? saved : null;
  }

  toggleToolPanel(panel: SideToolPanel): void {
    const current = this.activeToolPanel();
    const newPanel = current === panel ? null : panel;
    this.activeToolPanel.set(newPanel);
    localStorage.setItem(STORAGE_KEYS.activeToolPanel, newPanel ?? '');
  }

  toggleBottomPanel(panel: BottomToolPanel): void {
    const current = this.activeBottomPanel();
    const newPanel = current === panel ? null : panel;
    this.activeBottomPanel.set(newPanel);
    localStorage.setItem(STORAGE_KEYS.activeBottomPanel, newPanel ?? '');
  }

  toggleRightPanel(panel: RightToolPanel): void {
    const current = this.activeRightPanel();
    const newPanel = current === panel ? null : panel;
    this.activeRightPanel.set(newPanel);
    localStorage.setItem(STORAGE_KEYS.activeRightPanel, newPanel ?? '');

    if (newPanel) {
      const layout = this.layoutRoot?.nativeElement;
      if (layout) {
        const savedWidth = localStorage.getItem(STORAGE_KEYS.rightWidth);
        const width = savedWidth ? parseInt(savedWidth, 10) : ProjectView.DEFAULT_PANEL_WIDTH;
        layout.style.setProperty('--right-panel-width', `${width}px`);
      }
    }
  }

  toggleLeftPanel(): void {
    // Kept for compatibility if needed elsewhere, delegates to toggleToolPanel
    this.toggleToolPanel(this.activeToolPanel() === 'missions' ? null : 'missions');
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
    const bottomHeight = side === 'bottom'
      ? (layout.querySelector('.panel-bottom') as HTMLElement)?.getBoundingClientRect().height ?? ProjectView.DEFAULT_BOTTOM_HEIGHT
      : 0;

    this.resizeState = {
      side,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: leftWidth,
      startRight: rightWidth,
      startBottom: bottomHeight,
      containerWidth: layoutRect.width,
      containerHeight: layoutRect.height,
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

    if (state.side === 'bottom') {
      if (!layout) return;
      const dy = event.clientY - state.startY;
      const maxBottom = state.containerHeight - ProjectView.MIN_BOTTOM_HEIGHT;
      const nextBottom = this.clamp(state.startBottom - dy, ProjectView.MIN_BOTTOM_HEIGHT, maxBottom);
      layout.style.setProperty('--bottom-panel-height', `${Math.round(nextBottom)}px`);
      localStorage.setItem(STORAGE_KEYS.bottomPanelHeight, String(Math.round(nextBottom)));
    } else {
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
