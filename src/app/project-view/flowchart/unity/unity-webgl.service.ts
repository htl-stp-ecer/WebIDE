import { Injectable, signal } from '@angular/core';

export type UnityWebglStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UnityWebglInstance {
  SendMessage(gameObject: string, methodName: string, parameter?: string): void;
  Quit?: () => Promise<void>;
}

declare global {
  interface Window {
    createUnityInstance?: (
      canvas: HTMLCanvasElement,
      config: Record<string, unknown>,
      onProgress?: (progress: number) => void
    ) => Promise<UnityWebglInstance>;
    onRobotEvent?: (message: string) => void;
  }
}

@Injectable({ providedIn: 'root' })
export class UnityWebglService {
  readonly status = signal<UnityWebglStatus>('idle');
  readonly progress = signal<number>(0);
  readonly error = signal<string | null>(null);

  private loaderPromise: Promise<void> | null = null;
  private instancePromise: Promise<UnityWebglInstance> | null = null;
  private instance: UnityWebglInstance | null = null;
  private baseUrl: string | null = null;

  private pendingRobotSize: { lengthCm: number; widthCm: number } | null = null;
  private lastAppliedRobotSize: { lengthCm: number; widthCm: number } | null = null;
  private robotSizeAttempt = 0;
  private robotSizeTimeoutId: number | null = null;
  private robotEventBridgeReady = false;
  private readonly robotEventListeners = new Set<(message: string) => void>();

  isReady(): boolean {
    return this.status() === 'ready' && !!this.instance;
  }

  sendMessage(gameObject: string, methodName: string, parameter?: string): void {
    if (!this.instance) return;
    this.instance.SendMessage(gameObject, methodName, parameter);
  }

  onRobotEvent(listener: (message: string) => void): () => void {
    this.ensureRobotEventBridge();
    this.robotEventListeners.add(listener);
    return () => {
      this.robotEventListeners.delete(listener);
    };
  }

  async init(canvas: HTMLCanvasElement, baseUrl: string): Promise<UnityWebglInstance> {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
    if (this.instance && this.baseUrl === normalizedBaseUrl) return this.instance;
    if (this.instancePromise && this.baseUrl === normalizedBaseUrl) return this.instancePromise;

    this.baseUrl = normalizedBaseUrl;
    this.status.set('loading');
    this.error.set(null);
    this.progress.set(0);

    this.instancePromise = (async () => {
      await this.ensureLoader(normalizedBaseUrl);
      const createUnityInstance = window.createUnityInstance;
      if (!createUnityInstance) {
        throw new Error('Unity loader script did not register createUnityInstance');
      }

      const [dataUrl, frameworkUrl, codeUrl] = await Promise.all([
        this.resolveBuildFile(normalizedBaseUrl, 'Build.data'),
        this.resolveBuildFile(normalizedBaseUrl, 'Build.framework.js'),
        this.resolveBuildFile(normalizedBaseUrl, 'Build.wasm'),
      ]);

      let rejectOnUnityError: ((err: unknown) => void) | null = null;
      const unityError = (message: string): void => {
        this.error.set(message);
        this.status.set('error');
        rejectOnUnityError?.(new Error(message));
      };

      const instance = await Promise.race([
        createUnityInstance(
          canvas,
          {
            dataUrl,
            frameworkUrl,
            codeUrl,
            streamingAssetsUrl: `${normalizedBaseUrl}/StreamingAssets`,
            companyName: 'DefaultCompany',
            productName: 'ECER Sim',
            productVersion: '1.0',
            showBanner: (message: string, type?: string) => {
              if (type === 'error') unityError(message);
            },
            startupErrorHandler: (message: string) => {
              unityError(message);
            },
          },
          progress => this.progress.set(progress)
        ),
        new Promise<UnityWebglInstance>((_resolve, reject) => {
          rejectOnUnityError = reject;
          setTimeout(() => reject(new Error('Unity loading timed out (check browser console + network tab)')), 600_000);
        }),
      ]);

      this.instance = instance;
      this.status.set('ready');
      if (this.pendingRobotSize) {
        this.robotSizeAttempt = 0;
        this.scheduleRobotSizeAttempt(0);
      }
      void this.syncRobotSizeFromBackend();
      return instance;
    })();

    try {
      return await this.instancePromise;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error.set(message);
      this.status.set('error');
      this.instancePromise = null;
      throw err;
    }
  }

  reset(): void {
    if (this.robotSizeTimeoutId !== null) {
      window.clearTimeout(this.robotSizeTimeoutId);
      this.robotSizeTimeoutId = null;
    }
    this.pendingRobotSize = null;
    this.lastAppliedRobotSize = null;
    this.robotSizeAttempt = 0;
    this.status.set('idle');
    this.progress.set(0);
    this.error.set(null);
    this.instancePromise = null;
    this.instance = null;
    this.baseUrl = null;
  }

  private ensureRobotEventBridge(): void {
    if (this.robotEventBridgeReady) return;
    this.robotEventBridgeReady = true;
    const previous = window.onRobotEvent;
    window.onRobotEvent = (message: string) => {
      if (typeof previous === 'function') {
        try {
          previous(message);
        } catch {
          // Ignore previous handler errors.
        }
      }
      for (const listener of this.robotEventListeners) {
        try {
          listener(message);
        } catch {
          // Ignore listener errors.
        }
      }
    };
  }

  applyRobotSize(lengthCm: number, widthCm: number): void {
    if (!Number.isFinite(lengthCm) || !Number.isFinite(widthCm)) return;
    if (lengthCm < 0 || widthCm < 0) return;

    this.pendingRobotSize = { lengthCm, widthCm };
    this.robotSizeAttempt = 0;
    if (this.instance) {
      this.scheduleRobotSizeAttempt(0);
    }
  }

  async syncRobotSizeFromBackend(): Promise<void> {
    if (!this.baseUrl) return;
    try {
      const resp = await fetch(`${this.baseUrl}/api/v1/device/info`, { cache: 'no-store' });
      if (!resp.ok) return;
      const data = (await resp.json()) as { length_cm?: unknown; width_cm?: unknown };
      const lengthCm = Number(data.length_cm);
      const widthCm = Number(data.width_cm);
      if (!Number.isFinite(lengthCm) || !Number.isFinite(widthCm)) return;
      this.applyRobotSize(lengthCm, widthCm);
    } catch {
      // Keep Unity usable even if the backend endpoint is temporarily unavailable.
    }
  }

  private scheduleRobotSizeAttempt(delayMs: number): void {
    if (this.robotSizeTimeoutId !== null) {
      window.clearTimeout(this.robotSizeTimeoutId);
    }
    this.robotSizeTimeoutId = window.setTimeout(() => this.tryApplyRobotSizeOnce(), delayMs);
  }

  private tryApplyRobotSizeOnce(): void {
    this.robotSizeTimeoutId = null;
    const size = this.pendingRobotSize;
    if (!size || !this.instance) return;

    const alreadyApplied =
      this.lastAppliedRobotSize &&
      Math.abs(this.lastAppliedRobotSize.lengthCm - size.lengthCm) < 1e-6 &&
      Math.abs(this.lastAppliedRobotSize.widthCm - size.widthCm) < 1e-6;

    // Unity WebGL can ignore SendMessage if the target GameObject isn't ready yet.
    // Re-send a few times after init to make it reliable without a manual "Apply" button.
    if (!alreadyApplied || this.robotSizeAttempt < 6) {
      this.instance.SendMessage('Robot', 'SetRobotSize', `${size.lengthCm},${size.widthCm}`);
      this.lastAppliedRobotSize = size;
    }

    this.robotSizeAttempt += 1;
    if (this.robotSizeAttempt < 6) {
      this.scheduleRobotSizeAttempt(500);
    }
  }

  private async resolveBuildFile(baseUrl: string, file: string): Promise<string> {
    // DP ships only Brotli-compressed build artifacts (e.g. `Build.framework.js.br`),
    // so prefer `.br` without probing via HEAD (which can be blocked by CORS in Chrome).
    return `${baseUrl}/Build/${file}.br`;
  }

  private ensureLoader(baseUrl: string): Promise<void> {
    if (window.createUnityInstance) return Promise.resolve();
    if (this.loaderPromise) return this.loaderPromise;

    const loaderUrl = `${baseUrl}/Build/Build.loader.js`;
    this.loaderPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(`script[data-unity-loader="true"][src="${loaderUrl}"]`);
      if (existing && window.createUnityInstance) {
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = loaderUrl;
      script.async = true;
      script.dataset['unityLoader'] = 'true';
      script.onload = () => resolve();
      script.onerror = () => {
        void fetch(loaderUrl, { method: 'GET' })
          .then(resp => {
            if (!resp.ok) {
              reject(new Error(`Failed to load Unity loader script: ${loaderUrl} (HTTP ${resp.status})`));
              return;
            }
            const contentType = resp.headers.get('content-type') ?? '(none)';
            reject(new Error(`Failed to load Unity loader script: ${loaderUrl} (received ${contentType})`));
          })
          .catch(() => reject(new Error(`Failed to load Unity loader script: ${loaderUrl}`)));
      };
      document.head.appendChild(script);
    });

    return this.loaderPromise;
  }
}
