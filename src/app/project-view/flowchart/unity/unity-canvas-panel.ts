import { AfterViewInit, Component, ElementRef, Input, OnChanges, SimpleChanges, ViewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { TranslateModule } from '@ngx-translate/core';
import { UnityWebglService } from './unity-webgl.service';

@Component({
  selector: 'app-unity-canvas-panel',
  standalone: true,
  imports: [DecimalPipe, TranslateModule],
  templateUrl: './unity-canvas-panel.html',
  styleUrl: './unity-canvas-panel.scss',
})
export class UnityCanvasPanel implements AfterViewInit, OnChanges {
  @Input() visible = false;
  @Input() baseUrl = 'https://localhost:4443';

  @ViewChild('unityCanvas') unityCanvasRef!: ElementRef<HTMLCanvasElement>;

  private viewReady = false;

  constructor(readonly unity: UnityWebglService) {}

  ngAfterViewInit(): void {
    this.viewReady = true;
    if (this.visible) void this.start();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.viewReady) return;
    if (changes['baseUrl'] && !changes['baseUrl'].firstChange) {
      // Ensure the Unity instance is reloaded from the correct backend origin.
      this.unity.reset();
      if (this.visible) {
        void this.start();
      }
      return;
    }
    if (changes['visible'] && this.visible && this.unity.status() === 'idle') {
      void this.start();
    }
  }

  async start(): Promise<void> {
    if (!this.viewReady) return;
    await this.unity.init(this.unityCanvasRef.nativeElement, this.baseUrl);
  }

  reload(): void {
    this.unity.reset();
    void this.start();
  }

  suppressContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }
}
