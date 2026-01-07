import { AfterViewInit, Component, ElementRef, ViewChild, signal } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { UnityWebglService } from './unity-webgl.service';

@Component({
  selector: 'app-table-editor-panel',
  standalone: true,
  imports: [TranslateModule],
  templateUrl: './table-editor-panel.html',
  styleUrl: './table-editor-panel.scss',
})
export class TableEditorPanel implements AfterViewInit {
  @ViewChild('drawCanvas') drawCanvasRef!: ElementRef<HTMLCanvasElement>;

  readonly message = signal<string>('');

  private ctx: CanvasRenderingContext2D | null = null;
  private drawing = false;

  constructor(
    readonly unity: UnityWebglService,
    private readonly translate: TranslateService
  ) {}

  ngAfterViewInit(): void {
    const canvas = this.drawCanvasRef.nativeElement;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.clearCanvas();
  }

  onPointerDown(): void {
    this.drawing = true;
  }

  onPointerUp(): void {
    this.drawing = false;
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.drawing || !this.ctx) return;

    const canvas = this.drawCanvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) * (canvas.width / rect.width));
    const y = Math.floor((event.clientY - rect.top) * (canvas.height / rect.height));

    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
    this.ctx.fillStyle = 'black';
    this.ctx.fillRect(x, y, 1, 1);
  }

  clearCanvas(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const canvas = this.drawCanvasRef.nativeElement;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.message.set(this.translate.instant('FLOWCHART.TABLE_MESSAGE_CLEARED'));
  }

  sendToUnity(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.unity.isReady()) {
      this.message.set(this.translate.instant('FLOWCHART.TABLE_MESSAGE_UNITY_NOT_READY'));
      return;
    }

    const canvas = this.drawCanvasRef.nativeElement;
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const pixelCount = canvas.width * canvas.height;
    const bits = new Array<string>(pixelCount);

    for (let i = 0, p = 0; i < imgData.length; i += 4, p++) {
      const avg = (imgData[i] + imgData[i + 1] + imgData[i + 2]) / 3;
      bits[p] = avg < 128 ? '1' : '0';
    }

    const binary = bits.join('');
    try {
      this.unity.sendMessage('GameTableBuilder', 'BuildFromData', binary);
      this.message.set(
        this.translate.instant('FLOWCHART.TABLE_MESSAGE_SENT', {
          count: pixelCount,
          width: canvas.width,
          height: canvas.height,
        })
      );
    } catch (err) {
      this.message.set(
        this.translate.instant('FLOWCHART.TABLE_MESSAGE_FAILED', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }
}
