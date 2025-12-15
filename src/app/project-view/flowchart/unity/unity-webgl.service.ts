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

  isReady(): boolean {
    return this.status() === 'ready' && !!this.instance;
  }

  sendMessage(gameObject: string, methodName: string, parameter?: string): void {
    if (!this.instance) return;
    this.instance.SendMessage(gameObject, methodName, parameter);
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
    this.status.set('idle');
    this.progress.set(0);
    this.error.set(null);
    this.instancePromise = null;
    this.instance = null;
    this.baseUrl = null;
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
